/**
 * Observable state store — EventEmitter pattern.
 * All UI state flows through this store. Components subscribe to state changes.
 */
class StateStore {
    constructor() {
        this._state = {
            images: { items: [], total: 0, page: 1, perPage: 50, loading: false, error: null },
            currentImage: { id: null, metadata: null, loading: false },
            annotations: { human: [], model: [], saving: false, dirty: false },
            classes: { items: [], activeIdx: 0 },
            models: { available: [], loaded: null, loading: false },
            predictions: { current: [], batchTask: null, predicting: false },
            review: { total: 0, reviewed: 0, pending: 0, skipped: 0, annotated: 0, predicted: 0, pctComplete: 0 },
            comparison: { mode: 'overlay', showHuman: true, showModel: true, enabled: false },
            ui: { activePanel: 'navigator', activeTool: 'select', zoom: 1.0, panX: 0, panY: 0 },
            export: { taskId: null, status: null },
        };
        this._listeners = {};
        this._batchDepth = 0;
        this._pendingEmits = [];
    }

    get(path) {
        return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), this._state);
    }

    set(path, value, opts = {}) {
        const keys = path.split('.');
        const last = keys.pop();
        const target = keys.reduce((o, k) => {
            if (o[k] === undefined) o[k] = {};
            return o[k];
        }, this._state);
        const old = target[last];
        target[last] = value;
        if (!opts.silent) this._emit(path, value, old);
    }

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return () => {
            this._listeners[event] = this._listeners[event].filter(cb => cb !== fn);
        };
    }

    _emit(path, newVal, oldVal) {
        if (this._batchDepth > 0) { this._pendingEmits.push([path, newVal, oldVal]); return; }
        for (const [evt, cbs] of Object.entries(this._listeners)) {
            const evtPath = evt.replace('change:', '');
            if (path.startsWith(evtPath) || evtPath === '*' || path === evtPath) {
                for (const cb of cbs) cb(newVal, oldVal, path);
            }
        }
    }

    batch(fn) {
        this._batchDepth++;
        try { fn(); } finally {
            this._batchDepth--;
            if (this._batchDepth === 0) {
                const emits = [...new Set(this._pendingEmits.map(e => e[0]))];
                this._pendingEmits = [];
                for (const path of emits) this._emit(path, this.get(path), undefined);
            }
        }
    }
}

// Singleton
const Store = new StateStore();
