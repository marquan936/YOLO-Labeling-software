/**
 * App — Root controller. Initializes all modules.
 */
const App = {
    autoSaveTimer: null,
    themeIdx: 0,
    themes: ['dark', 'dark_gold', 'ocean', 'light', 'violet'],

    async init() {
        // Initialize components
        Canvas.init();
        ImageNavigator.init();
        ClassManager.init();
        ModelPanel.init();
        PredictionPanel.init();
        ComparisonView.init();
        ReviewPanel.init();
        ExportPanel.init();
        SettingsPanel.init();

        this._bindToolbar();
        this._bindHotkeys();
        this._bindSidebarTabs();
        ClassManager._updateActiveSelect();
        this.refreshStats();

        // Start auto-save
        this._setupAutoSave();

        Store.on('change:predictions.batchTask', (task) => this.updateBatchProgress(task));

        // Warn before leaving with unsaved changes
        window.addEventListener('beforeunload', (e) => {
            if (Store.get('annotations.dirty')) {
                e.preventDefault(); e.returnValue = '';
            }
        });

        // Hide loading overlay
        document.getElementById('app-loading').style.display = 'none';
        console.log('[Auto-Annotator] Initialized');
    },

    _bindToolbar() {
        document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Store.set('ui.activeTool', btn.dataset.tool);
                // If switching away from polygon, cancel polygon drawing
                if (btn.dataset.tool !== 'polygon' && Canvas.mode === 'drawing_polygon') {
                    Canvas.cancelDrawing();
                }
            });
        });

        document.getElementById('btn-zoom-in').addEventListener('click', () => Canvas.zoomIn());
        document.getElementById('btn-zoom-out').addEventListener('click', () => Canvas.zoomOut());
        document.getElementById('btn-zoom-fit').addEventListener('click', () => Canvas.zoomFit());
        document.getElementById('btn-toggle-comparison').addEventListener('click', () => Canvas.toggleComparison());

        document.getElementById('active-class-select').addEventListener('change', (e) => {
            const idx = parseInt(e.target.value);
            Store.set('classes.activeIdx', idx);
            Canvas.changeLabelForSelected(idx);
        });

        document.getElementById('btn-undo').addEventListener('click', () => Canvas.undoLast());
        document.getElementById('btn-save').addEventListener('click', () => Canvas.saveAnnotations());
        document.getElementById('btn-clear').addEventListener('click', () => Canvas.clearAnnotations());
    },

    _bindHotkeys() {
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

            // Ctrl+S → save
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault(); Canvas.saveAnnotations(); return;
            }
            // Ctrl+Z → undo
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault(); Canvas.undoLast(); return;
            }

            const key = e.key.toLowerCase();
            switch (key) {
                case 's': this._setTool('select'); break;
                case 'r': this._setTool('draw'); break;
                case 'p': this._setTool('polygon'); break;
                case 'e': this._setTool('eraser'); break;
                case 'h': this._setTool('pan'); break;
                case 'delete':
                case 'backspace':
                    if (Canvas.selectedIdx >= 0) {
                        Canvas.deleteBox(Canvas.selectedIdx, 'human');
                    }
                    break;
                case 'escape':
                    if (Canvas.mode === 'drawing_polygon') {
                        Canvas.cancelDrawing();
                    } else if (Canvas.mode === 'drawing_rect') {
                        Canvas.mode = 'idle'; Canvas.render();
                    } else {
                        Canvas.selectedIdx = -1; Canvas.mode = 'idle'; Canvas.render(); Canvas._updateAnnotationList();
                    }
                    break;
                case '`':
                    Canvas.toggleOriginal();
                    break;
                case 'arrowleft': this._navigateImage(-1); break;
                case 'arrowright': this._navigateImage(1); break;
                case 'enter':
                    if (Canvas.mode === 'drawing_polygon') Canvas._finishPolygon();
                    break;
                // Number keys for quick label selection
                case '0': case '1': case '2': case '3': case '4':
                case '5': case '6': case '7': case '8': case '9':
                    const idx = parseInt(key);
                    const classes = Store.get('classes.items');
                    if (idx < classes.length) {
                        Store.set('classes.activeIdx', idx);
                        Canvas.changeLabelForSelected(idx);
                        ClassManager._updateActiveSelect();
                    }
                    break;
            }
        });
    },

    _setTool(tool) {
        Store.set('ui.activeTool', tool);
        document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
        document.querySelector(`.tool-btn[data-tool="${tool}"]`)?.classList.add('active');
        if (tool !== 'polygon' && Canvas.mode === 'drawing_polygon') Canvas.cancelDrawing();
    },

    _navigateImage(delta) {
        const items = Store.get('images.items');
        const currentId = Store.get('currentImage.id');
        if (!items.length) return;
        const idx = items.findIndex(img => img.id === currentId);
        const newIdx = idx >= 0 ? idx + delta : 0;
        if (newIdx >= 0 && newIdx < items.length) Store.set('currentImage.id', items[newIdx].id);
    },

    _bindSidebarTabs() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const panel = btn.dataset.panel;
                Store.set('ui.activePanel', panel);

                switch (panel) {
                    case 'navigator': ImageNavigator._render(); ImageNavigator._loadPage(1, true); break;
                    case 'labels': ClassManager._renderAsLabels(); break;
                    case 'model': ModelPanel._render(); break;
                    case 'predict': PredictionPanel._render(); break;
                    case 'review': ReviewPanel._render(); break;
                    case 'settings': SettingsPanel._render(); break;
                }
            });
        });
    },

    async _setupAutoSave() {
        if (this.autoSaveTimer) clearInterval(this.autoSaveTimer);
        let interval = 30000;
        try {
            const s = await api.get('/settings');
            interval = ((s.auto_save || {}).interval_seconds || 30) * 1000;
        } catch {}
        this.autoSaveTimer = setInterval(async () => {
            if (Store.get('annotations.dirty') && Store.get('currentImage.id')) {
                try {
                    const s = await api.get('/settings');
                    if ((s.auto_save || {}).enabled !== false) await Canvas.saveAnnotations();
                } catch { await Canvas.saveAnnotations(); }
            }
        }, interval);
    },

    async scanImages() {
        try {
            const r = await api.post('/images/scan');
            App.toast(`扫描完成: 新增 ${r.added} 张, 更新 ${r.updated} 张, 共 ${r.total} 张`, 'success');
            ImageNavigator._loadPage(1, true);
            this.refreshStats();
        } catch (e) { App.toast('扫描失败: ' + e.message, 'error'); }
    },

    async refreshStats() {
        try {
            const s = await api.get('/images/stats/summary');
            document.getElementById('stat-total').textContent = s.total || 0;
            document.getElementById('stat-annotated').textContent = s.annotated || 0;
            document.getElementById('stat-predicted').textContent = s.predicted || 0;
            document.getElementById('stat-reviewed').textContent = s.reviewed || 0;
        } catch {}
    },

    updateBatchProgress(task) {
        const bar = document.getElementById('batch-progress-global');
        if (!bar) return;
        if (!task) { bar.style.display = 'none'; return; }

        bar.style.display = 'flex';
        const pct = Math.round((task.progress || 0) * 100);
        const fill = document.getElementById('batch-progress-fill');
        const label = document.getElementById('batch-progress-label');
        const count = document.getElementById('batch-progress-count');
        if (fill) {
            fill.style.width = pct + '%';
            fill.classList.toggle('success', task.status === 'completed');
        }
        if (count) count.textContent = `${task.processed || 0} / ${task.total || 0}`;
        if (label) {
            const errCount = (task.errors || []).length;
            if (task.status === 'running') label.textContent = '批量预测中...';
            else if (task.status === 'completed' && errCount > 0) label.textContent = `完成 (${errCount} 张失败)`;
            else if (task.status === 'completed') label.textContent = '批量预测完成';
            else label.textContent = task.status || '批量任务';
        }
    },

    _finishBatchTask(task, successMsg, onDone) {
        const finalTask = Object.assign({}, task, { status: 'completed', progress: 1 });
        Store.set('predictions.batchTask', finalTask);
        this.updateBatchProgress(finalTask);
        setTimeout(() => {
            Store.set('predictions.batchTask', null);
            this.updateBatchProgress(null);
            if (onDone) onDone();
        }, 4000);
        Store.set('predictions.predicting', false);
        const errCount = (finalTask.errors || []).length;
        if (errCount > 0) {
            this.toast(`${successMsg}，${errCount} 张失败`, 'warning');
        } else {
            this.toast(successMsg, 'success');
        }
    },

    cycleTheme() {
        this.themeIdx = (this.themeIdx + 1) % this.themes.length;
        SettingsPanel.applyTheme(this.themes[this.themeIdx]);
    },

    // ─── Toast ──────────────────────────────────────────────────
    toast(msg, type = 'info') {
        const ct = document.getElementById('toast-container');
        // Remove duplicate toasts with same text
        for (let i = 0; i < ct.children.length; i++) {
            if (ct.children[i].textContent === msg) ct.children[i].remove();
        }
        // Limit concurrent toasts
        while (ct.children.length >= 3) ct.firstChild.remove();
        const t = document.createElement('div');
        t.className = `toast ${type}`; t.textContent = msg;
        ct.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3000);
    },

    // ─── Modal ──────────────────────────────────────────────────
    confirm(msg, onOk) {
        document.getElementById('modal-title').textContent = '确认';
        document.getElementById('modal-body').innerHTML = `<p>${msg}</p>`;
        document.getElementById('modal-footer').innerHTML =
            '<button class="btn" onclick="App.closeModal()">取消</button><button class="btn btn-primary" id="modal-ok">确认</button>';
        document.getElementById('modal-overlay').style.display = 'flex';
        document.getElementById('modal-ok').addEventListener('click', () => { this.closeModal(); if (onOk) onOk(); });
    },

    closeModal() {
        document.getElementById('modal-overlay').style.display = 'none';
    },

    showShortcutsModal() {
        const shortcuts = [
            ['S', '选择/移动工具'],
            ['R', '绘制矩形框'],
            ['P', '绘制多边形 (点击顶点, 回到起点闭合)'],
            ['E', '橡皮擦 (擦除标注)'],
            ['H', '平移画布'],
            ['Delete', '删除选中标注'],
            ['Esc', '取消绘制/取消选中'],
            ['Enter', '完成多边形绘制'],
            ['Ctrl+S', '保存标注'],
            ['Ctrl+Z', '撤销'],
            ['`', '切换原图/标注视图'],
            ['← →', '前一张/后一张图片'],
            ['0-9', '快速切换标签'],
            ['右键', '快速擦除标注 (任意模式下)'],
            ['滚轮', '缩放画布'],
        ];

        let html = '<div class="shortcut-list" style="display:grid;grid-template-columns:1fr 2fr;gap:4px 12px;font-size:12px;">';
        for (const [key, desc] of shortcuts) {
            html += '<kbd style="background:var(--bg-primary);border:1px solid var(--border-color);border-radius:3px;padding:3px 8px;font-family:var(--font-mono);font-size:11px;color:var(--accent);text-align:center;">' + key + '</kbd>';
            html += '<span style="color:var(--text-secondary);padding:3px 0;">' + desc + '</span>';
        }
        html += '</div>';

        document.getElementById('modal-title').textContent = '快捷键参考 ⌨️';
        document.getElementById('modal-body').innerHTML = html;
        document.getElementById('modal-footer').innerHTML =
            '<button class="btn btn-primary" onclick="App.closeModal()">关闭</button>';
        document.getElementById('modal-overlay').style.display = 'flex';
    },
};

document.addEventListener('DOMContentLoaded', () => App.init());
