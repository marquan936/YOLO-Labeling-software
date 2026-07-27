/**
 * Comparison view — overlay / side-by-side toggle.
 */
const ComparisonView = {
    init() {
        Store.on('change:comparison.enabled', () => this._updateToggleBtn());
    },

    _updateToggleBtn() {
        const btn = document.getElementById('btn-toggle-comparison');
        if (!btn) return;
        const enabled = Store.get('comparison.enabled');
        btn.classList.toggle('active', enabled);
        btn.title = enabled ? '关闭对比模式' : '对比模式';
    },

    toggle() {
        Canvas.toggleComparison();
    },

    setMode(mode) {
        Store.set('comparison.mode', mode);
        Canvas.render();
        Canvas._updateAnnotationList();
    },

    toggleHuman(show) {
        Store.set('comparison.showHuman', show);
        Canvas.render();
        Canvas._updateAnnotationList();
    },

    toggleModel(show) {
        Store.set('comparison.showModel', show);
        Canvas.render();
        Canvas._updateAnnotationList();
    },
};
