/**
 * Settings panel — theme, annotation defaults, shortcuts, display.
 */
const SettingsPanel = {
    themes: [],
    currentThemeId: 'dark',

    async init() {
        Store.on('change:ui.activePanel', () => this._render());
        try {
            const td = await api.get('/settings/themes');
            this.themes = td.themes || [];
        } catch { this.themes = []; }
    },

    async _render() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'settings') return;

        let settings;
        try { settings = await api.get('/settings'); } catch { settings = {}; }
        const a = settings.annotation || {};
        const au = settings.auto_save || {};
        const d = settings.display || {};
        const p = settings.polygon || {};

        container.innerHTML = `
        <div style="padding:4px 0;">
            <!-- Theme -->
            <div class="settings-section">
                <h4>🎨 主题配色</h4>
                <div class="theme-preset-list" id="theme-presets">
                    ${this.themes.map(t => `
                        <div class="theme-preset ${t.id === this.currentThemeId ? 'active' : ''}"
                            onclick="SettingsPanel.applyTheme('${t.id}')">
                            <div class="theme-swatch">
                                <span style="background:${t.colors.accent}"></span>
                                <span style="background:${t.colors.bg_secondary}"></span>
                                <span style="background:${t.colors.text_primary}"></span>
                                <span style="background:${t.colors.border}"></span>
                            </div>
                            <span>${t.name}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="form-row" style="margin-top:8px;">
                    <div class="form-group">
                        <label>强调色</label>
                        <input type="color" value="${settings.theme_colors?.accent || '#4fc3f7'}"
                            onchange="SettingsPanel._updateColor('accent', this.value)">
                    </div>
                    <div class="form-group">
                        <label>背景色</label>
                        <input type="color" value="${settings.theme_colors?.bg_primary || '#1a1a2e'}"
                            onchange="SettingsPanel._updateColor('bg_primary', this.value)">
                    </div>
                </div>
            </div>

            <!-- Annotation Settings -->
            <div class="settings-section">
                <h4>✏️ 标注设置</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label>默认透明度</label>
                        <input type="range" min="5" max="100" value="${(a.default_opacity||0.3)*100}"
                            oninput="document.getElementById('set-opacity-val').textContent=this.value+'%'">
                        <span id="set-opacity-val" style="font-size:10px;color:var(--text-muted);">${(a.default_opacity||0.3)*100}%</span>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>边框宽度</label>
                        <input type="number" min="1" max="8" value="${a.box_border_width||2}" id="set-border-width" style="width:70px;">
                    </div>
                    <div class="form-group">
                        <label>最小框尺寸(px)</label>
                        <input type="number" min="1" max="20" value="${a.min_box_size||3}" id="set-min-box" style="width:70px;">
                    </div>
                </div>
                <label class="form-check">
                    <input type="checkbox" ${a.show_labels !== false ? 'checked' : ''} id="set-show-labels"> 显示标签名
                </label>
                <label class="form-check">
                    <input type="checkbox" ${a.auto_show_label_dropdown !== false ? 'checked' : ''} id="set-auto-dropdown"> 标注后弹出标签选择
                </label>
            </div>

            <!-- Polygon Settings -->
            <div class="settings-section">
                <h4>🔷 多边形设置</h4>
                <div class="form-row">
                    <div class="form-group">
                        <label>默认透明度</label>
                        <input type="range" min="5" max="100" value="${(p.default_opacity||0.35)*100}"
                            oninput="document.getElementById('set-poly-opacity-val').textContent=this.value+'%'">
                        <span id="set-poly-opacity-val" style="font-size:10px;color:var(--text-muted);">${(p.default_opacity||0.35)*100}%</span>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>边框宽度</label>
                        <input type="number" min="1" max="6" value="${p.border_width||2}" id="set-poly-border" style="width:70px;">
                    </div>
                    <div class="form-group">
                        <label>顶点半径</label>
                        <input type="number" min="1" max="10" value="${p.vertex_radius||4}" id="set-vertex-radius" style="width:70px;">
                    </div>
                </div>
            </div>

            <!-- Auto-save -->
            <div class="settings-section">
                <h4>💾 自动保存</h4>
                <label class="form-check">
                    <input type="checkbox" ${au.enabled !== false ? 'checked' : ''} id="set-auto-save"> 启用自动保存
                </label>
                <div class="form-group">
                    <label>保存间隔 (秒)</label>
                    <input type="number" min="10" max="300" value="${au.interval_seconds||30}" id="set-save-interval" style="width:80px;">
                </div>
            </div>

            <!-- Display -->
            <div class="settings-section">
                <h4>🖥️ 显示设置</h4>
                <label class="form-check">
                    <input type="checkbox" ${d.show_grid !== false ? 'checked' : ''} id="set-show-grid"> 显示背景网格
                </label>
            </div>

            <!-- Keyboard Shortcuts Reference -->
            <div class="settings-section">
                <h4>⌨️ 快捷键参考</h4>
                <div class="shortcut-row"><span>选择工具</span><kbd>S</kbd></div>
                <div class="shortcut-row"><span>矩形绘制</span><kbd>R</kbd></div>
                <div class="shortcut-row"><span>多边形绘制</span><kbd>P</kbd></div>
                <div class="shortcut-row"><span>平移画布</span><kbd>H</kbd></div>
                <div class="shortcut-row"><span>删除选中</span><kbd>Delete</kbd></div>
                <div class="shortcut-row"><span>取消绘制</span><kbd>Esc</kbd></div>
                <div class="shortcut-row"><span>保存标注</span><kbd>Ctrl+S</kbd></div>
                <div class="shortcut-row"><span>前/后图片</span><kbd>← →</kbd></div>
                <div class="shortcut-row"><span>看原图</span><kbd>\`</kbd></div>
                <div class="shortcut-row"><span>撤销标注</span><kbd>Ctrl+Z</kbd></div>
            </div>

            <!-- Save button -->
            <button class="btn btn-primary" onclick="SettingsPanel._saveAll()" style="width:100%;margin:10px 0;">
                💾 保存设置
            </button>
        </div>`;
    },

    applyTheme(themeId) {
        this.currentThemeId = themeId;
        const theme = this.themes.find(t => t.id === themeId);
        if (!theme) return;
        const c = theme.colors;
        const root = document.documentElement;
        for (const [key, val] of Object.entries(c)) {
            root.style.setProperty('--' + key.replace(/_/g, '-'), val);
            if (key === 'accent') root.style.setProperty('--accent-rgb', hexToRgbStr(val));
        }
        App.toast('主题已切换: ' + theme.name, 'info');
        this._render();
    },

    _updateColor(key, val) {
        const prop = key === 'accent' ? '--accent' : '--' + key.replace(/_/g, '-');
        document.documentElement.style.setProperty(prop, val);
        if (key === 'accent') document.documentElement.style.setProperty('--accent-rgb', hexToRgbStr(val));
    },

    async _saveAll() {
        const settings = {
            theme: this.currentThemeId,
            theme_colors: {
                accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
                bg_primary: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
                bg_secondary: getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim(),
                text_primary: getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim(),
            },
            annotation: {
                default_opacity: parseFloat(document.getElementById('set-opacity-val')?.textContent || '30') / 100,
                box_border_width: parseInt(document.getElementById('set-border-width')?.value || 2),
                min_box_size: parseInt(document.getElementById('set-min-box')?.value || 3),
                show_labels: document.getElementById('set-show-labels')?.checked ?? true,
                auto_show_label_dropdown: document.getElementById('set-auto-dropdown')?.checked ?? true,
            },
            auto_save: {
                enabled: document.getElementById('set-auto-save')?.checked ?? true,
                interval_seconds: parseInt(document.getElementById('set-save-interval')?.value || 30),
            },
            display: {
                show_grid: document.getElementById('set-show-grid')?.checked ?? true,
            },
            polygon: {
                default_opacity: parseFloat(document.getElementById('set-poly-opacity-val')?.textContent || '35') / 100,
                border_width: parseInt(document.getElementById('set-poly-border')?.value || 2),
                vertex_radius: parseInt(document.getElementById('set-vertex-radius')?.value || 4),
            },
        };

        try {
            await api.put('/settings', { settings });
            Canvas.settings = settings;
            Canvas.opacity = settings.annotation.default_opacity;
            const os = document.getElementById('opacity-slider');
            if (os) { os.value = Math.round(Canvas.opacity * 100); document.getElementById('opacity-val').textContent = os.value + '%'; }
            Canvas.showLabelDropdown = settings.annotation.auto_show_label_dropdown;
            App.toast('设置已保存', 'success');
            App._setupAutoSave();
        } catch (e) { App.toast('保存设置失败: ' + e.message, 'error'); }
    },
};

function hexToRgbStr(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
}
