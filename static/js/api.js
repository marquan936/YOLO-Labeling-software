/**
 * HTTP API client.
 */
const API_BASE = '/api/v1';

class ApiError extends Error {
    constructor(status, body, url) {
        super(`API ${status}: ${url}`);
        this.status = status;
        this.body = body;
        this.url = url;
    }
}

async function request(method, path, body = null, opts = {}) {
    const url = `${API_BASE}${path}`;
    const cfg = { method, headers: {} };

    if (body !== null && !(body instanceof FormData)) {
        cfg.headers['Content-Type'] = 'application/json';
        cfg.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
        cfg.body = body;
    }

    if (opts.signal) cfg.signal = opts.signal;

    let res;
    try {
        res = await fetch(url, cfg);
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new ApiError(0, { detail: 'Network error — server may be down' }, url);
    }

    if (!res.ok) {
        let errBody;
        try { errBody = await res.json(); } catch { errBody = { detail: res.statusText }; }
        throw new ApiError(res.status, errBody, url);
    }

    if (opts.blob) return res.blob();
    if (opts.text) return res.text();
    const ct = res.headers.get('content-type');
    if (ct && ct.includes('application/json')) return res.json();
    return res;
}

const api = {
    get: (p, o) => request('GET', p, null, o),
    post: (p, b, o) => request('POST', p, b, o),
    put: (p, b, o) => request('PUT', p, b, o),
    patch: (p, b, o) => request('PATCH', p, b, o),
    del: (p, o) => request('DELETE', p, null, o),
};

function imageUrl(id) { return `${API_BASE}/images/${id}/file?t=${Date.now()}`; }

function formatApiError(e) {
    if (!(e instanceof ApiError)) return e.message || String(e);
    const d = e.body?.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return d.map(x => x.msg || JSON.stringify(x)).join('; ');
    if (d && typeof d === 'object') return JSON.stringify(d);
    return e.message;
}

async function pollTask(taskId, onProgress, interval = 1000, prefix = '/predict/task/', timeout = 300000) {
    const startTime = Date.now();
    while (true) {
        if (Date.now() - startTime > timeout) {
            throw new ApiError(0, { detail: 'Task polling timed out after ' + (timeout / 1000) + 's' }, prefix + taskId);
        }
        const r = await api.get(`${prefix}${taskId}`);
        if (onProgress) onProgress(r);
        if (r.status === 'completed' || r.status === 'failed') return r;
        await new Promise(res => setTimeout(res, interval));
    }
}
