/**
 * Review queue panel.
 */
const ReviewPanel = {
    _rendering: false,
    _queueData: [],
    _queueTotal: 0,
    _reviewNotes: '',

    init() {
        Store.on('change:ui.activePanel', (panel) => {
            if (panel === 'review') this._refresh();
        });
    },

    async _refresh() {
        await this._loadStats();
    },

    async _loadStats() {
        try {
            const stats = await api.get('/review/status');
            Store.set('review', stats, { silent: true });
        } catch { /* ignore */ }
        this._render();
    },

    _render() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'review') return;

        const r = Store.get('review');
        const total = r.total_images || 0;
        const reviewed = r.reviewed || 0;
        const pending = r.pending || 0;
        const skipped = r.skipped || 0;
        const pct = r.pct_complete || 0;

        container.innerHTML =
            '<div style="padding:8px 0;">' +
                '<div class="review-stats">' +
                    '<div class="review-stat"><div class="stat-val">' + total + '</div><div class="stat-label">总图片</div></div>' +
                    '<div class="review-stat"><div class="stat-val">' + reviewed + '</div><div class="stat-label">已审核</div></div>' +
                    '<div class="review-stat"><div class="stat-val">' + pending + '</div><div class="stat-label">待审核</div></div>' +
                    '<div class="review-stat"><div class="stat-val">' + pct + '%</div><div class="stat-label">完成率</div></div>' +
                '</div>' +
                '<div class="progress-bar" style="margin:10px 0;">' +
                    '<div class="progress-fill' + (pct >= 100 ? ' success' : '') + '" style="width:' + pct + '%"></div>' +
                '</div>' +
                '<hr style="border-color:var(--border-color);margin:10px 0;">' +
                '<button class="btn btn-sm btn-primary" onclick="ReviewPanel.goNext()" style="width:100%;margin-bottom:6px;">▶️ 下一个未审核</button>' +
                '<button class="btn btn-sm btn-success" onclick="ReviewPanel.markCurrent()" style="width:100%;margin-bottom:6px;">✅ 标记当前为已审核</button>' +
                '<button class="btn btn-sm" onclick="ReviewPanel.markUnreviewCurrent()" style="width:100%;margin-bottom:6px;">↩️ 标记当前为未审核</button>' +
                '<button class="btn btn-sm" onclick="ReviewPanel.skipCurrent()" style="width:100%;margin-bottom:6px;">⏭️ 跳过当前</button>' +
                '<hr style="border-color:var(--border-color);margin:10px 0;">' +
                '<div class="form-group">' +
                    '<label>审核备注</label>' +
                    '<textarea id="review-notes" rows="2" placeholder="备注信息...">' + escapeHtml(this._reviewNotes || '') + '</textarea>' +
                '</div>' +
                '<button class="btn btn-sm" onclick="ReviewPanel.markAll()" style="width:100%;margin-bottom:4px;">📋 全部标记为已审核</button>' +
                '<div style="margin-top:12px;">' +
                    '<h4 style="font-size:12px;margin-bottom:6px;">待审核列表</h4>' +
                    '<div id="review-queue-list" class="scroll-list" style="max-height:400px;overflow-y:auto;">' +
                        '<div style="text-align:center;padding:10px;color:var(--text-muted);">加载中...</div>' +
                    '</div>' +
                '</div>' +
            '</div>';

        this._loadQueue();
    },

    async _loadQueue() {
        try {
            const data = await api.get('/review/queue?per_page=200');
            this._queueData = data.images || [];
            this._queueTotal = data.total || 0;
            const list = document.getElementById('review-queue-list');
            if (!list) return;

            if (this._queueData.length === 0) {
                list.innerHTML = '<div class="placeholder"><p>🎉 全部审核完成！</p></div>';
                return;
            }

            list.innerHTML = this._queueData.map(img => {
                var curId = Store.get('currentImage.id');
                var active = img.id === curId ? ' active' : '';
                return '<div class="model-card review-queue-item' + active + '" data-id="' + img.id + '" style="display:flex;align-items:center;gap:6px;">' +
                    '<div style="flex:1;cursor:pointer;" onclick="ReviewPanel._jumpTo(' + img.id + ')">' +
                        '<div style="font-size:12px;font-weight:600;">' + escapeHtml(img.filename) + '</div>' +
                        '<div style="font-size:10px;color:var(--text-muted);">' +
                            img.split + ' | ' + img.width + '×' + img.height +
                            (img.has_annotation ? ' | ✋已标注' : '') +
                            (img.has_prediction ? ' | 🤖已预测' : '') +
                        '</div>' +
                    '</div>' +
                    '<button class="btn btn-sm" style="color:var(--danger);padding:2px 6px;font-size:16px;" onclick="event.stopPropagation();ReviewPanel._deleteImage(' + img.id + ',\'' + escapeHtml(img.filename) + '\')" title="删除图片">×</button>' +
                '</div>';
            }).join('');

            if (this._queueTotal > 200) {
                list.innerHTML += '<div style="text-align:center;padding:8px;font-size:11px;color:var(--text-muted);">显示前200张，共' + this._queueTotal + '张待审核</div>';
            }
        } catch { /* ignore */ }
    },

    _jumpTo(imageId) {
        Store.set('currentImage.id', imageId);
        this._highlightCurrentInQueue(imageId);
    },

    async goNext() {
        try {
            const cur = Store.get('currentImage.id');
            const data = await api.get('/review/next' + (cur ? '?current_id=' + cur : ''));
            // If backend returned a valid different image_id, jump to it
            if (data.image_id && data.image_id !== cur) {
                Store.set('currentImage.id', data.image_id);
                this._highlightCurrentInQueue(data.image_id);
                return;
            }
            // Fallback: load review queue locally and pick next after current
            await this._loadQueue();
            if (this._queueData.length === 0) {
                App.toast('🎉 所有图片已审核完毕！', 'success');
                return;
            }
            let nextId = null;
            if (!cur) {
                nextId = this._queueData[0].id;
            } else {
                const idx = this._queueData.findIndex(i => i.id === cur);
                if (idx >= 0) {
                    nextId = (idx + 1 < this._queueData.length) ? this._queueData[idx + 1].id : this._queueData[0].id;
                } else {
                    nextId = this._queueData[0].id;
                }
            }
            if (nextId) {
                Store.set('currentImage.id', nextId);
                this._highlightCurrentInQueue(nextId);
            } else {
                App.toast('🎉 所有图片已审核完毕！', 'success');
            }
        } catch (e) { App.toast('获取失败: ' + formatApiError(e), 'error'); }
    },

    _highlightCurrentInQueue(imageId) {
        const list = document.getElementById('review-queue-list');
        if (!list) return;
        list.querySelectorAll('.review-queue-item').forEach(function(el) {
            el.classList.toggle('active', parseInt(el.dataset.id) === imageId);
        });
        const active = list.querySelector('.review-queue-item.active');
        if (active) active.scrollIntoView({ block: 'nearest' });
    },

    async markUnreviewCurrent() {
        const imgId = Store.get('currentImage.id');
        if (!imgId) { App.toast('请先选择图片', 'warning'); return; }
        try {
            await api.post('/review/unreview/' + imgId);
            App.toast('已标记为未审核', 'info');
            await this._loadStats();
            App.refreshStats();
            ImageNavigator._loadPage(1, true);
        } catch (e) { App.toast('操作失败: ' + formatApiError(e), 'error'); }
    },

    async markCurrent() {
        const imgId = Store.get('currentImage.id');
        if (!imgId) { App.toast('请先选择图片', 'warning'); return; }
        const notes = document.getElementById('review-notes')?.value || '';
        this._reviewNotes = notes;
        try {
            if (Store.get('annotations.dirty')) await Canvas.saveAnnotations();
            await api.post('/review/mark/' + imgId, { status: 'reviewed', notes: notes });
            App.toast('已标记为已审核', 'success');
            await this._loadStats();
            setTimeout(() => this.goNext(), 300);
            App.refreshStats();
        } catch (e) { App.toast('标记失败: ' + e.message, 'error'); }
    },

    async skipCurrent() {
        const imgId = Store.get('currentImage.id');
        if (!imgId) { App.toast('请先选择图片', 'warning'); return; }
        try {
            await api.post('/review/mark/' + imgId, { status: 'skipped', notes: '' });
            App.toast('已跳过', 'info');
            await this._loadStats();
            setTimeout(() => this.goNext(), 300);
        } catch (e) { App.toast('操作失败: ' + e.message, 'error'); }
    },

    async _deleteImage(imageId, filename) {
        var self = this;
        App.confirm('确认删除图片 "' + filename + '" 及其所有标注？<br><small>此操作不可撤销</small>', async function() {
            try {
                await api.del('/images/' + imageId);
                App.toast('已删除: ' + filename, 'success');
                if (Store.get('currentImage.id') === imageId) {
                    Store.set('currentImage.id', null);
                    Canvas.boxes = []; Canvas.predBoxes = [];
                    Canvas.render(); Canvas._updateAnnotationList();
                }
                await self._loadStats();
                ImageNavigator._removeItem(imageId);
                App.refreshStats();
            } catch (e) { App.toast('删除失败: ' + e.message, 'error'); }
        });
    },

    async markAll() {
        App.confirm('确定将所有待审核图片标记为已审核？', async () => {
            try {
                const res = await api.post('/review/mark-all');
                App.toast('已标记 ' + res.updated + ' 张图片为已审核', 'success');
                await this._loadStats();
                App.refreshStats();
            } catch (e) { App.toast('操作失败: ' + e.message, 'error'); }
        });
    },
};
