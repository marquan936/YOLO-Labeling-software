/**
 * Class definitions manager and label picker.
 */
const ClassManager = {
    DEFAULTS: [
        { name: 'person', color: '#FF3838' },
        { name: 'car', color: '#48F90A' },
        { name: 'dog', color: '#FF9D97' },
        { name: 'cat', color: '#00C2FF' },
        { name: 'bicycle', color: '#FFB21D' },
    ],
    _modelSource: '', // Track which model labels came from

    async init() {
        await this._loadClasses();
        Store.on('change:ui.activePanel', (panel) => {
            if (panel === 'labels') this._renderAsLabels();
            else if (panel === 'classes') this._render();
        });
        Store.on('change:classes', () => {
            this._updateActiveSelect();
            if (Store.get('ui.activePanel') === 'labels') this._renderAsLabels();
            else this._render();
        });
    },

    async _loadClasses() {
        try {
            const data = await api.get('/classes');
            if (data.classes && data.classes.length > 0) {
                Store.set('classes.items', data.classes.map(c => ({ idx: c.idx, name: c.name, color: c.color })));
            } else {
                const items = this.DEFAULTS.map((d, i) => ({ idx: i, ...d }));
                Store.set('classes.items', items);
                await api.put('/classes', { classes: items.map(c => ({ idx: c.idx, name: c.name, color: c.color })) });
            }
        } catch {
            Store.set('classes.items', this.DEFAULTS.map((d, i) => ({ idx: i, ...d })));
        }
    },

    /* ---- Load model labels ---- */
    async loadLabelsFromModel(modelName) {
        try {
            const data = await api.post('/classes/from-model');
            const classes = data.classes.map(c => ({ idx: c.idx, name: c.name, color: c.color }));
            Store.set('classes.items', classes);
            this._modelSource = modelName || '';
            App.toast(
                '已导入 ' + data.count + ' 个模型标签: ' +
                classes.slice(0, 6).map(c => c.name).join(', ') + (data.count > 6 ? '...' : ''),
                'success'
            );
            this._updateActiveSelect();
            if (Store.get('ui.activePanel') === 'labels') this._renderAsLabels();
        } catch (e) {
            App.toast('导入模型标签失败: ' + e.message, 'warning');
        }
    },

    /* ---- Class Editor Panel ---- */

    _render() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'classes') return;
        const items = Store.get('classes.items');
        container.innerHTML =
            '<div style="padding:8px 0;">' +
                '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">' +
                    (this._modelSource ? '📌 标签来自模型: <strong>' + escapeHtml(this._modelSource) + '</strong>' : '📌 默认标签') +
                '</div>' +
                '<button class="btn btn-sm btn-primary" onclick="ClassManager.addClass()" style="width:100%;margin-bottom:6px;">+ 添加类别</button>' +
                '<button class="btn btn-sm" onclick="ClassManager._importFromModel()" style="width:100%;margin-bottom:8px;">📥 从模型重新导入</button>' +
            '</div>' +
            items.map(function (c) {
                return '<div class="model-card" style="display:flex;align-items:center;gap:8px;">' +
                    '<span class="color-dot" style="background:' + c.color + ';width:14px;height:14px;flex-shrink:0;"></span>' +
                    '<input value="' + escapeHtml(c.name) + '" style="flex:1;padding:4px 6px;font-size:12px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);" onchange="ClassManager._renameClass(' + c.idx + ', this.value)">' +
                    '<input type="color" value="' + c.color + '" style="width:28px;height:28px;border:none;cursor:pointer;background:none;" onchange="ClassManager._changeColor(' + c.idx + ', this.value)">' +
                    '<button class="btn btn-sm" style="color:var(--danger);padding:2px 8px;" onclick="ClassManager._deleteClass(' + c.idx + ')" title="删除标签">✕</button>' +
                '</div>';
            }).join('') +
            '<div style="padding:8px;font-size:11px;color:var(--text-muted);">' + items.length + ' 个类别 | 索引 0-' + Math.max(0, items.length - 1) + '</div>';
    },

    _renameClass(idx, newName) {
        const items = Store.get('classes.items').map(function (c) { return c.idx === idx ? { idx: c.idx, name: newName, color: c.color } : c; });
        this._save(items);
    },

    _changeColor(idx, color) {
        const items = Store.get('classes.items').map(function (c) { return c.idx === idx ? { idx: c.idx, name: c.name, color: color } : c; });
        Store.set('classes.items', items);
        api.put('/classes', { classes: items }).catch(function (e) { App.toast('保存失败: ' + e.message, 'error'); });
        Canvas.render();
    },

    addClass() {
        const items = Store.get('classes.items').slice();
        const colors = ['#FF3838','#48F90A','#FF9D97','#00C2FF','#FFB21D','#CFD231','#92CC17','#3DDB86',
            '#1A9334','#00D4BB','#2C99A8','#344593','#6473FF','#0018EC','#8438FF','#B085FF','#C23DFF','#FF44FF','#FF4ECD'];
        items.push({ idx: items.length, name: 'class_' + items.length, color: colors[items.length % colors.length] });
        this._save(items);
    },

    _deleteClass(idx) {
        const items = Store.get('classes.items');
        if (items.length <= 1) { App.toast('至少保留一个类别', 'warning'); return; }
        const cls = items.find(function (c) { return c.idx === idx; });
        App.confirm('确认删除标签 "' + (cls ? cls.name : '') + '"？', function () {
            const filtered = items.filter(function (c) { return c.idx !== idx; });
            const reindexed = filtered.map(function (c, i) { return { idx: i, name: c.name, color: c.color }; });
            ClassManager._save(reindexed);
        });
    },

    async _save(items) {
        Store.set('classes.items', items);
        try {
            await api.put('/classes', { classes: items });
            Canvas.render();
            Canvas._updateAnnotationList();
        } catch (e) { App.toast('保存失败: ' + e.message, 'error'); }
    },

    async _importFromModel() {
        try {
            const data = await api.post('/classes/from-model');
            const classes = data.classes.map(function (c) { return { idx: c.idx, name: c.name, color: c.color }; });
            Store.set('classes.items', classes);
            App.toast('已从模型导入 ' + data.count + ' 个类别', 'success');
            this._render();
            this._updateActiveSelect();
        } catch (e) { App.toast('导入失败: ' + e.message, 'error'); }
    },

    /* ---- Label Quick-Select Panel ---- */

    _renderAsLabels() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'labels') return;
        const items = Store.get('classes.items');
        const activeIdx = Store.get('classes.activeIdx');

        var html = '<div style="padding:8px 0;">';
        if (this._modelSource) {
            html += '<div style="font-size:10px;color:var(--success);margin-bottom:4px;padding:4px 6px;background:var(--success-bg);border-radius:3px;">📌 模型标签: ' + escapeHtml(this._modelSource) + ' (' + items.length + '类)</div>';
        }
        html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">点击选择标注标签 | 快捷键 <kbd style="background:var(--bg-surface);padding:1px 5px;border-radius:3px;">0-9</kbd></div>';

        for (var i = 0; i < items.length; i++) {
            var c = items[i];
            var activeCls = c.idx === activeIdx ? ' active' : '';
            html += '<div class="model-card' + activeCls + '" style="display:flex;align-items:center;gap:8px;cursor:pointer;">' +
                '<span class="color-dot" style="background:' + c.color + ';width:14px;height:14px;flex-shrink:0;" onclick="ClassManager._selectLabel(' + c.idx + ')"></span>' +
                '<span style="flex:1;font-weight:' + (c.idx === activeIdx ? '700' : '500') + ';font-size:12px;" onclick="ClassManager._selectLabel(' + c.idx + ')">' + escapeHtml(c.name) + '</span>' +
                '<kbd style="background:var(--bg-surface);border:1px solid var(--border-color);border-radius:3px;padding:1px 5px;font-size:10px;font-family:var(--font-mono);color:var(--text-muted);">' + i + '</kbd>' +
                '<button class="btn btn-sm" style="color:var(--danger);padding:1px 6px;font-size:14px;line-height:1;" onclick="event.stopPropagation();ClassManager._deleteLabelQuick(' + c.idx + ')" title="删除此标签">×</button>' +
            '</div>';
        }

        html += '<hr style="border-color:var(--border-color);margin:10px 0;">' +
            '<button class="btn btn-sm" onclick="ClassManager.addLabelQuick()" style="width:100%;margin-bottom:4px;">+ 新建标签</button>' +
            '<button class="btn btn-sm" onclick="ClassManager._importFromModelQuick()" style="width:100%;">📥 从模型导入标签</button>' +
            '</div>';
        container.innerHTML = html;
    },

    _selectLabel(idx) {
        Store.set('classes.activeIdx', idx);
        Canvas.changeLabelForSelected(idx);
        this._updateActiveSelect();
        this._renderAsLabels();
    },

    _deleteLabelQuick(idx) {
        var items = Store.get('classes.items');
        if (items.length <= 1) { App.toast('至少保留一个标签', 'warning'); return; }
        var cls = items.find(function (c) { return c.idx === idx; });
        if (!cls) return;
        App.confirm('确认删除标签 "' + cls.name + '"？<br><small>标注中使用此标签的框不会被删除</small>', function () {
            var filtered = items.filter(function (c) { return c.idx !== idx; });
            var reindexed = filtered.map(function (c, i) { return { idx: i, name: c.name, color: c.color }; });
            ClassManager._save(reindexed);
            if (Store.get('classes.activeIdx') >= reindexed.length) {
                Store.set('classes.activeIdx', Math.max(0, reindexed.length - 1));
            }
        });
    },

    _importFromModelQuick() {
        this._importFromModel().then(function () {
            ClassManager._renderAsLabels();
        });
    },

    addLabelQuick() {
        var name = prompt('输入新标签名称:');
        if (!name) return;
        var items = Store.get('classes.items').slice();
        var colors = ['#FF3838','#48F90A','#FF9D97','#00C2FF','#FFB21D','#CFD231','#92CC17','#3DDB86',
            '#1A9334','#00D4BB','#2C99A8','#344593','#6473FF','#0018EC','#8438FF','#B085FF','#C23DFF','#FF44FF','#FF4ECD'];
        items.push({ idx: items.length, name: name, color: colors[items.length % colors.length] });
        this._save(items);
        this._renderAsLabels();
    },

    /* ---- Toolbar active-class select ---- */

    _updateActiveSelect() {
        var sel = document.getElementById('active-class-select');
        if (!sel) return;
        var items = Store.get('classes.items');
        var active = Store.get('classes.activeIdx');
        sel.innerHTML = '';
        for (var i = 0; i < items.length; i++) {
            var c = items[i];
            var opt = document.createElement('option');
            opt.value = c.idx;
            opt.textContent = c.name;
            if (c.idx === active) opt.selected = true;
            sel.appendChild(opt);
        }
    },
};

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
