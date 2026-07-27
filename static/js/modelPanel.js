/**
 * Model selection, download, and load panel.
 */
const ModelPanel = {
    _deviceInfo: null,

    async init() {
        await this._loadModels();
        await this._loadDeviceInfo();
        Store.on('change:ui.activePanel', () => { this._loadDeviceInfo(); this._render(); });
        Store.on('change:models', () => this._render());
    },

    async _loadDeviceInfo() {
        try {
            this._deviceInfo = await api.get('/models/device-info');
        } catch { this._deviceInfo = { device: 'cpu', cuda_available: false }; }
    },

    async _loadModels() {
        try {
            const data = await api.get('/models');
            Store.set('models.available', data.models || []);
            if (data.loaded_model) {
                const loaded = data.models.find(m => m.name === data.loaded_model);
                Store.set('models.loaded', loaded || null);
            }
        } catch { /* ignore */ }
    },

    _render() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'model') return;

        const models = Store.get('models.available');
        const loaded = Store.get('models.loaded');
        const loading = Store.get('models.loading');

        container.innerHTML = `
            <div style="padding:8px 0;">
                <div class="form-group">
                    <label>下载预训练模型</label>
                    <div style="display:flex;gap:4px;">
                        <select id="model-download-select" style="flex:1;font-size:11px;padding:5px;">
                            <optgroup label="YOLOv8">
                                <option value="yolov8n.pt">YOLOv8 Nano</option>
                                <option value="yolov8s.pt">YOLOv8 Small</option>
                                <option value="yolov8m.pt">YOLOv8 Medium</option>
                                <option value="yolov8l.pt">YOLOv8 Large</option>
                                <option value="yolov8x.pt">YOLOv8 XLarge</option>
                            </optgroup>
                            <optgroup label="YOLOv11">
                                <option value="yolov11n.pt">YOLOv11 Nano</option>
                                <option value="yolov11s.pt">YOLOv11 Small</option>
                                <option value="yolov11m.pt">YOLOv11 Medium</option>
                                <option value="yolov11l.pt">YOLOv11 Large</option>
                                <option value="yolov11x.pt">YOLOv11 XLarge</option>
                            </optgroup>
                            <optgroup label="RT-DETR">
                                <option value="rtdetr-l.pt">RT-DETR Large</option>
                                <option value="rtdetr-x.pt">RT-DETR XLarge</option>
                            </optgroup>
                        </select>
                        <button class="btn btn-sm btn-primary" onclick="ModelPanel.downloadModel()" ${loading?'disabled':''}>
                            ${loading ? '<span class="loading-spinner"></span>' : '⬇️ 下载'}
                        </button>
                    </div>
                </div>
                <hr style="border-color:var(--border-color);margin:10px 0;">

                <!-- Device Info removed to simplify UI -->

                <!-- Local Model -->
                <div class="form-group">
                    <label>📁 本地模型</label>
                    <div style="display:flex;gap:4px;margin-bottom:4px;">
                        <input type="file" id="local-model-file" accept=".pt,.pth"
                            style="flex:1;font-size:11px;padding:4px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:4px;color:var(--text-primary);"
                            onchange="ModelPanel._onFileSelected(this)">
                        <button class="btn btn-sm btn-primary" id="btn-upload-model" onclick="ModelPanel.uploadLocal()" disabled>
                            ⬆️ 上传
                        </button>
                    </div>
                    <div style="display:flex;gap:4px;">
                        <button class="btn btn-sm" onclick="ModelPanel.scanLocalModels()" style="flex:1;">
                            🔍 扫描本地模型 (data/models/)
                        </button>
                    </div>
                </div>
                <hr style="border-color:var(--border-color);margin:10px 0;">
            </div>

            <h4 style="font-size:12px;margin-bottom:6px;">已安装模型</h4>
            ${models.length === 0
                ? '<div class="placeholder"><p>暂无模型</p><p class="placeholder-hint">请下载一个模型</p></div>'
                : models.map(m => {
                    const isLoaded = loaded && loaded.id === m.id;
                    return `<div class="model-card ${isLoaded ? 'active' : ''}" onclick="ModelPanel.loadModel(${m.id})">
                        <div class="model-name">${m.name}</div>
                        <div class="model-info">类型: ${m.model_type} | 类别: ${m.class_count} | 使用: ${m.times_used}次</div>
                        <span class="model-status ${isLoaded ? 'loaded' : 'not-loaded'}">
                            ${isLoaded ? '✅ 已加载' : '⏳ 未加载'}
                        </span>
                    </div>`;
                }).join('')}

            ${loaded ? `
                <div style="padding:8px 0;">
                    <button class="btn btn-sm" onclick="ModelPanel.unloadModel()" style="width:100%;">⏏️ 卸载模型</button>
                </div>
            ` : ''}
        `;
    },

    async downloadModel() {
        const sel = document.getElementById('model-download-select');
        const name = sel ? sel.value : 'yolov8n.pt';
        Store.set('models.loading', true);
        this._render();
        try {
            const result = await api.post('/models/download', { name });
            App.toast(`模型 ${result.name}: ${result.status}`, 'success');
            await this._loadModels();
        } catch (e) {
            App.toast(`下载失败: ${e.message}`, 'error');
        }
        Store.set('models.loading', false);
        this._render();
    },

    async loadModel(modelId) {
        Store.set('models.loading', true);
        this._render();
        try {
            // Let backend auto-detect best device (GPU if CUDA available, otherwise CPU)
            const device = this._deviceInfo && this._deviceInfo.cuda_available ? 'cuda' : 'cpu';
            const result = await api.post('/models/load', { model_id: modelId, device: device });
            const deviceIcon = result.device === 'cuda' ? '🎮' : '💻';
            App.toast('模型 ' + result.name + ' 已加载 (' + deviceIcon + ' ' + result.device + ', ' + result.class_count + ' 类)', 'success');
            await this._loadModels();
            // Auto import model's class names as labels
            await ClassManager.loadLabelsFromModel(result.name);
        } catch (e) {
            App.toast('加载失败: ' + e.message, 'error');
        }
        Store.set('models.loading', false);
        this._render();
    },

    async unloadModel() {
        try {
            await api.post('/models/unload');
            Store.set('models.loaded', null);
            App.toast('模型已卸载', 'info');
            this._render();
        } catch (e) { App.toast('卸载失败: ' + e.message, 'error'); }
    },

    _onFileSelected(input) {
        const btn = document.getElementById('btn-upload-model');
        if (btn) btn.disabled = !input.files || input.files.length === 0;
    },

    async uploadLocal() {
        const fileInput = document.getElementById('local-model-file');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            App.toast('请先选择一个 .pt 模型文件', 'warning');
            return;
        }
        const file = fileInput.files[0];
        if (!file.name.endsWith('.pt') && !file.name.endsWith('.pth')) {
            App.toast('只支持 .pt 或 .pth 模型文件', 'warning');
            return;
        }

        Store.set('models.loading', true);
        this._render();
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch('/api/v1/models/upload', { method: 'POST', body: formData });
            if (!res.ok) throw new Error((await res.json()).detail || 'Upload failed');
            const result = await res.json();
            App.toast('模型 ' + result.name + ' 上传成功 (' + formatSize(result.size_bytes) + ')', 'success');
            fileInput.value = '';
            document.getElementById('btn-upload-model').disabled = true;
            await this._loadModels();
        } catch (e) {
            App.toast('上传失败: ' + e.message, 'error');
        }
        Store.set('models.loading', false);
        this._render();
    },

    async scanLocalModels() {
        Store.set('models.loading', true);
        this._render();
        try {
            const result = await api.post('/models/scan-local');
            if (result.count === 0) {
                App.toast('未找到本地模型。请将 .pt 文件放入 data/models/ 目录', 'warning');
            } else {
                App.toast('找到 ' + result.count + ' 个本地模型: ' + result.found.join(', '), 'success');
            }
            await this._loadModels();
        } catch (e) {
            App.toast('扫描失败: ' + e.message, 'error');
        }
        Store.set('models.loading', false);
        this._render();
    },
};

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
