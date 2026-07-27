/**
 * Image navigator — thumbnail grid with continuous scroll loading.
 */
const ImageNavigator = {
    _activeSplit: '',
    _activeStatus: '',
    _searchTerm: '',
    _allItems: [],
    _page: 1,
    _perPage: 30,
    _total: 0,
    _loading: false,
    _hasMore: true,
    _scrollEl: null,
    _searchTimer: null,

    init() {
        this._render();
        this._loadPage(1, true);
        Store.on('change:images', () => this._render());
        Store.on('change:currentImage.id', () => this._highlightActive());

        // Bind scroll for infinite loading
        const sidebarContent = document.getElementById('sidebar-content');
        this._scrollEl = sidebarContent;
        if (sidebarContent) {
            sidebarContent.addEventListener('scroll', () => this._onScroll());
        }
    },

    _onScroll() {
        if (this._loading || !this._hasMore) return;
        if (Store.get('ui.activePanel') !== 'navigator') return;
        const el = this._scrollEl;
        if (!el) return;
        // Load more when within 100px of bottom
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
            this._loadPage(this._page + 1, false);
        }
    },

    _render() {
        const container = document.getElementById('sidebar-content');
        if (Store.get('ui.activePanel') !== 'navigator') return;

        const items = this._allItems;
        const total = this._total;

        container.innerHTML =
            '<div class="filter-bar">' +
                '<input type="text" id="img-search" placeholder="搜索文件名..." value="' + escapeHtml(this._searchTerm) + '">' +
                '<select id="img-split-filter">' +
                    '<option value="">全部分组</option>' +
                    '<option value="train"' + (this._activeSplit === 'train' ? ' selected' : '') + '>训练集</option>' +
                    '<option value="val"' + (this._activeSplit === 'val' ? ' selected' : '') + '>验证集</option>' +
                '</select>' +
                '<select id="img-status-filter">' +
                    '<option value="">全部状态</option>' +
                    '<option value="pending"' + (this._activeStatus === 'pending' ? ' selected' : '') + '>待审核</option>' +
                    '<option value="reviewed"' + (this._activeStatus === 'reviewed' ? ' selected' : '') + '>已审核</option>' +
                '</select>' +
            '</div>' +
            '<div style="font-size:10px;color:var(--text-muted);padding:2px 0 4px;">共 ' + total + ' 张' +
                (this._hasMore && items.length < total ? ' (滚动加载更多)' : '') +
            '</div>' +
            '<div class="image-grid" id="image-grid">' +
                (this._loading && items.length === 0
                    ? '<div class="loading-spinner" style="margin:20px auto;"></div>'
                    : items.length === 0
                        ? '<div class="placeholder"><p>暂无图片</p><p class="placeholder-hint">将图片放入 data/images/ 后点击扫描</p></div>'
                        : items.map(img => this._thumbHtml(img)).join('')
                ) +
            '</div>' +
            (this._loading && items.length > 0
                ? '<div style="text-align:center;padding:8px;"><span class="loading-spinner"></span> 加载更多...</div>'
                : '') +
            (this._hasMore && !this._loading && items.length > 0
                ? '<div style="text-align:center;padding:8px;cursor:pointer;" onclick="ImageNavigator._loadPage(ImageNavigator._page+1,false)">📥 点击加载更多</div>'
                : '');

        // Bind filter events
        const searchEl = document.getElementById('img-search');
        if (searchEl) searchEl.addEventListener('input', (e) => this._onSearch(e.target.value));
        const splitEl = document.getElementById('img-split-filter');
        if (splitEl) splitEl.addEventListener('change', (e) => this._onFilter('split', e.target.value));
        const statusEl = document.getElementById('img-status-filter');
        if (statusEl) statusEl.addEventListener('change', (e) => this._onFilter('status', e.target.value));

        this._highlightActive();
    },

    _removeItem(imageId) {
        this._allItems = this._allItems.filter(function(item) { return item.id !== imageId; });
        this._total = Math.max(0, this._total - 1);
        Store.set('images.items', this._allItems, { silent: true });
        Store.set('images.total', this._total, { silent: true });
        this._render();
        this._highlightActive();
    },

    _thumbHtml(img) {
        const currentId = Store.get('currentImage.id');
        const active = img.id === currentId ? ' active' : '';
        const badges = [];
        if (img.has_annotation) badges.push('<span class="thumb-badge annotated">✋</span>');
        if (img.has_prediction) badges.push('<span class="thumb-badge predicted">🤖</span>');
        if (img.review_status === 'reviewed') badges.push('<span class="thumb-badge reviewed">✅</span>');
        else if (img.review_status === 'pending' || !img.review_status) badges.push('<span class="thumb-badge pending">⏳</span>');

        return '<div class="image-thumb' + active + '" data-id="' + img.id + '" onclick="ImageNavigator._selectImage(' + img.id + ')" title="' + escapeHtml(img.filename) + '">' +
            '<img src="' + imageUrl(img.id) + '" loading="lazy">' +
            '<div class="thumb-info">' +
                '<div class="thumb-name">' + escapeHtml(img.filename) + '</div>' +
                '<div class="thumb-badges">' + badges.join('') + '</div>' +
            '</div>' +
        '</div>';
    },

    _highlightActive() {
        const currentId = Store.get('currentImage.id');
        document.querySelectorAll('.image-thumb').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.id) === currentId);
        });
    },

    async _loadPage(page, reset) {
        if (this._loading) return;
        this._loading = true;
        if (reset) { this._page = 1; this._allItems = []; this._hasMore = true; }

        try {
            let url = '/images?page=' + page + '&per_page=' + this._perPage;
            if (this._activeSplit) url += '&split=' + this._activeSplit;
            if (this._activeStatus) url += '&status=' + this._activeStatus;
            if (this._searchTerm) url += '&search=' + encodeURIComponent(this._searchTerm);

            const data = await api.get(url);
            const newItems = data.images || [];

            if (reset) {
                this._allItems = newItems;
            } else {
                // Append, avoiding duplicates
                const existingIds = new Set(this._allItems.map(i => i.id));
                for (const item of newItems) {
                    if (!existingIds.has(item.id)) {
                        this._allItems.push(item);
                        existingIds.add(item.id);
                    }
                }
            }

            this._total = data.total || 0;
            this._page = page;
            this._hasMore = this._allItems.length < this._total;

            Store.set('images.items', this._allItems, { silent: true });
            Store.set('images.total', this._total, { silent: true });
        } catch (e) {
            App.toast('加载图片列表失败: ' + e.message, 'error');
        }

        this._loading = false;
        this._render();
    },

    _onSearch(term) {
        this._searchTerm = term;
        if (this._searchTimer) clearTimeout(this._searchTimer);
        var self = this;
        this._searchTimer = setTimeout(function() { self._loadPage(1, true); }, 300);
    },

    _onFilter(type, value) {
        if (type === 'split') this._activeSplit = value;
        if (type === 'status') this._activeStatus = value;
        this._loadPage(1, true);
    },

    _selectImage(id) {
        Store.set('currentImage.id', id);
    },
};
