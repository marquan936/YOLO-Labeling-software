/**
 * Export panel.
 */
const ExportPanel = {
    init() {
        Store.on('change:ui.activePanel', () => this._render());
        Store.on('change:export', () => this._render());
    },

    _render() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'export') return;

        const exp = Store.get('export');

        container.innerHTML = `
            <div style="padding:8px 0;">
                <h4 style="font-size:12px;margin-bottom:8px;">导出 YOLO 格式数据集</h4>

                <div class="form-group">
                    <label>数据来源</label>
                    <select id="export-source">
                        <option value="all">全部标注</option>
                        <option value="reviewed">仅已审核</option>
                        <option value="human">仅人工标注</option>
                        <option value="model">仅模型预测</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>数据集划分</label>
                    <select id="export-split">
                        <option value="all">全部</option>
                        <option value="train">仅训练集</option>
                        <option value="val">仅验证集</option>
                    </select>
                </div>

                <button class="btn btn-primary" onclick="ExportPanel.doExport()" style="width:100%;margin-bottom:8px;">
                    📦 导出 ZIP
                </button>

                ${exp.taskId ? `
                    <div style="padding:8px;background:rgba(102,187,106,0.1);border-radius:4px;">
                        <div style="font-size:12px;color:var(--success);">✅ 导出准备就绪</div>
                        <a href="${API_BASE}/export/download/${exp.taskId}" class="btn btn-sm btn-success"
                            style="display:block;margin-top:6px;text-align:center;">
                            ⬇️ 下载 annotations_${exp.taskId}.zip
                        </a>
                    </div>
                ` : ''}

                <hr style="border-color:var(--border-color);margin:12px 0;">

                <h4 style="font-size:12px;margin-bottom:6px;">YOLO 数据集结构说明</h4>
                <div style="font-size:11px;color:var(--text-muted);line-height:1.6;">
                    导出后 ZIP 包含：<br>
                    ├── images/ (图片文件)<br>
                    ├── labels/ (YOLO .txt 标注)<br>
                    └── data.yaml (数据集配置)
                </div>
            </div>
        `;
    },

    async doExport() {
        const source = document.getElementById('export-source')?.value || 'all';
        const split = document.getElementById('export-split')?.value || 'all';

        try {
            const res = await api.post('/export', { source, split });
            Store.set('export', { taskId: res.task_id, status: 'ready' });
            this._render();
            App.toast('导出完成，点击下载', 'success');
        } catch (e) {
            App.toast(`导出失败: ${e.message}`, 'error');
        }
    },
};
