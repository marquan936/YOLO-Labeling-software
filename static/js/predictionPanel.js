/**
 * Prediction/inference panel.
 */
const PredictionPanel = {
    _pollTimer: null,

    init() {
        Store.on('change:ui.activePanel', () => { this._render(); this._loadUnannotatedCount(); });
        Store.on('change:predictions.batchTask', () => this._updateProgressSection());
    },

    _unannotatedCount: 0,

    async _loadUnannotatedCount() {
        try {
            const stats = await api.get('/images/stats/summary');
            // Use backend's unannotated field (images with neither human nor model labels)
            this._unannotatedCount = stats.unannotated ?? Math.max(0, (stats.total || 0) - (stats.annotated || 0));
            this._render();
        } catch { this._unannotatedCount = 0; }
    },

    async _updateUnannotatedCountLive() {
        // Lightweight update without full re-render — only update the count display
        try {
            const stats = await api.get('/images/stats/summary');
            this._unannotatedCount = stats.unannotated ?? Math.max(0, (stats.total || 0) - (stats.annotated || 0));
            // Update DOM elements in-place
            const countEl = document.getElementById('unannotated-count-display');
            const btnEl = document.getElementById('btn-predict-unannotated');
            if (countEl) countEl.textContent = this._unannotatedCount;
            if (btnEl) {
                btnEl.textContent = '🚀 批量预测所有未标注图片 (' + this._unannotatedCount + '张)';
                // Disable button if no unannotated images
                btnEl.disabled = this._unannotatedCount <= 0;
            }
            // Also update header stats
            App.refreshStats();
        } catch { /* ignore */ }
    },

    _taskFromPoll(taskId, r, fallbackTotal) {
        const total = r.total || fallbackTotal || 0;
        const processed = r.processed || 0;
        return {
            id: taskId,
            total,
            processed,
            status: r.status,
            progress: total > 0 ? processed / total : 0,
            errors: r.errors || [],
        };
    },

    _startBatchPoll(taskId, fallbackTotal, successMsg, onComplete) {
        Store.set('predictions.batchTask', {
            id: taskId, total: fallbackTotal, processed: 0, status: 'running', progress: 0, errors: [],
        });
        App.updateBatchProgress(Store.get('predictions.batchTask'));

        const self = this;
        let _lastRefreshedProcessed = 0;
        pollTask(taskId, function(r) {
            const task = self._taskFromPoll(taskId, r, fallbackTotal);
            Store.set('predictions.batchTask', task);
            App.updateBatchProgress(task);
            self._updateProgressSection();
            // —— 实时刷新当前图片的预测结果和未标注计数 ——
            if (task.processed > _lastRefreshedProcessed) {
                _lastRefreshedProcessed = task.processed;
                const imgId = Store.get('currentImage.id');
                if (imgId) {
                    api.get('/predictions/' + imgId).then(function(d) {
                        const preds = d.predictions || [];
                        Canvas.predBoxes = preds;
                        Store.set('predictions.current', preds);
                        Canvas.render();
                        Canvas._updateAnnotationList();
                    }).catch(function() {});
                }
                // 实时更新未标注图片数量
                self._updateUnannotatedCountLive();
            }
        }).then(function(r) {
            const task = self._taskFromPoll(taskId, r, fallbackTotal);
            App._finishBatchTask(task, successMsg, function() {
                if (onComplete) onComplete();
                self._loadUnannotatedCount();
                self._render();
            });
        }).catch(function(err) {
            Store.set('predictions.batchTask', null);
            Store.set('predictions.predicting', false);
            App.updateBatchProgress(null);
            App.toast('批量预测出错: ' + formatApiError(err), 'error');
            self._render();
        });
    },

    _updateProgressSection() {
        const task = Store.get('predictions.batchTask');
        const section = document.getElementById('batch-task-progress');
        if (!section) return;
        if (!task) { section.style.display = 'none'; return; }

        section.style.display = 'block';
        const statusEl = section.querySelector('.batch-task-status');
        const fillEl = section.querySelector('.progress-fill');
        const countEl = section.querySelector('.batch-task-count');
        const errEl = section.querySelector('.batch-task-errors');
        const errCount = (task.errors || []).length;

        if (statusEl) {
            statusEl.textContent = task.status === 'running' ? '运行中...'
                : (task.status === 'completed' && errCount > 0 ? `完成 (${errCount} 张失败)` : task.status);
        }
        if (fillEl) {
            fillEl.style.width = ((task.progress || 0) * 100) + '%';
            fillEl.classList.toggle('success', task.status === 'completed');
        }
        if (countEl) countEl.textContent = `${task.processed || 0} / ${task.total || 0}`;
        if (errEl) errEl.textContent = errCount > 0 ? `失败: ${errCount} 张` : '';
    },

    _render() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'predict') return;

        const task = Store.get('predictions.batchTask');
        const predicting = Store.get('predictions.predicting');
        const loaded = Store.get('models.loaded');

        container.innerHTML = `
            <div style="padding:8px 0;">
                <div class="form-group">
                    <label>置信度阈值: <span id="conf-val">0.25</span></label>
                    <input type="range" id="conf-threshold" min="0" max="1" step="0.05" value="0.25"
                        oninput="document.getElementById('conf-val').textContent=this.value">
                </div>
                <div class="form-group">
                    <label>IoU 阈值: <span id="iou-val">0.45</span></label>
                    <input type="range" id="iou-threshold" min="0" max="1" step="0.05" value="0.45"
                        oninput="document.getElementById('iou-val').textContent=this.value">
                </div>
                <div class="form-group">
                    <label>操作模式</label>
                    <select id="pred-operation">
                        <option value="overwrite">覆盖 (替换现有预测)</option>
                        <option value="append">追加 (合并到人工标注)</option>
                    </select>
                </div>
                <div style="font-size:10px;color:var(--text-muted);padding:4px 0;line-height:1.5;background:var(--info-bg);border-radius:4px;margin:4px 0;padding:6px 8px;">
                    📌 <strong>使用步骤：</strong><br>
                    1. 将图片放入 <code>data/images/train/</code> 或 <code>data/images/val/</code><br>
                    2. 点击顶栏 <strong>🔄 扫描</strong> 注册图片<br>
                    3. 在 <strong>🧠 模型</strong> 面板加载模型<br>
                    4. 点击下方按钮批量预测
                </div>
                <hr style="border-color:var(--border-color);margin:10px 0;">

                ${!loaded ? '<div class="placeholder"><p>⚠️ 请先在「模型」面板加载模型</p></div>' : `
                    <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;text-align:center;">
                        未标注图片: <strong id="unannotated-count-display" style="color:var(--accent);">${this._unannotatedCount}</strong> 张 | 当前模式: ${document.getElementById('pred-operation')?.value === 'append' ? '追加' : '覆盖'}
                    </div>
                    <button class="btn btn-sm btn-primary" onclick="PredictionPanel.predictCurrent()"
                        style="width:100%;margin-bottom:6px;" ${predicting?'disabled':''}>
                        ${predicting ? '<span class="loading-spinner"></span> 预测中...' : '🔮 预测当前图片'}
                    </button>
                    <button class="btn btn-sm" id="btn-predict-unannotated" onclick="PredictionPanel.predictUnannotated()"
                        style="width:100%;margin-bottom:6px;" ${predicting?'disabled':''}>
                        🚀 批量预测所有未标注图片 (${this._unannotatedCount}张)
                    </button>
                    <hr style="border-color:var(--border-color);margin:8px 0;">
                    <div class="form-group">
                        <label>📂 打开文件夹批量预测</label>
                        <div style="display:flex;gap:4px;">
                            <input type="text" id="folder-path-input" placeholder="输入图片文件夹路径..."
                                style="flex:1;font-size:11px;padding:5px;">
                            <button class="btn btn-sm btn-primary" onclick="PredictionPanel.predictFolder()"
                                ${predicting?'disabled':''}>
                                🚀 预测
                            </button>
                        </div>
                        <div style="font-size:9px;color:var(--text-muted);margin-top:3px;">
                            支持子文件夹递归扫描，图片将自动复制到 data/images/ 并注册
                        </div>
                    </div>
                `}

                <div id="batch-task-progress" style="margin-top:8px;padding:8px;background:var(--bg-primary);border-radius:4px;${task ? '' : 'display:none;'}">
                    <div style="font-size:12px;margin-bottom:4px;">
                        批量任务: <span class="batch-task-status">${task && task.status === 'running' ? '运行中...' : (task ? task.status : '')}</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill${task && task.status === 'completed' ? ' success' : ''}" style="width:${task ? (task.progress||0)*100 : 0}%"></div>
                    </div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">
                        <span class="batch-task-count">${task ? `${task.processed || 0} / ${task.total || 0}` : '0 / 0'}</span>
                        <span class="batch-task-errors" style="color:var(--warning);margin-left:6px;"></span>
                    </div>
                </div>
            </div>
        `;
        this._updateProgressSection();
    },

    async predictCurrent() {
        const imgId = Store.get('currentImage.id');
        if (!imgId) { App.toast('请先选择图片', 'warning'); return; }
        if (!Store.get('models.loaded')) { App.toast('请先加载模型', 'warning'); return; }

        Store.set('predictions.predicting', true);
        this._render();
        const conf = parseFloat(document.getElementById('conf-threshold')?.value || 0.25);
        const iou = parseFloat(document.getElementById('iou-threshold')?.value || 0.45);
        const op = document.getElementById('pred-operation')?.value || 'overwrite';

        try {
            const result = await api.post(
                `/predict/${imgId}?confidence=${conf}&iou=${iou}&operation=${op}`
            );
            if (op === 'append') {
                const annData = await api.get('/annotations/' + imgId);
                Canvas.boxes = annData.annotations || [];
                Store.set('annotations.human', Canvas.boxes.slice(), { silent: true });
                Store.set('annotations.dirty', false);
            }
            Canvas.predBoxes = result.predictions || [];
            Store.set('predictions.current', Canvas.predBoxes);
            App.toast(`预测完成: ${result.count} 个检测`, 'success');
            Canvas.render();
            Canvas._updateAnnotationList();
            Canvas._updateStatusBar();
            App.refreshStats();
        } catch (e) {
            App.toast(`预测失败: ${formatApiError(e)}`, 'error');
        }
        Store.set('predictions.predicting', false);
        this._render();
    },

    async predictFolder() {
        var folderPath = document.getElementById('folder-path-input')?.value.trim();
        if (!folderPath) { App.toast('请输入图片文件夹路径', 'warning'); return; }
        if (!Store.get('models.loaded')) { App.toast('请先加载模型', 'warning'); return; }

        Store.set('predictions.predicting', true);
        this._render();
        var conf = parseFloat(document.getElementById('conf-threshold')?.value || 0.25);
        var iou = parseFloat(document.getElementById('iou-threshold')?.value || 0.45);

        try {
            var res = await api.post('/predict/folder', {
                folder_path: folderPath,
                confidence_threshold: conf,
                iou_threshold: iou,
            });
            App.toast(res.message, 'success');
            this._startBatchPoll(res.task_id, res.total, '文件夹批量预测完成', function() {
                ImageNavigator._loadPage(1, true);
                App.refreshStats();
            });
        } catch (e) {
            App.toast('预测失败: ' + formatApiError(e), 'error');
            Store.set('predictions.predicting', false);
            this._render();
        }
    },

    async predictUnannotated() {
        if (!Store.get('models.loaded')) { App.toast('请先加载模型', 'warning'); return; }

        const conf = parseFloat(document.getElementById('conf-threshold')?.value || 0.25);
        const iou = parseFloat(document.getElementById('iou-threshold')?.value || 0.45);
        const op = document.getElementById('pred-operation')?.value || 'overwrite';

        Store.set('predictions.predicting', true);
        this._render();

        try {
            const res = await api.post('/predict/unannotated', {
                confidence_threshold: conf, iou_threshold: iou, operation: op,
            });
            const self = this;
            this._startBatchPoll(res.task_id, res.total, '批量预测完成', function() {
                App.refreshStats();
                const imgId = Store.get('currentImage.id');
                if (imgId) {
                    api.get(`/predictions/${imgId}`).then(d => {
                        Canvas.predBoxes = d.predictions || [];
                        Store.set('predictions.current', Canvas.predBoxes);
                        Canvas.render();
                        Canvas._updateAnnotationList();
                    }).catch(() => {});
                }
            });
        } catch (e) {
            App.toast(`启动批量预测失败: ${formatApiError(e)}`, 'error');
            Store.set('predictions.predicting', false);
            this._render();
        }
    },
};
