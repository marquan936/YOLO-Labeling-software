/**
 * Canvas Annotation Engine v4
 */
const Canvas = {
    container: null, wrapper: null, imgLayer: null,
    img: null, canvas: null, ctx: null,
    imgNaturalW: 0, imgNaturalH: 0,
    scale: 1.0, _imgOffsetX: 0, _imgOffsetY: 0,
    boxes: [], predBoxes: [],
    selectedIdx: -1, selectedPredIdx: -1, undoStack: [],
    mode: 'idle', activeTool: 'select',
    drawStartX: 0, drawStartY: 0, mouseImgX: 0, mouseImgY: 0,
    dragOffsetX: 0, dragOffsetY: 0, resizeHandle: null, resizeStartBox: null,
    polyPoints: [], polyPreviewPoint: null, polyCloseTolerance: 12,
    matches: [], unmatchedH: [], unmatchedM: [],
    showOriginal: false, opacity: 0.3, listFilter: 'all',
    showLabelDropdown: true, settings: {}, eraserTarget: null,
    _saveTimer: null,

    init() {
        this.container = document.getElementById('canvas-container');
        this.wrapper = document.getElementById('canvas-wrapper');
        this.imgLayer = document.getElementById('img-layer');
        this.img = document.getElementById('main-image');
        this.canvas = document.getElementById('annotation-canvas');
        this.ctx = this.canvas.getContext('2d');
        this._bindEvents();
        this._loadSettings();
        Store.on('change:currentImage.id', (id, oldId) => { if (id) this._switchToImage(id, oldId); });
        Store.on('change:annotations.human', () => { this.render(); this._refreshComparison(); });
        Store.on('change:predictions.current', (p) => { this.predBoxes = p || []; this.render(); });
        Store.on('change:ui.activeTool', (t) => { this.activeTool = t; this._updateCursor(); this._updateStatusHint(); });
        Store.on('change:comparison', () => this.render());
    },

    async _loadSettings() {
        try { this.settings = await api.get('/settings'); } catch { this.settings = {}; }
        this.opacity = (this.settings.annotation || {}).default_opacity ?? 0.3;
        this.showLabelDropdown = (this.settings.annotation || {}).auto_show_label_dropdown ?? true;
        var s = document.getElementById('opacity-slider');
        if (s) { s.value = Math.round(this.opacity * 100); document.getElementById('opacity-val').textContent = s.value + '%'; }
    },

    _bindEvents() {
        this.canvas.addEventListener('mousedown', (e) => this._onDown(e));
        this.canvas.addEventListener('mousemove', (e) => this._onMove(e));
        window.addEventListener('mouseup', (e) => this._onUp(e));
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
        this.canvas.addEventListener('dblclick', (e) => this._onDblClick(e));
        this.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this._eraseAt(this._eventToImg(e)); });
        this.canvas.addEventListener('touchstart', function(e) { if (e.touches.length === 1) { var t = e.touches[0]; Canvas._onDown({ button: 0, clientX: t.clientX, clientY: t.clientY }); } e.preventDefault(); }, { passive: false });
        this.canvas.addEventListener('touchmove', function(e) { if (e.touches.length === 1) { var t = e.touches[0]; Canvas._onMove({ clientX: t.clientX, clientY: t.clientY }); } e.preventDefault(); }, { passive: false });
        this.canvas.addEventListener('touchend', function() { Canvas._onUp({}); });
        var os = document.getElementById('opacity-slider');
        if (os) os.addEventListener('input', function() { Canvas.opacity = parseInt(os.value) / 100; document.getElementById('opacity-val').textContent = os.value + '%'; Canvas.render(); });
        var tgl = document.getElementById('btn-toggle-original');
        if (tgl) tgl.addEventListener('click', function() { Canvas.toggleOriginal(); });
        // Delegate clicks inside the annotation list to handle delete/adopt actions reliably
        var annList = document.getElementById('annotation-list');
        if (annList) {
            annList.addEventListener('click', function(e) {
                var t = e.target;
                if (!t) return;
                // If clicked delete button or inside it
                var del = t.closest && t.closest('.ann-delete');
                if (del) {
                    e.stopPropagation(); e.preventDefault();
                    var idx = parseInt(del.getAttribute('data-idx'));
                    var src = del.getAttribute('data-src');
                    Canvas._onDeleteItem(e, idx, src);
                    return;
                }
                // If clicked adopt button
                var adopt = t.closest && t.closest('.ann-adopt');
                if (adopt) {
                    e.stopPropagation(); e.preventDefault();
                    var adoptIdx = parseInt(adopt.getAttribute('data-idx'));
                    Canvas.adoptPrediction(adoptIdx);
                    return;
                }
                // Otherwise, select the ann-item (click anywhere inside it)
                var item = t.closest && t.closest('.ann-item');
                if (item) {
                    e.stopPropagation(); e.preventDefault();
                    var idx = parseInt(item.getAttribute('data-idx'));
                    var src = item.getAttribute('data-src');
                    // Fallback: if no data-idx, try currently selected
                    if (isNaN(idx)) {
                        if (src === 'human') idx = Canvas.selectedIdx; else if (src === 'model') idx = Canvas.selectedPredIdx;
                    }
                    Canvas.selectBox(idx, src);
                    return;
                }
            });
        }
    },

    /* ---- Eraser ---- */
    _eraseAt(pos) {
        // Erase from human annotations first (higher priority)
        for (var i = this.boxes.length - 1; i >= 0; i--) {
            if (this._ptInBox(pos.x, pos.y, this._yoloToPixelBox(this.boxes[i]))) {
                this._pushUndo();
                this.boxes.splice(i, 1);
                if (this.selectedIdx === i) this.selectedIdx = -1;
                else if (this.selectedIdx > i) this.selectedIdx--;
                Store.set('annotations.human', this.boxes.slice());
                Store.set('annotations.dirty', true);
                // Save immediately to persist the deletion
                var saveId = Store.get('currentImage.id');
                if (saveId) this.saveAnnotations(saveId).catch(function(e) { console.error('Erase save failed:', e); });
                this.render(); this._updateAnnotationList(); this._updateStatusBar();
                App.toast('已擦除人工标注', 'info');
                return;
            }
        }
        // Then erase from model predictions
        for (var j = this.predBoxes.length - 1; j >= 0; j--) {
            if (this._ptInBox(pos.x, pos.y, this._yoloToPixelBox(this.predBoxes[j]))) {
                this._pushUndo();
                this.predBoxes.splice(j, 1);
                Store.set('predictions.current', this.predBoxes.slice());
                // Save updated predictions to disk
                var eraseImgId = Store.get('currentImage.id');
                if (eraseImgId) {
                    api.put('/predictions/' + eraseImgId, { predictions: this.predBoxes }).catch(function() {});
                }
                this.render(); this._updateAnnotationList(); this._updateStatusBar();
                App.toast('已擦除模型预测', 'info');
                return;
            }
        }
    },

    _findEraserTarget(ix, iy) {
        // Check human annotations first (higher priority)
        for (var i = this.boxes.length - 1; i >= 0; i--) {
            if (this._ptInBox(ix, iy, this._yoloToPixelBox(this.boxes[i]))) return {source: 'human', index: i};
        }
        // Then check model predictions
        for (var j = this.predBoxes.length - 1; j >= 0; j--) {
            if (this._ptInBox(ix, iy, this._yoloToPixelBox(this.predBoxes[j]))) return {source: 'model', index: j};
        }
        return null;
    },

    /* ---- Load Image ---- */
    async _switchToImage(imageId, oldId) {
        // Always flush pending saves for the old image before switching
        if (oldId && oldId !== imageId) {
            await this._flushSave(oldId);
        }
        await this.loadImage(imageId);
    },

    async loadImage(imageId) {
        Store.set('currentImage.loading', true);
        try {
            var meta = await api.get('/images/' + imageId);
            Store.set('currentImage.metadata', meta);
            this.imgNaturalW = meta.width; this.imgNaturalH = meta.height;
            this.img.src = imageUrl(imageId); this.img.style.display = '';
            document.getElementById('canvas-placeholder').style.display = 'none';
            await new Promise(function(res, rej) { Canvas.img.onload = res; Canvas.img.onerror = rej; });
            this._fitAndPosition(); this.showOriginal = false; this.render();

            var annData = await api.get('/annotations/' + imageId);
            this.boxes = annData.annotations || [];
            this.undoStack = [];
            Store.set('annotations.human', this.boxes.slice(), { silent: true });
            Store.set('annotations.dirty', false, { silent: true });

            try {
                var pd = await api.get('/predictions/' + imageId);
                this.predBoxes = pd.predictions || [];
                Store.set('predictions.current', this.predBoxes.slice(), { silent: true });
            } catch (e) { this.predBoxes = []; }

            if (Store.get('comparison.enabled')) {
                try {
                    var c = await api.get('/comparison/' + imageId);
                    this.matches = c.matches || [];
                    this.unmatchedH = c.unmatched_human || [];
                    this.unmatchedM = c.unmatched_model || [];
                } catch (e) { this.matches = []; }
            }
            this.render(); this._updateAnnotationList(); this._updateStatusBar();
        } catch (e) { App.toast('加载图片失败: ' + e.message, 'error'); }
        Store.set('currentImage.loading', false);
    },

    _fitAndPosition() {
        var cw = this.container.clientWidth, ch = this.container.clientHeight;
        this.scale = Math.min(cw / this.imgNaturalW, ch / this.imgNaturalH, 1.0) * 0.88;
        Store.set('ui.zoom', this.scale, { silent: true });
        var dw = this.imgNaturalW * this.scale, dh = this.imgNaturalH * this.scale;
        this.img.style.width = dw + 'px'; this.img.style.height = dh + 'px';
        this.canvas.width = cw; this.canvas.height = ch;
        this.canvas.style.width = cw + 'px'; this.canvas.style.height = ch + 'px';
        this._imgOffsetX = (cw - dw) / 2; this._imgOffsetY = (ch - dh) / 2;
        this.imgLayer.style.left = this._imgOffsetX + 'px';
        this.imgLayer.style.top = this._imgOffsetY + 'px';
        this.imgLayer.style.width = dw + 'px'; this.imgLayer.style.height = dh + 'px';
        document.getElementById('zoom-level').textContent = Math.round(this.scale * 100) + '%';
    },

    _eventToImg(e) {
        var r = this.canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left - this._imgOffsetX) / this.scale, y: (e.clientY - r.top - this._imgOffsetY) / this.scale };
    },
    _imgToCanvas(ix, iy) { return { x: ix * this.scale + this._imgOffsetX, y: iy * this.scale + this._imgOffsetY }; },

    _yoloToPixelBox(ann) {
        if (!ann) return { x1: 0, y1: 0, x2: 0, y2: 0 };
        if (ann.type === 'polygon') {
            var pts = (ann.points || []).map(function(p) { return { x: p.x * Canvas.imgNaturalW, y: p.y * Canvas.imgNaturalH }; });
            var xs = pts.map(function(p) { return p.x; }), ys = pts.map(function(p) { return p.y; });
            return { type: 'polygon', points: pts, x1: Math.min.apply(null, xs), y1: Math.min.apply(null, ys), x2: Math.max.apply(null, xs), y2: Math.max.apply(null, ys) };
        }
        var xc = ann.x_center * this.imgNaturalW, yc = ann.y_center * this.imgNaturalH;
        var w = ann.width * this.imgNaturalW, h = ann.height * this.imgNaturalH;
        return { type: 'bbox', x1: xc - w / 2, y1: yc - h / 2, x2: xc + w / 2, y2: yc + h / 2 };
    },

    /* ---- Mouse ---- */
    _onDown(e) {
        if (e.button === 1 || (e.button === 0 && this.activeTool === 'pan')) {
            this.mode = 'panning'; this._panStartX = e.clientX; this._panStartY = e.clientY;
            this._panStartOX = this._imgOffsetX; this._panStartOY = this._imgOffsetY; return;
        }
        if (e.button === 2) return; if (e.button !== 0) return;
        var pos = this._eventToImg(e);
        this.mouseImgX = pos.x; this.mouseImgY = pos.y;
        this._hideLabelDropdown();

        if (this.activeTool === 'eraser') { this._eraseAt(pos); return; }
        if (this.activeTool === 'draw') { this.mode = 'drawing_rect'; this.drawStartX = pos.x; this.drawStartY = pos.y; return; }
        if (this.activeTool === 'polygon') {
            if (this.mode !== 'drawing_polygon') {
                this.mode = 'drawing_polygon'; this.polyPoints = [{ x: pos.x, y: pos.y }]; this.polyPreviewPoint = { x: pos.x, y: pos.y };
            } else {
                if (this.polyPoints.length >= 3) {
                    var first = this.polyPoints[0];
                    if (Math.hypot(pos.x - first.x, pos.y - first.y) * this.scale < 12) { this._finishPolygon(); return; }
                }
                this.polyPoints.push({ x: pos.x, y: pos.y });
            }
            this.render(); return;
        }
        if (this.activeTool === 'select') {
            if (this.selectedIdx >= 0) { var h = this._hitTestHandles(pos.x, pos.y); if (h) { this.mode = 'resizing'; this.resizeHandle = h; this.resizeStartBox = JSON.parse(JSON.stringify(this.boxes[this.selectedIdx])); return; } }
            var hit = -1;
            for (var i = this.boxes.length - 1; i >= 0; i--) { if (this._ptInBox(pos.x, pos.y, this._yoloToPixelBox(this.boxes[i]))) { hit = i; break; } }
            if (hit >= 0) {
                this.selectedIdx = hit; this.selectedPredIdx = -1;
                this.mode = 'dragging'; var px = this._yoloToPixelBox(this.boxes[hit]); this.dragOffsetX = pos.x - px.x1; this.dragOffsetY = pos.y - px.y1;
            } else {
                var predHit = -1;
                for (var pj = this.predBoxes.length - 1; pj >= 0; pj--) { if (this._ptInBox(pos.x, pos.y, this._yoloToPixelBox(this.predBoxes[pj]))) { predHit = pj; break; } }
                if (predHit >= 0) {
                    this.selectedPredIdx = predHit; this.selectedIdx = -1; this.mode = 'idle';
                } else {
                    this.selectedIdx = -1; this.selectedPredIdx = -1; this.mode = 'idle';
                }
            }
            this.render(); this._updateAnnotationList();
        }
    },

    _onMove(e) {
        var pos = this._eventToImg(e); this.mouseImgX = pos.x; this.mouseImgY = pos.y;
        this._updateStatusCoords(pos.x, pos.y);
        if (this.mode === 'panning') { this._imgOffsetX = this._panStartOX + (e.clientX - this._panStartX); this._imgOffsetY = this._panStartOY + (e.clientY - this._panStartY); this.imgLayer.style.left = this._imgOffsetX + 'px'; this.imgLayer.style.top = this._imgOffsetY + 'px'; this.render(); return; }
        if (this.activeTool === 'eraser' && this.mode === 'idle') { this.eraserTarget = this._findEraserTarget(pos.x, pos.y); this.render(); return; }
        if (this.mode === 'drawing_rect') { this.render(); this._drawRubberBand(this.drawStartX, this.drawStartY, pos.x, pos.y); return; }
        if (this.mode === 'drawing_polygon') {
            this.polyPreviewPoint = { x: pos.x, y: pos.y };
            if (this.polyPoints.length >= 3) { var first = this.polyPoints[0]; if (Math.hypot(pos.x - first.x, pos.y - first.y) * this.scale < 12) this.polyPreviewPoint = { x: first.x, y: first.y, _close: true }; }
            this.render(); return;
        }
        if (this.mode === 'dragging' && this.selectedIdx >= 0) {
            var ann = this.boxes[this.selectedIdx]; var dx = pos.x - this.dragOffsetX, dy = pos.y - this.dragOffsetY;
            if (ann.type === 'polygon') { var opx = this._yoloToPixelBox(ann); var sx = dx - opx.x1, sy = dy - opx.y1; ann.points = ann.points.map(function(p) { return { x: clamp(p.x + sx / Canvas.imgNaturalW, 0, 1), y: clamp(p.y + sy / Canvas.imgNaturalH, 0, 1) }; }); }
            else { var w = ann.width * this.imgNaturalW, h = ann.height * this.imgNaturalH; ann.x_center = clamp((dx + w / 2) / this.imgNaturalW, 0, 1); ann.y_center = clamp((dy + h / 2) / this.imgNaturalH, 0, 1); }
            this.render(); return;
        }
        if (this.mode === 'resizing' && this.selectedIdx >= 0) { this._applyResize(pos.x, pos.y); this.render(); }
    },

    _onUp(e) {
        if (this.mode === 'drawing_rect') {
            var pos = this._eventToImg(e); var x1 = this.drawStartX, y1 = this.drawStartY, x2 = pos.x, y2 = pos.y;
            if (Math.abs(x2 - x1) >= 3 && Math.abs(y2 - y1) >= 3) {
                this._pushUndo();
                var ann = this._createBbox(x1, y1, x2, y2); this.boxes.push(ann);
                Store.set('annotations.human', this.boxes.slice()); this._markDirty();
                this.selectedIdx = this.boxes.length - 1;
                if (this.showLabelDropdown) this._showLabelDropdown(x1, y1, x2, y2);
            }
        }
        if (this.mode === 'dragging' || this.mode === 'resizing') { Store.set('annotations.human', this.boxes.slice()); this._markDirty(); }
        if (this.mode !== 'drawing_polygon') this.mode = 'idle';
        this.render(); this._updateAnnotationList(); this._updateStatusBar();
    },

    _onDblClick(e) { if (this.activeTool === 'polygon' && this.mode === 'drawing_polygon') this._finishPolygon(); },
    _onWheel(e) {
        e.preventDefault(); var r = this.canvas.getBoundingClientRect(); var mx = e.clientX - r.left, my = e.clientY - r.top;
        var zf = e.deltaY < 0 ? 1.12 : 0.9; var ns = clamp(this.scale * zf, 0.1, 6.0);
        var wx = (mx - this._imgOffsetX) / this.scale, wy = (my - this._imgOffsetY) / this.scale;
        this._imgOffsetX = mx - wx * ns; this._imgOffsetY = my - wy * ns; this.scale = ns;
        Store.set('ui.zoom', this.scale, { silent: true });
        this.imgLayer.style.left = this._imgOffsetX + 'px'; this.imgLayer.style.top = this._imgOffsetY + 'px';
        var dw = this.imgNaturalW * this.scale, dh = this.imgNaturalH * this.scale;
        this.img.style.width = dw + 'px'; this.img.style.height = dh + 'px';
        this.imgLayer.style.width = dw + 'px'; this.imgLayer.style.height = dh + 'px';
        document.getElementById('zoom-level').textContent = Math.round(this.scale * 100) + '%'; this.render();
    },

    _finishPolygon() {
        if (this.polyPoints.length < 3) { App.toast('多边形至少需要 3 个顶点', 'warning'); this.mode = 'idle'; this.polyPoints = []; this.render(); return; }
        this._pushUndo();
        var normPts = this.polyPoints.map(function(p) { return { x: clamp(p.x / Canvas.imgNaturalW, 0, 1), y: clamp(p.y / Canvas.imgNaturalH, 0, 1) }; });
        var ann = { type: 'polygon', class_id: Store.get('classes.activeIdx'), points: normPts };
        this.boxes.push(ann); Store.set('annotations.human', this.boxes.slice()); this._markDirty();
        this.selectedIdx = this.boxes.length - 1; this.mode = 'idle'; this.polyPoints = []; this.polyPreviewPoint = null;
        if (this.showLabelDropdown) { var px = this._yoloToPixelBox(ann); this._showLabelDropdown(px.x1, px.y1, px.x2, px.y2); }
        this.render(); this._updateAnnotationList(); this._updateStatusBar();
    },

    _createBbox(x1, y1, x2, y2) {
        var xx1 = Math.min(x1, x2), xx2 = Math.max(x1, x2), yy1 = Math.min(y1, y2), yy2 = Math.max(y1, y2);
        var w = xx2 - xx1, h = yy2 - yy1;
        return { type: 'bbox', class_id: Store.get('classes.activeIdx'), x_center: clamp((xx1 + w / 2) / this.imgNaturalW, 0, 1), y_center: clamp((yy1 + h / 2) / this.imgNaturalH, 0, 1), width: clamp(w / this.imgNaturalW, 0, 1), height: clamp(h / this.imgNaturalH, 0, 1) };
    },

    _ptInBox(ix, iy, px) { return ix >= px.x1 && ix <= px.x2 && iy >= px.y1 && iy <= px.y2; },

    _hitTestHandles(ix, iy) {
        if (this.selectedIdx < 0 || !this.boxes[this.selectedIdx]) return null;
        var px = this._yoloToPixelBox(this.boxes[this.selectedIdx]);
        // Handle size in screen pixels, converted to image pixels
        var tol = 8 / this.scale;
        var handles = {
            'nw': [px.x1, px.y1], 'n': [(px.x1+px.x2)/2, px.y1], 'ne': [px.x2, px.y1],
            'e':  [px.x2, (px.y1+px.y2)/2], 'se': [px.x2, px.y2],
            's':  [(px.x1+px.x2)/2, px.y2], 'sw': [px.x1, px.y2],
            'w':  [px.x1, (px.y1+px.y2)/2]
        };
        for (var k in handles) {
            if (Math.abs(ix - handles[k][0]) < tol && Math.abs(iy - handles[k][1]) < tol) return k;
        }
        return null;
    },

    _applyResize(ix, iy) {
        if (this.selectedIdx < 0 || !this.resizeHandle) return;
        var start = JSON.parse(JSON.stringify(this.resizeStartBox));
        var ann = this.boxes[this.selectedIdx];
        // Convert normalized to pixel coordinates
        var x1 = start.x_center * this.imgNaturalW - start.width * this.imgNaturalW / 2;
        var y1 = start.y_center * this.imgNaturalH - start.height * this.imgNaturalH / 2;
        var x2 = start.x_center * this.imgNaturalW + start.width * this.imgNaturalW / 2;
        var y2 = start.y_center * this.imgNaturalH + start.height * this.imgNaturalH / 2;
        // Apply resize based on handle
        var h = this.resizeHandle;
        if (h.indexOf('n') >= 0) y1 = iy;
        if (h.indexOf('s') >= 0) y2 = iy;
        if (h.indexOf('w') >= 0) x1 = ix;
        if (h.indexOf('e') >= 0) x2 = ix;
        // Clamp and enforce min size
        var minSz = 3;
        if (x2 - x1 < minSz) { if (h.indexOf('w') >= 0) x1 = x2 - minSz; else x2 = x1 + minSz; }
        if (y2 - y1 < minSz) { if (h.indexOf('n') >= 0) y1 = y2 - minSz; else y2 = y1 + minSz; }
        x1 = clamp(x1, 0, this.imgNaturalW); x2 = clamp(x2, 0, this.imgNaturalW);
        y1 = clamp(y1, 0, this.imgNaturalH); y2 = clamp(y2, 0, this.imgNaturalH);
        var w = x2 - x1, h2 = y2 - y1;
        ann.x_center = clamp((x1 + w/2) / this.imgNaturalW, 0, 1);
        ann.y_center = clamp((y1 + h2/2) / this.imgNaturalH, 0, 1);
        ann.width = clamp(w / this.imgNaturalW, 0, 1);
        ann.height = clamp(h2 / this.imgNaturalH, 0, 1);
    },

    /* ---- Render ---- */
    render() {
        var ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height; ctx.clearRect(0, 0, cw, ch);
        if (!this.imgNaturalW) return;
        var comp = Store.get('comparison.enabled'), showHuman = !comp || Store.get('comparison.showHuman'), showModel = !comp || Store.get('comparison.showModel'), alpha = this.opacity;
        if (showHuman && !this.showOriginal) {
            for (var i = 0; i < this.boxes.length; i++) {
                var isSel = (i === this.selectedIdx), isMatch = this.matches.some(function(m) { return m.human_idx === i; });
                var isEraserTarget = (this.activeTool === 'eraser' && this.eraserTarget && this.eraserTarget.source === 'human' && this.eraserTarget.index === i);
                this._drawAnnotation(this.boxes[i], 'solid', isSel, isMatch ? '#ffeb3b' : (isEraserTarget ? '#ff4444' : null), alpha);
            }
        }
        if (showModel && !this.showOriginal) {
            for (var j = 0; j < this.predBoxes.length; j++) {
                var isPredSel = (j === this.selectedPredIdx);
                this._drawAnnotation(this.predBoxes[j], 'dashed', isPredSel, null, alpha * 0.8);
            }
        }
        // Selected highlights + eraser + polygon preview
        if (this.selectedIdx >= 0 && this.activeTool === 'select') {
            this._drawSelectionOutline(this.boxes[this.selectedIdx], true);
        }
        if (this.selectedPredIdx >= 0 && this.activeTool === 'select') {
            this._drawSelectionOutline(this.predBoxes[this.selectedPredIdx], false);
        }
        if (this.activeTool === 'eraser' && this.eraserTarget) {
            var et = this.eraserTarget;
            var targetBoxes = et.source === 'human' ? this.boxes : this.predBoxes;
            if (targetBoxes[et.index]) {
                var epx = this._yoloToPixelBox(targetBoxes[et.index]), ec = this._imgToCanvas(epx.x1, epx.y1), ew = (epx.x2 - epx.x1) * this.scale, eh = (epx.y2 - epx.y1) * this.scale;
                ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 3; ctx.setLineDash([3, 2]); ctx.strokeRect(ec.x - 2, ec.y - 2, ew + 4, eh + 4); ctx.setLineDash([]);
                ctx.beginPath(); ctx.moveTo(ec.x, ec.y); ctx.lineTo(ec.x + ew, ec.y + eh); ctx.moveTo(ec.x + ew, ec.y); ctx.lineTo(ec.x, ec.y + eh); ctx.stroke();
            }
        }
        if (this.mode === 'drawing_polygon' && this.polyPoints.length > 0) {
            ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]); ctx.beginPath();
            var pf = this._imgToCanvas(this.polyPoints[0].x, this.polyPoints[0].y); ctx.moveTo(pf.x, pf.y);
            for (var pi = 1; pi < this.polyPoints.length; pi++) { var ppt = this._imgToCanvas(this.polyPoints[pi].x, this.polyPoints[pi].y); ctx.lineTo(ppt.x, ppt.y); }
            if (this.polyPreviewPoint) { var ppp = this._imgToCanvas(this.polyPreviewPoint.x, this.polyPreviewPoint.y); ctx.lineTo(ppp.x, ppp.y); if (this.polyPreviewPoint._close) { ctx.strokeStyle = '#66bb6a'; ctx.lineWidth = 2.5; } }
            ctx.stroke(); ctx.setLineDash([]);
            for (var pj = 0; pj < this.polyPoints.length; pj++) {
                // Do not draw a special shape for the first vertex; draw small squares for other vertices
                if (pj === 0) continue;
                var pcp = this._imgToCanvas(this.polyPoints[pj].x, this.polyPoints[pj].y);
                ctx.fillStyle = '#4fc3f7';
                ctx.fillRect(pcp.x - 2, pcp.y - 2, 4, 4);
            }
        }
    },

    _drawSelectionOutline(ann, showHandles) {
        if (!ann) return;
        var ctx = this.ctx, px = this._yoloToPixelBox(ann);
        var c = this._imgToCanvas(px.x1, px.y1), w = (px.x2 - px.x1) * this.scale, h = (px.y2 - px.y1) * this.scale;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
        if (ann.type === 'polygon' && px.points && px.points.length >= 3) {
            ctx.beginPath();
            var sp = this._imgToCanvas(px.points[0].x, px.points[0].y);
            ctx.moveTo(sp.x, sp.y);
            for (var pi = 1; pi < px.points.length; pi++) {
                var pt = this._imgToCanvas(px.points[pi].x, px.points[pi].y);
                ctx.lineTo(pt.x, pt.y);
            }
            ctx.closePath(); ctx.stroke();
        } else {
            ctx.strokeRect(c.x, c.y, w, h);
        }
        ctx.setLineDash([]);
        if (showHandles && ann.type === 'bbox') {
            ctx.fillStyle = '#fff';
            var hs = 8, handles = [[c.x,c.y],[c.x+w/2,c.y],[c.x+w,c.y],[c.x+w,c.y+h/2],[c.x+w,c.y+h],[c.x+w/2,c.y+h],[c.x,c.y+h],[c.x,c.y+h/2]];
            for (var k = 0; k < handles.length; k++) ctx.fillRect(handles[k][0]-hs/2, handles[k][1]-hs/2, hs, hs);
        }
    },

    _drawAnnotation(ann, style, selected, overrideColor, alpha) {
        var ctx = this.ctx, px = this._yoloToPixelBox(ann);
        var classes = Store.get('classes.items'), cls = classes.find(function(c) { return c.idx === ann.class_id; }) || classes[ann.class_id];
        var color = overrideColor || (cls ? cls.color : '#ff0000'), borderAlpha = selected ? 1 : 0.85;
        if (ann.type === 'polygon' && px.points && px.points.length >= 3) {
            ctx.fillStyle = hexToRgba(color, alpha); ctx.beginPath();
            var pf = this._imgToCanvas(px.points[0].x, px.points[0].y); ctx.moveTo(pf.x, pf.y);
            for (var i = 1; i < px.points.length; i++) { var pt = this._imgToCanvas(px.points[i].x, px.points[i].y); ctx.lineTo(pt.x, pt.y); }
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = selected ? '#fff' : hexToRgba(color, borderAlpha); ctx.lineWidth = selected ? 2.5 : 2;
            if (style === 'dashed') ctx.setLineDash([5, 3]); else ctx.setLineDash([]); ctx.stroke(); ctx.setLineDash([]);
        } else {
            var c = this._imgToCanvas(px.x1, px.y1), w = (px.x2 - px.x1) * this.scale, h = (px.y2 - px.y1) * this.scale;
            ctx.fillStyle = hexToRgba(color, alpha); ctx.fillRect(c.x, c.y, w, h);
            ctx.strokeStyle = selected ? '#fff' : hexToRgba(color, borderAlpha); ctx.lineWidth = selected ? 2.5 : 2;
            if (style === 'dashed') ctx.setLineDash([5, 3]); else ctx.setLineDash([]); ctx.strokeRect(c.x, c.y, w, h); ctx.setLineDash([]);
        }
        var lbl = (cls ? cls.name : '#' + ann.class_id) + (ann.confidence != null ? ' ' + (ann.confidence * 100).toFixed(0) + '%' : '') + (ann.type === 'polygon' ? ' ◇' : '');
        var fs = Math.max(10, Math.min(16, this.scale * 13)); ctx.font = '600 ' + fs + 'px "Segoe UI", system-ui, sans-serif';
        var tm = ctx.measureText(lbl), lh = fs + 6, lw = tm.width + 8, pc = this._imgToCanvas(px.x1, px.y1), ly = pc.y - lh;
        if (ly < 2) ly = pc.y; ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(pc.x, ly, lw, lh); ctx.fillStyle = '#fff'; ctx.fillText(lbl, pc.x + 4, ly + fs - 1);
    },

    _drawRubberBand(x1, y1, x2, y2) { var ctx = this.ctx, c1 = this._imgToCanvas(x1, y1), c2 = this._imgToCanvas(x2, y2), x = Math.min(c1.x, c2.x), y = Math.min(c1.y, c2.y), w = Math.abs(c2.x - c1.x), h = Math.abs(c2.y - c1.y); ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); ctx.fillStyle = 'rgba(79,195,247,0.08)'; ctx.fillRect(x, y, w, h); },

    /* ---- Label Dropdown ---- */
    _showLabelDropdown(x1, y1, x2, y2) {
        var dd = document.getElementById('label-dropdown'), list = document.getElementById('label-dropdown-list'); if (!dd || !list) return;
        var classes = Store.get('classes.items');
        list.innerHTML = classes.map(function(c, i) { return '<div class="label-dropdown-item" onclick="Canvas._pickLabel(' + c.idx + ')"><span class="color-dot" style="background:' + c.color + '"></span><span>' + escapeHtml(c.name) + '</span><span class="shortcut">' + (i < 9 ? i : '') + '</span></div>'; }).join('');
        var pt = this._imgToCanvas((x1 + x2) / 2, y2), cw = this.canvas.width, ch = this.canvas.height, lx = pt.x, ly = pt.y + 5;
        if (lx + 170 > cw) lx = cw - 170; if (ly + 280 > ch) ly = pt.y - 280;
        dd.style.left = lx + 'px'; dd.style.top = ly + 'px'; dd.style.display = 'block';
    },
    _pickLabel(classIdx) { if (this.selectedIdx >= 0 && this.selectedIdx < this.boxes.length) { this.boxes[this.selectedIdx].class_id = classIdx; Store.set('annotations.human', this.boxes.slice()); this._markDirty(); this.render(); this._updateAnnotationList(); } this._hideLabelDropdown(); },
    _hideLabelDropdown() { var dd = document.getElementById('label-dropdown'); if (dd) dd.style.display = 'none'; },

    /* ---- Annotation List ---- */
    _updateAnnotationList() {
        var container = document.getElementById('annotation-list'), all = [];
        if (this.listFilter !== 'model') { for (var i = 0; i < this.boxes.length; i++) { var b = Object.assign({}, this.boxes[i]); b._idx = i; b._source = 'human'; all.push(b); } }
        if (this.listFilter !== 'human') { var showM = Store.get('comparison.showModel'); if (showM !== false) { for (var j = 0; j < this.predBoxes.length; j++) { var pb = Object.assign({}, this.predBoxes[j]); pb._idx = j; pb._source = 'model'; all.push(pb); } } }
        document.getElementById('ann-count-badge').textContent = all.length;
        if (all.length === 0) { container.innerHTML = '<div class="placeholder">暂无标注</div>'; return; }
        var classes = Store.get('classes.items'), self = this;
        container.innerHTML = all.map(function(b) {
            var cls = classes.find(function(c) { return c.idx === b.class_id; }) || {}, color = cls.color || '#888', name = cls.name || 'class_' + b.class_id;
            var sel = (b._source === 'human' && b._idx === self.selectedIdx) || (b._source === 'model' && b._idx === self.selectedPredIdx) ? ' selected' : '';
            var typeIcon = b.type === 'polygon' ? '◇' : '▭';
            var dimsText = b.type === 'polygon' ? ((b.points || []).length + '顶点') : ((b.width * 100).toFixed(0) + '×' + (b.height * 100).toFixed(0) + '%');
            var confHtml = b.confidence != null ? '<span class="ann-conf">' + (b.confidence * 100).toFixed(1) + '%</span>' : '';
            var srcHtml = b._source === 'model' ? '<span class="ann-source model">M</span>' : '<span class="ann-source human">H</span>';
            var adoptBtn = '';
            if (b._source === 'model') {
                adoptBtn = '<span class="ann-adopt" data-idx="' + b._idx + '" title="采纳为人工标签">✅</span>';
            }
            return '<div class="ann-item' + sel + '" data-idx="' + b._idx + '" data-src="' + b._source + '"><span class="color-dot" style="background:' + color + '"></span><span class="ann-type">' + typeIcon + '</span><span class="ann-info"><span class="ann-class">' + escapeHtml(name) + '</span><span class="ann-dims">' + dimsText + '</span>' + confHtml + '</span>' + srcHtml + adoptBtn + '<span class="ann-delete" data-idx="' + b._idx + '" data-src="' + b._source + '">×</span></div>';
        }).join('');
    },

    selectBox(idx, source) {
        if (source === 'human') {
            this.selectedIdx = idx;
            this.selectedPredIdx = -1;
            this.render(); this._updateAnnotationList();
            // Scroll selected list item into view
            setTimeout(function() {
                var el = document.querySelector('#annotation-list .ann-item.selected');
                if (el) el.scrollIntoView({ block: 'nearest' });
            }, 0);
        } else if (source === 'model') {
            this.selectedPredIdx = idx;
            this.selectedIdx = -1;
            this.render(); this._updateAnnotationList();
            setTimeout(function() {
                var el = document.querySelector('#annotation-list .ann-item.selected');
                if (el) el.scrollIntoView({ block: 'nearest' });
            }, 0);
        }
    },
    _onDeleteItem(event, idx, source) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        var i = parseInt(idx);
        if (isNaN(i)) {
            // Fallback: delete currently selected box for the given source
            if (source === 'human') i = this.selectedIdx;
            else if (source === 'model') i = this.selectedPredIdx;
        }
        if (i == null || i === -1 || isNaN(i)) return;
        this.deleteBox(i, source);
    },
    deleteBox(idx, source) {
        var imgId = Store.get('currentImage.id');
        if (source === 'human') {
            this._pushUndo();
            this.boxes.splice(idx, 1);
            if (this.selectedIdx === idx) this.selectedIdx = -1;
            else if (this.selectedIdx > idx) this.selectedIdx--;
            Store.set('annotations.human', this.boxes.slice());
            Store.set('annotations.dirty', true);
            // Save immediately to persist the deletion and update server-side review_status
            if (imgId) this.saveAnnotations(imgId).catch(function(e) { console.error('Delete human save failed:', e); });
        } else if (source === 'model') {
            this._pushUndo();
            this.predBoxes.splice(idx, 1);
            Store.set('predictions.current', this.predBoxes.slice());
            // Save updated predictions to disk so deletion persists
            if (imgId) {
                api.put('/predictions/' + imgId, { predictions: this.predBoxes }).catch(function(e) {
                    console.error('Delete model save failed:', e);
                });
            }
        }
        this.render(); this._updateAnnotationList(); this._updateStatusBar();
    },
    setListFilter(f) { this.listFilter = f; var btns = document.querySelectorAll('.panel-filter .btn'); for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active'); var btn = document.querySelector('.panel-filter .btn[data-filter="' + f + '"]'); if (btn) btn.classList.add('active'); this._updateAnnotationList(); },

    /* ---- Adopt Predictions ---- */

    // Compute IoU between two annotations (both in normalized YOLO coordinates)
    _computeIoU(annA, annB) {
        function toPixelBox(ann) {
            if (ann.type === 'polygon' && ann.points && ann.points.length >= 3) {
                var xs = ann.points.map(function(p) { return p.x * Canvas.imgNaturalW; });
                var ys = ann.points.map(function(p) { return p.y * Canvas.imgNaturalH; });
                return { x1: Math.min.apply(null, xs), y1: Math.min.apply(null, ys), x2: Math.max.apply(null, xs), y2: Math.max.apply(null, ys) };
            }
            var xc = (ann.x_center || 0) * Canvas.imgNaturalW;
            var yc = (ann.y_center || 0) * Canvas.imgNaturalH;
            var w = (ann.width || 0) * Canvas.imgNaturalW;
            var h = (ann.height || 0) * Canvas.imgNaturalH;
            return { x1: xc - w / 2, y1: yc - h / 2, x2: xc + w / 2, y2: yc + h / 2 };
        }
        var a = toPixelBox(annA), b = toPixelBox(annB);
        var xa = Math.max(a.x1, b.x1), ya = Math.max(a.y1, b.y1);
        var xb = Math.min(a.x2, b.x2), yb = Math.min(a.y2, b.y2);
        var inter = Math.max(0, xb - xa) * Math.max(0, yb - ya);
        var areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
        var areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
        var union = areaA + areaB - inter;
        return union > 0 ? inter / union : 0;
    },

    // Adopt a single model prediction (by index) into human annotations
    adoptPrediction(index) {
        if (index < 0 || index >= this.predBoxes.length) return;
        this._pushUndo();
        var p = this.predBoxes[index];
        var b = JSON.parse(JSON.stringify(p));
        delete b.confidence;
        b.type = b.type || 'bbox';
        // Remove overlapping human annotations, keep this model prediction
        var self = this;
        this.boxes = this.boxes.filter(function(ex) {
            return self._computeIoU(b, ex) <= 0.5;
        });
        this.boxes.push(b);
        // Remove this prediction from model list
        this.predBoxes.splice(index, 1);
        Store.set('predictions.current', this.predBoxes.slice());
        Store.set('annotations.human', this.boxes.slice());
        Store.set('annotations.dirty', true);
        // Save immediately to persist the adoption
        var adoptId = Store.get('currentImage.id');
        if (adoptId) {
            this.saveAnnotations(adoptId).catch(function(e) { console.error('Adopt save failed:', e); });
            // Also save updated predictions (removed the adopted one)
            api.put('/predictions/' + adoptId, { predictions: this.predBoxes }).catch(function() {});
        }
        this.render(); this._updateAnnotationList(); this._updateStatusBar();
        App.toast('已采纳为人工标签', 'success');
    },

    // Adopt ALL model predictions as human labels, clear model predictions after
    adoptAll() {
        if (this.predBoxes.length === 0) { App.toast('当前图片没有预测结果', 'warning'); return; }
        this._pushUndo();
        var self = this;
        var adopted = 0;
        // Remove human annotations that overlap with model predictions
        var humanToKeep = [];
        this.boxes.forEach(function(humanBox) {
            var overlapsModel = self.predBoxes.some(function(modelBox) {
                return self._computeIoU(humanBox, modelBox) > 0.5;
            });
            if (!overlapsModel) {
                humanToKeep.push(humanBox);
            }
        });
        // Convert all model predictions to human labels
        this.predBoxes.forEach(function(p) {
            var b = JSON.parse(JSON.stringify(p));
            delete b.confidence;
            b.type = b.type || 'bbox';
            humanToKeep.push(b);
            adopted++;
        });
        this.boxes = humanToKeep;
        // Clear model predictions
        this.predBoxes = [];
        Store.set('predictions.current', []);
        Store.set('annotations.human', this.boxes.slice());
        Store.set('annotations.dirty', true);
        // Save immediately to persist the adoption
        var adoptAllId = Store.get('currentImage.id');
        if (adoptAllId) {
            this.saveAnnotations(adoptAllId).catch(function(e) { console.error('AdoptAll save failed:', e); });
            // Also clear predictions on disk since all were adopted
            api.put('/predictions/' + adoptAllId, { predictions: [] }).catch(function() {});
        }
        this.render(); this._updateAnnotationList(); this._updateStatusBar();
        App.toast('已采纳全部 ' + adopted + ' 个预测标签为人工标签', 'success');
    },

    // Legacy alias
    adoptAllNonOverlapping() {
        this.adoptAll();
    },

    adoptPredictions(how) {
        if (this.predBoxes.length === 0) { App.toast('当前图片没有预测结果', 'warning'); return; }
        if (how === 'replace') {
            this._pushUndo();
            this.boxes = this.predBoxes.map(function(p) { var b = JSON.parse(JSON.stringify(p)); delete b.confidence; b.type = b.type || 'bbox'; return b; });
            // Clear model predictions after replace
            this.predBoxes = [];
            Store.set('predictions.current', []);
        } else if (how === 'append') {
            // Adopt all model predictions (with overlap resolution)
            this.adoptAll();
            return;  // adoptAll already handles state update, toast, and clears predBoxes
        }
        Store.set('annotations.human', this.boxes.slice()); Store.set('annotations.dirty', true);
        // Save immediately to persist the replace
        var replaceId = Store.get('currentImage.id');
        if (replaceId) {
            this.saveAnnotations(replaceId).catch(function(e) { console.error('Replace save failed:', e); });
            // Also clear predictions on disk since they were all converted to human labels
            api.put('/predictions/' + replaceId, { predictions: [] }).catch(function() {});
        }
        this.render(); this._updateAnnotationList(); this._updateStatusBar();
        App.toast('已替换为预测标签 (' + this.boxes.length + ' 个)', 'success');
    },

    /* ---- Image Ops ---- */
    async deleteCurrentImage() {
        var imgId = Store.get('currentImage.id'), meta = Store.get('currentImage.metadata');
        if (!imgId) { App.toast('请先选择图片', 'warning'); return; }
        var self = this;
        App.confirm('确认删除图片 "' + (meta ? meta.filename : '') + '" 及其所有标注？<br><small>此操作不可撤销</small>', async function() {
            try { await api.del('/images/' + imgId); App.toast('已删除', 'success'); Store.set('currentImage.id', null); self.boxes = []; self.predBoxes = []; self.render(); self._updateAnnotationList(); ImageNavigator._removeItem(imgId); App.refreshStats(); } catch (e) { App.toast('删除失败: ' + e.message, 'error'); }
        });
    },
    async moveCurrentImage(targetSplit) {
        var imgId = Store.get('currentImage.id'), meta = Store.get('currentImage.metadata');
        if (!imgId) { App.toast('请先选择图片', 'warning'); return; }
        try { var res = await api.put('/images/' + imgId + '/move?target_split=' + targetSplit); App.toast('已移动到 ' + targetSplit, 'success'); Store.set('currentImage.metadata', Object.assign({}, meta, { split: targetSplit })); ImageNavigator._loadPage(1, true); App.refreshStats(); Canvas._updateStatusBar(); } catch (e) { App.toast('移动失败: ' + e.message, 'error'); }
    },

    /* ---- Save / Clear / Undo ---- */
    async saveAnnotations(imageId) {
        var imgId = imageId || Store.get('currentImage.id');
        if (!imgId) return;
        Store.set('annotations.saving', true);
        try {
            var res = await api.put('/annotations/' + imgId, { annotations: this.boxes });
            Store.set('annotations.dirty', false);
            App.toast('已保存 ' + res.saved + ' 个标注', 'success');
            App.refreshStats();
        } catch (e) {
            App.toast('保存失败: ' + formatApiError(e), 'error');
        }
        Store.set('annotations.saving', false);
    },
    clearAnnotations() { if (this.boxes.length === 0) return; var self = this; App.confirm('确认清空当前所有标注？此操作可撤销。', function() { self._pushUndo(); self.boxes = []; self.selectedIdx = -1; Store.set('annotations.human', []); self._markDirty(); self.render(); self._updateAnnotationList(); self._updateStatusBar(); }); },
    undoLast() {
        if (this.undoStack.length === 0) return;
        var snapshot = this.undoStack.pop();
        this.boxes = snapshot.boxes || [];
        this.predBoxes = snapshot.predBoxes || [];
        this.selectedIdx = -1;
        Store.set('annotations.human', this.boxes.slice());
        Store.set('annotations.dirty', true);
        Store.set('predictions.current', this.predBoxes.slice());
        // Save immediately to persist the undo
        var undoId = Store.get('currentImage.id');
        if (undoId) {
            this.saveAnnotations(undoId).catch(function(e) { console.error('Undo save failed:', e); });
            // Also restore predictions file to match the undone state
            api.put('/predictions/' + undoId, { predictions: this.predBoxes }).catch(function() {});
        }
        this.render();
        this._updateAnnotationList();
        this._updateStatusBar();
        App.toast('已撤销', 'info');
    },
    cancelDrawing() { if (this.mode === 'drawing_polygon') { this.mode = 'idle'; this.polyPoints = []; this.polyPreviewPoint = null; this.render(); } },
    toggleOriginal() { this.showOriginal = !this.showOriginal; var btn = document.getElementById('btn-toggle-original'); if (btn) btn.classList.toggle('active', this.showOriginal); this.render(); },
    toggleComparison() { var en = !Store.get('comparison.enabled'); Store.set('comparison.enabled', en); var self = this; if (en) { var imgId = Store.get('currentImage.id'); if (imgId) api.get('/comparison/' + imgId).then(function(c) { self.matches = c.matches || []; self.unmatchedH = c.unmatched_human || []; self.unmatchedM = c.unmatched_model || []; self.render(); self._updateAnnotationList(); }).catch(function() { App.toast('对比模式加载失败', 'warning'); }); } else { this.matches = []; this.render(); } document.getElementById('btn-toggle-comparison') && document.getElementById('btn-toggle-comparison').classList.toggle('active', en); },
    _refreshComparison() { if (!Store.get('comparison.enabled')) return; var imgId = Store.get('currentImage.id'); var self = this; if (imgId) api.get('/comparison/' + imgId).then(function(c) { self.matches = c.matches || []; self.unmatchedH = c.unmatched_human || []; self.unmatchedM = c.unmatched_model || []; self.render(); }).catch(function() {}); },
    _pushUndo() {
        // Save full state: both human annotations AND model predictions
        this.undoStack.push({
            boxes: JSON.parse(JSON.stringify(this.boxes)),
            predBoxes: JSON.parse(JSON.stringify(this.predBoxes)),
        });
        if (this.undoStack.length > 50) this.undoStack.shift();
    },

    // Mark annotations dirty and auto-save after a short debounce
    _markDirty() {
        Store.set('annotations.dirty', true);
        // Debounced auto-save: save 100ms after last modification (near-instant)
        var self = this;
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(function() {
            var imgId = Store.get('currentImage.id');
            if (imgId && Store.get('annotations.dirty')) {
                self.saveAnnotations(imgId).catch(function() {});
            }
        }, 100);
    },

    // Cancel pending auto-save and flush immediately (called before image switch)
    async _flushSave(imageId) {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        if (!imageId) return;
        // Save human annotations if dirty
        if (Store.get('annotations.dirty')) {
            try { await this.saveAnnotations(imageId); }
            catch (e) { console.error('Flush annotations failed:', e); }
        }
        // Always save predictions to ensure deletions/edits are persisted
        try { await api.put('/predictions/' + imageId, { predictions: this.predBoxes }); }
        catch (e) { console.error('Flush predictions failed:', e); }
    },
    changeLabelForSelected(classIdx) { if (this.selectedIdx >= 0 && this.selectedIdx < this.boxes.length) { this.boxes[this.selectedIdx].class_id = classIdx; Store.set('annotations.human', this.boxes.slice()); this._markDirty(); this.render(); this._updateAnnotationList(); } },
    zoomIn() { this._zoomAtCenter(1.2); }, zoomOut() { this._zoomAtCenter(0.8); }, zoomFit() { this._fitAndPosition(); },
    _zoomAtCenter(f) { var cx = this.canvas.width / 2, cy = this.canvas.height / 2, wx = (cx - this._imgOffsetX) / this.scale, wy = (cy - this._imgOffsetY) / this.scale; this.scale = clamp(this.scale * f, 0.1, 6.0); Store.set('ui.zoom', this.scale, { silent: true }); this._imgOffsetX = cx - wx * this.scale; this._imgOffsetY = cy - wy * this.scale; this.imgLayer.style.left = this._imgOffsetX + 'px'; this.imgLayer.style.top = this._imgOffsetY + 'px'; var dw = this.imgNaturalW * this.scale, dh = this.imgNaturalH * this.scale; this.img.style.width = dw + 'px'; this.img.style.height = dh + 'px'; this.imgLayer.style.width = dw + 'px'; this.imgLayer.style.height = dh + 'px'; document.getElementById('zoom-level').textContent = Math.round(this.scale * 100) + '%'; this.render(); },
    _updateCursor() { var cursors = { select: 'default', draw: 'crosshair', polygon: 'crosshair', eraser: 'pointer', pan: 'grab' }; this.canvas.style.cursor = cursors[this.activeTool] || 'default'; this.canvas.classList.toggle('eraser-cursor', this.activeTool === 'eraser'); },
    _updateStatusHint() { var hints = { select: '点击选择/拖拽移动 | 右键擦除 | 双击删除', draw: '拖拽绘制矩形框 | Esc取消', polygon: '点击顶点 | 回到起点闭合 | 双击完成 | Esc取消', eraser: '点击擦除 | 右键任意模式擦除', pan: '拖拽平移' }; document.getElementById('status-tool-hint').textContent = hints[this.activeTool] || ''; },
    _updateStatusBar() { var meta = Store.get('currentImage.metadata'); document.getElementById('status-image-info').textContent = meta ? meta.filename + ' | ' + meta.width + '×' + meta.height + ' | ' + meta.split : '未选择图片'; document.getElementById('status-box-count').textContent = '标注: ' + this.boxes.length + ' | 预测: ' + this.predBoxes.length; },
    _updateStatusCoords(ix, iy) { document.getElementById('status-coords').textContent = '(' + Math.round(ix) + ', ' + Math.round(iy) + ')'; },
};

function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function hexToRgba(hex, a) { var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16); return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }
