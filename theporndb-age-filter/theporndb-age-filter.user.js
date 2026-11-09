// ==UserScript==
// @name         ThePornDB 拍摄当时年龄筛选
// @namespace    https://theporndb.net/
// @version      0.5.1
// @updateURL      https://raw.githubusercontent.com/cira93/userscripts/main/theporndb-age-filter/theporndb-age-filter.user.js
// @downloadURL    https://raw.githubusercontent.com/cira93/userscripts/main/theporndb-age-filter/theporndb-age-filter.user.js
// @description  在 ThePornDB 的系列/片商/列表页按拍摄当时年龄筛选，并支持自动换页筛选、Yandex 搜索按钮始终显示、可拖动面板
// @match        https://theporndb.net/*
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CACHE_KEY = 'tpdb_performer_birthday_cache_v1';
  const CACHE_CLEANUP_KEY = 'tpdb_performer_birthday_cache_cleanup_v1';
  const SETTINGS_KEY = 'tpdb_age_filter_settings_v1';

  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
  const MAX_CACHE_SIZE = 2000;
  const FETCH_CONCURRENCY = 12;

  const performerPromiseCache = new Map();

  const state = {
    busy: false,
    active: false,
    collapsed: false,
    timer: null,
    pageDirty: false,
    runStatus: 'idle',
    progressText: '',
    prefetchStatus: '未启动',
    prefetchBusy: false,
    lastPrefetchUrl: '',
    lastSummary: '',
    lastVisible: null,
    lastHidden: null
  };

  let listObserver = null;
  let lastListSignature = '';
  let persistentCache = loadPersistentCache();
  let settings = loadSettings();
  let cacheSaveTimer = null;
  let stateRenderTimer = null;
  let dragState = null;

  const css = `
    #tpdb-age-filter {
      position: fixed;
      top: 80px;
      left: calc(100vw - 290px);
      z-index: 99999;
      width: 270px;
      border-radius: 10px;
      background: rgba(20, 20, 20, 0.94);
      color: #fff;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      font-size: 13px;
      backdrop-filter: blur(6px);
      overflow: hidden;
      user-select: none;
    }
    #tpdb-age-filter * {
      box-sizing: border-box;
    }
    #tpdb-age-filter .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
      cursor: move;
    }
    #tpdb-age-filter .head-left {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }
    #tpdb-age-filter .head h3 {
      margin: 0;
      font-size: 14px;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #tpdb-age-filter .head-sub {
      margin-top: 2px;
      font-size: 11px;
      color: #bdbdbd;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #tpdb-age-filter .head-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-shrink: 0;
    }
    #tpdb-age-filter .body {
      padding: 10px;
    }
    #tpdb-age-filter.collapsed {
      width: 168px;
    }
    #tpdb-age-filter.collapsed .body {
      display: none;
    }
    #tpdb-age-filter .row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }
    #tpdb-age-filter .row.tight {
      gap: 6px;
    }
    #tpdb-age-filter input,
    #tpdb-age-filter select,
    #tpdb-age-filter button {
      width: 100%;
      padding: 7px 8px;
      border: 1px solid #555;
      border-radius: 6px;
      background: #2a2a2a;
      color: #fff;
      font-size: 12px;
    }
    #tpdb-age-filter button {
      cursor: pointer;
    }
    #tpdb-age-filter button:hover {
      background: #3a3a3a;
    }
    #tpdb-age-filter .mini-btn {
      width: auto;
      min-width: 44px;
      padding: 4px 7px;
      font-size: 11px;
    }
    #tpdb-age-filter label {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 6px 0;
      font-size: 12px;
    }
    #tpdb-age-filter input[type="checkbox"] {
      appearance: auto !important;
      -webkit-appearance: checkbox !important;
      width: 16px !important;
      height: 16px !important;
      margin: 0;
      flex: 0 0 auto;
      accent-color: #38bdf8;
      background: initial !important;
      border: initial !important;
      box-shadow: none !important;
      padding: 0 !important;
    }
    #tpdb-age-filter .check-state {
      margin-left: auto;
      font-size: 11px;
      color: #9dd7ff;
      flex-shrink: 0;
    }
    #tpdb-age-filter .section-title {
      margin: 2px 0 8px;
      font-size: 11px;
      color: #bdbdbd;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    #tpdb-age-filter .status {
      color: #cfcfcf;
      line-height: 1.45;
      min-height: 92px;
      white-space: pre-line;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 8px;
      user-select: text;
    }
    .tpdb-age-hidden {
      display: none !important;
    }
    .tpdb-yandex-btn {
      position: absolute;
      right: 6px;
      bottom: 6px;
      z-index: 40;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 5px 8px;
      font-size: 11px;
      line-height: 1;
      color: #fff;
      background: rgba(34, 34, 34, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 6px;
      text-decoration: none;
      backdrop-filter: blur(4px);
    }
    .tpdb-yandex-btn:hover {
      background: rgba(58, 58, 58, 0.92);
    }
  `;

  if (typeof GM_addStyle === 'function') {
    GM_addStyle(css);
  } else {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $$(sel, root = document) {
    return [...root.querySelectorAll(sel)];
  }

  function absUrl(url) {
    return new URL(url, location.origin).href;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function loadPersistentCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function loadSettings() {
    const defaults = {
      autoFilterOnPageChange: true,
      prefetchNextPage: true,
      panelLeft: null,
      panelTop: 80,
      collapsed: false
    };

    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...(parsed && typeof parsed === 'object' ? parsed : {})
      };
    } catch {
      return defaults;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }

  function scheduleCacheSave() {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(() => {
      cacheSaveTimer = null;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(persistentCache));
      } catch {}
    }, 300);
  }

  function flushCacheSave() {
    if (cacheSaveTimer) {
      clearTimeout(cacheSaveTimer);
      cacheSaveTimer = null;
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(persistentCache));
    } catch {}
  }

  function cleanupPersistentCache(force = false) {
    const now = Date.now();
    const lastCleanup = Number(localStorage.getItem(CACHE_CLEANUP_KEY) || 0);

    if (!force && now - lastCleanup < CLEANUP_INTERVAL_MS) return;

    const entries = Object.entries(persistentCache).filter(([, value]) => {
      return value && typeof value.ts === 'number' && now - value.ts < CACHE_TTL_MS;
    });

    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    persistentCache = Object.fromEntries(entries.slice(0, MAX_CACHE_SIZE));
    scheduleCacheSave();

    try {
      localStorage.setItem(CACHE_CLEANUP_KEY, String(now));
    } catch {}
  }

  function getCachedBirthday(url) {
    const item = persistentCache[url];
    if (!item) return { hit: false, birthday: null };
    if (typeof item.ts !== 'number') return { hit: false, birthday: null };
    if (Date.now() - item.ts >= CACHE_TTL_MS) return { hit: false, birthday: null };
    return {
      hit: true,
      birthday: typeof item.birthday === 'string' ? item.birthday : null
    };
  }

  function setCachedBirthday(url, birthday) {
    persistentCache[url] = {
      birthday: birthday || null,
      ts: Date.now()
    };
    scheduleCacheSave();
  }

  function parseFlexibleDate(value) {
    if (!value || typeof value !== 'string') return null;
    const s = value.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00`);
    if (/^\d{4}-\d{2}$/.test(s)) return new Date(`${s}-01T00:00:00`);
    if (/^\d{4}$/.test(s)) return new Date(`${s}-01-01T00:00:00`);

    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  function calcAgeAtDate(birthday, sceneDate) {
    const birth = parseFlexibleDate(birthday);
    const scene = parseFlexibleDate(sceneDate);
    if (!birth || !scene) return null;
    if (scene < birth) return null;

    let age = scene.getFullYear() - birth.getFullYear();
    const monthDiff = scene.getMonth() - birth.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && scene.getDate() < birth.getDate())) {
      age--;
    }

    return age >= 0 ? age : null;
  }

  async function fetchPerformerBirthday(url) {
    url = absUrl(url);

    const cached = getCachedBirthday(url);
    if (cached.hit) return cached.birthday;

    if (performerPromiseCache.has(url)) return performerPromiseCache.get(url);

    const promise = (async () => {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        setCachedBirthday(url, null);
        return null;
      }

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const script = $('script[data-page="app"]', doc);

      if (!script || !script.textContent) {
        setCachedBirthday(url, null);
        return null;
      }

      let page;
      try {
        page = JSON.parse(script.textContent);
      } catch {
        setCachedBirthday(url, null);
        return null;
      }

      const performer = page?.props?.performer;
      const birthday = performer?.birthday || null;
      setCachedBirthday(url, birthday);
      return birthday;
    })().catch(() => {
      setCachedBirthday(url, null);
      return null;
    }).finally(() => {
      performerPromiseCache.delete(url);
    });

    performerPromiseCache.set(url, promise);
    return promise;
  }

  function getCards() {
    return $$('.w-scene-card');
  }

  function getSceneUrl(card) {
    const a = $('h2 a[href], a[href*="/scenes/"], a[href*="/movies/"], a[href*="/jav/"]', card);
    return a ? absUrl(a.getAttribute('href')) : '';
  }

  function getSceneTitle(card) {
    const a = $('h2 a[href]', card);
    if (!a) return '';
    return (a.getAttribute('title') || a.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getSceneSiteName(card) {
    const siteLink = $('a[href^="/sites/"]', card);
    if (!siteLink) return '';
    return (siteLink.getAttribute('title') || siteLink.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getPerformerNames(card) {
    return [...new Set(
      $$('a[href*="/performers/"]', card)
        .map(a => (a.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    )];
  }

  function normalizeSearchToken(text) {
    return String(text || '')
      .replace(/[|[\]{}()<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractLikelySceneCode(title) {
    const normalized = normalizeSearchToken(title).toUpperCase();
    const patterns = [
      /\b[A-Z]{2,8}-\d{2,6}\b/,
      /\b[A-Z]{2,8}\d{2,6}\b/,
      /\b\d{2,6}[A-Z]{2,8}\b/
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) return match[0];
    }
    return '';
  }

  function buildYandexQuery(card) {
    const title = normalizeSearchToken(getSceneTitle(card));
    const siteName = normalizeSearchToken(getSceneSiteName(card));
    const performerNames = getPerformerNames(card).slice(0, 2).map(normalizeSearchToken).filter(Boolean);
    const sceneCode = extractLikelySceneCode(title);

    const parts = [];

    if (sceneCode) {
      parts.push(`"${sceneCode}"`);
      if (siteName) parts.push(siteName);
      if (performerNames[0]) parts.push(performerNames[0]);
    } else {
      if (title) parts.push(title);
      if (siteName) parts.push(siteName);
      if (performerNames[0]) parts.push(performerNames[0]);
      if (performerNames[1]) parts.push(performerNames[1]);
      if (title && title.split(/\s+/).length >= 6) {
        const shortened = title.split(/\s+/).slice(0, 6).join(' ');
        parts.length = 0;
        parts.push(shortened);
        if (siteName) parts.push(siteName);
        if (performerNames[0]) parts.push(performerNames[0]);
      }
    }

    return parts.join(' ').trim();
  }

  function updateCheckboxStateText() {
    const unknown = $('#tpdb-age-unknown');
    const auto = $('#tpdb-age-auto');
    const prefetch = $('#tpdb-age-prefetch');
    const unknownState = $('#tpdb-age-unknown-state');
    const autoState = $('#tpdb-age-auto-state');
    const prefetchState = $('#tpdb-age-prefetch-state');

    if (unknown && unknownState) {
      unknownState.textContent = unknown.checked ? '开启' : '关闭';
    }
    if (auto && autoState) {
      autoState.textContent = auto.checked ? '开启' : '关闭';
    }
    if (prefetch && prefetchState) {
      prefetchState.textContent = prefetch.checked ? '开启' : '关闭';
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function getNextPageUrl() {
    const direct = $('a[rel="next"][href]');
    if (direct) return absUrl(direct.getAttribute('href'));

    const anchors = $$('a[href]').filter(isElementVisible);
    const currentUrl = new URL(location.href);

    const labeled = anchors.find(a => {
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const aria = (a.getAttribute('aria-label') || '').trim().toLowerCase();
      const title = (a.getAttribute('title') || '').trim().toLowerCase();
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) return false;
      return text === 'next' || text === '>' || text === '›' || text === '»' ||
        aria.includes('next') || aria.includes('下一') || title.includes('next') || title.includes('下一');
    });
    if (labeled) return absUrl(labeled.getAttribute('href'));

    const candidates = anchors
      .map(a => {
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('javascript:') || href.startsWith('#')) return null;
        let url;
        try {
          url = new URL(href, location.href);
        } catch {
          return null;
        }
        if (url.pathname !== currentUrl.pathname) return null;
        if (url.search === currentUrl.search) return null;
        return { el: a, url };
      })
      .filter(Boolean);

    const keys = ['page', 'scenes_page', 'movies_page', 'jav_page'];
    let best = null;
    for (const candidate of candidates) {
      for (const key of keys) {
        const currentPage = Number(currentUrl.searchParams.get(key) || '1');
        const nextPage = Number(candidate.url.searchParams.get(key) || '');
        if (Number.isFinite(nextPage) && nextPage === currentPage + 1) {
          if (!best || candidate.url.href.length < best.url.href.length) {
            best = candidate;
          }
        }
      }
    }
    return best ? best.url.href : '';
  }

  async function prefetchNextPage() {
    if (!settings.prefetchNextPage || state.prefetchBusy) return;

    const nextUrl = getNextPageUrl();
    if (!nextUrl) {
      state.prefetchStatus = '未找到下一页';
      scheduleStateRender(true);
      return;
    }

    if (state.lastPrefetchUrl === nextUrl) {
      state.prefetchStatus = '下一页已预缓存';
      scheduleStateRender(true);
      return;
    }

    state.prefetchBusy = true;
    state.prefetchStatus = '正在预缓存下一页...';
    scheduleStateRender(true);

    try {
      const res = await fetch(nextUrl, { credentials: 'include' });
      if (!res.ok) {
        state.prefetchStatus = `下一页预缓存失败 (${res.status})`;
        return;
      }

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const performerUrls = [...new Set(
        [...doc.querySelectorAll('.w-scene-card a[href*="/performers/"]')]
          .map(a => a.getAttribute('href'))
          .filter(Boolean)
          .map(href => absUrl(href))
      )];

      if (!performerUrls.length) {
        state.lastPrefetchUrl = nextUrl;
        state.prefetchStatus = '下一页没有可预缓存演员';
        return;
      }

      let done = 0;
      await mapLimit(performerUrls, Math.min(FETCH_CONCURRENCY, 8), async (url) => {
        await fetchPerformerBirthday(url);
        done++;
        state.prefetchStatus = `预缓存下一页 ${done}/${performerUrls.length}`;
        scheduleStateRender();
      });

      state.lastPrefetchUrl = nextUrl;
      state.prefetchStatus = `下一页已预缓存 ${performerUrls.length} 个演员`;
    } catch {
      state.prefetchStatus = '下一页预缓存失败';
    } finally {
      state.prefetchBusy = false;
      scheduleStateRender(true);
    }
  }

  function getPerformerLinks(card) {
    return [...new Set(
      $$('a[href*="/performers/"]', card)
        .map(a => a.getAttribute('href'))
        .filter(Boolean)
        .map(absUrl)
    )];
  }

  function getSceneDateFromCard(card) {
    const text = card.textContent.replace(/\s+/g, ' ').trim();
    const match = text.match(/\b\d{4}(?:-\d{2}(?:-\d{2})?)?\b/);
    return match ? match[0] : null;
  }

  function inRange(age, min, max) {
    if (!Number.isFinite(age)) return false;
    if (min !== null && age < min) return false;
    if (max !== null && age > max) return false;
    return true;
  }

  async function mapLimit(items, limit, fn) {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        await fn(items[current], current);
      }
    });
    await Promise.all(workers);
  }

  function getListSignature() {
    const cards = getCards();
    const head = cards.slice(0, 5).map(getSceneUrl).join('|');
    return `${location.href}::${cards.length}::${head}`;
  }

  function pauseObserver() {
    if (listObserver) listObserver.disconnect();
  }

  function resumeObserver() {
    if (!listObserver) return;
    listObserver.observe(document.body, { childList: true, subtree: true });
  }

  function removeAllYandexButtons() {
    $$('.tpdb-yandex-btn').forEach(el => el.remove());
  }

  function showAllCards() {
    getCards().forEach(card => card.classList.remove('tpdb-age-hidden'));
    ensureAllYandexButtons();
  }

  function ensureYandexButton(card) {
    if (!card) return;
    if ($('.tpdb-yandex-btn', card)) return;

    const title = getSceneTitle(card);
    if (!title) return;
    const query = buildYandexQuery(card);
    if (!query) return;

    const button = document.createElement('a');
    button.className = 'tpdb-yandex-btn';
    button.href = `https://yandex.com/search/?text=${encodeURIComponent(query)}`;
    button.target = '_blank';
    button.rel = 'noopener noreferrer';
    button.textContent = 'Yandex';
    button.title = `在 Yandex 搜索: ${query}`;

    card.appendChild(button);
  }

  function ensureAllYandexButtons() {
    getCards().forEach(card => ensureYandexButton(card));
  }

  function updateYandexButtons(patchList) {
    for (const [card] of patchList) {
      if (!$('.tpdb-yandex-btn', card)) {
        ensureYandexButton(card);
      }
    }
  }

  function describeFilterState() {
    const min = num($('#tpdb-age-min')?.value);
    const max = num($('#tpdb-age-max')?.value);
    const mode = $('#tpdb-age-mode')?.value || 'any';

    if (min === null && max === null) return '未设置';

    const left = min === null ? '?' : String(min);
    const right = max === null ? '?' : String(max);
    const modeText = mode === 'all' ? '全部演员命中' : '任一演员命中';
    return `${left}-${right} 岁 / ${modeText}`;
  }

  function getRunStatusText() {
    if (state.runStatus === 'filtering') return '筛选中';
    if (state.runStatus === 'done') return '已完成';
    if (state.pageDirty && !settings.autoFilterOnPageChange && state.active) return '页面已变化，等待手动筛选';
    return '空闲';
  }

  function scheduleStateRender(force = false) {
    if (force) {
      if (stateRenderTimer) clearTimeout(stateRenderTimer);
      stateRenderTimer = null;
      renderStateBox();
      return;
    }

    if (stateRenderTimer) return;
    stateRenderTimer = setTimeout(() => {
      stateRenderTimer = null;
      renderStateBox();
    }, 120);
  }

  function renderStateBox() {
    const box = $('#tpdb-age-status');
    const headSub = $('#tpdb-head-sub');
    const autoToggle = $('#tpdb-age-auto');
    const prefetchToggle = $('#tpdb-age-prefetch');
    if (!box) return;

    if (autoToggle) autoToggle.checked = !!settings.autoFilterOnPageChange;
    if (prefetchToggle) prefetchToggle.checked = !!settings.prefetchNextPage;
    if (headSub) headSub.textContent = `自动换页: ${settings.autoFilterOnPageChange ? '开' : '关'}`;
    updateCheckboxStateText();

    const lines = [
      `运行状态: ${getRunStatusText()}`,
      `当前条件: ${describeFilterState()}`,
      `换页自动筛选: ${settings.autoFilterOnPageChange ? '开启' : '关闭'}`,
      `下一页预缓存: ${settings.prefetchNextPage ? '开启' : '关闭'}`,
      `预缓存状态: ${state.prefetchStatus}`,
      `生日缓存: ${Object.keys(persistentCache).length} 条`
    ];

    if (state.progressText) lines.push(`当前进度: ${state.progressText}`);
    if (state.lastSummary) lines.push(`上次结果: ${state.lastSummary}`);
    if (state.pageDirty && !settings.autoFilterOnPageChange && state.active) {
      lines.push('提示: 页面内容已变化，需要手动点“应用筛选”。');
    }

    box.textContent = lines.join('\n');
  }

  function setPanelPosition(left, top) {
    const panel = $('#tpdb-age-filter');
    if (!panel) return;

    const width = panel.offsetWidth || 270;
    const height = panel.offsetHeight || 160;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - height - 8);

    const safeLeft = clamp(left, 8, maxLeft);
    const safeTop = clamp(top, 8, maxTop);

    panel.style.left = `${safeLeft}px`;
    panel.style.top = `${safeTop}px`;

    settings.panelLeft = safeLeft;
    settings.panelTop = safeTop;
    saveSettings();
  }

  function applySavedPanelPosition() {
    const panel = $('#tpdb-age-filter');
    if (!panel) return;

    const defaultLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 20);
    const left = Number.isFinite(settings.panelLeft) ? settings.panelLeft : defaultLeft;
    const top = Number.isFinite(settings.panelTop) ? settings.panelTop : 80;
    setPanelPosition(left, top);
  }

  function onDragStart(event) {
    const panel = $('#tpdb-age-filter');
    const head = $('#tpdb-age-head');
    if (!panel || !head) return;

    if (event.button !== 0) return;
    if (event.target.closest('button, input, select, label')) return;

    const rect = panel.getBoundingClientRect();
    dragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    event.preventDefault();
  }

  function onDragMove(event) {
    if (!dragState) return;
    setPanelPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  }

  function onDragEnd() {
    dragState = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  }

  async function applyFilter() {
    if (state.busy) return;

    state.busy = true;
    state.runStatus = 'filtering';
    state.progressText = '';
    state.pageDirty = false;
    scheduleStateRender(true);
    pauseObserver();

    try {
      const cards = getCards();
      if (!cards.length) {
        state.runStatus = 'idle';
        state.progressText = '当前页没找到可筛选的场景卡。';
        scheduleStateRender(true);
        return;
      }

      const min = num($('#tpdb-age-min')?.value);
      const max = num($('#tpdb-age-max')?.value);
      const mode = $('#tpdb-age-mode')?.value || 'any';
      const keepUnknown = $('#tpdb-age-unknown')?.checked ?? true;

      state.active = min !== null || max !== null;

      if (!state.active) {
        showAllCards();
        state.runStatus = 'idle';
        state.progressText = '';
        state.lastSummary = `显示 ${cards.length}，隐藏 0`;
        state.lastVisible = cards.length;
        state.lastHidden = 0;
        lastListSignature = getListSignature();
        scheduleStateRender(true);
        return;
      }

      const jobs = cards.map(card => ({
        card,
        sceneDate: getSceneDateFromCard(card),
        performerUrls: getPerformerLinks(card)
      }));

      const allPerformerUrls = [...new Set(jobs.flatMap(x => x.performerUrls))];
      let done = 0;
      state.progressText = `读取演员生日 0/${allPerformerUrls.length}`;
      scheduleStateRender(true);

      await mapLimit(allPerformerUrls, FETCH_CONCURRENCY, async (url) => {
        await fetchPerformerBirthday(url);
        done++;
        state.progressText = `读取演员生日 ${done}/${allPerformerUrls.length}`;
        scheduleStateRender();
      });

      const patchList = [];
      let visible = 0;
      let hidden = 0;

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];

        const agesAtScene = await Promise.all(
          job.performerUrls.map(async (url) => {
            const birthday = await fetchPerformerBirthday(url);
            return calcAgeAtDate(birthday, job.sceneDate);
          })
        );

        const known = agesAtScene.filter(Number.isFinite);

        let show = true;
        if (!job.sceneDate || !known.length) {
          show = keepUnknown;
        } else if (mode === 'all') {
          show =
            known.every(age => inRange(age, min, max)) &&
            (keepUnknown || known.length === job.performerUrls.length);
        } else {
          show = known.some(age => inRange(age, min, max));
        }

        patchList.push([job.card, show]);
        if (show) visible++;
        else hidden++;
      }

      await new Promise(resolve => requestAnimationFrame(resolve));

      for (const [card, show] of patchList) {
        card.classList.toggle('tpdb-age-hidden', !show);
      }
      updateYandexButtons(patchList);

      state.runStatus = 'done';
      state.progressText = '';
      state.lastVisible = visible;
      state.lastHidden = hidden;
      state.lastSummary = `显示 ${visible}，隐藏 ${hidden}`;
      lastListSignature = getListSignature();
      scheduleStateRender(true);
      setTimeout(() => {
        prefetchNextPage();
      }, 300);
    } finally {
      state.busy = false;
      setTimeout(() => {
        lastListSignature = getListSignature();
        resumeObserver();
      }, 0);
    }
  }

  function resetFilter() {
    pauseObserver();

    try {
      $('#tpdb-age-min').value = '';
      $('#tpdb-age-max').value = '';
      $('#tpdb-age-mode').value = 'any';
      $('#tpdb-age-unknown').checked = true;

      state.active = false;
      state.pageDirty = false;
      state.runStatus = 'idle';
      state.progressText = '';
      state.lastSummary = '已重置';
      showAllCards();

      lastListSignature = getListSignature();
      updateCheckboxStateText();
      scheduleStateRender(true);
    } finally {
      setTimeout(() => {
        lastListSignature = getListSignature();
        resumeObserver();
      }, 0);
    }
  }

  function toggleCollapse() {
    const panel = $('#tpdb-age-filter');
    const btn = $('#tpdb-age-toggle');
    if (!panel || !btn) return;

    state.collapsed = !state.collapsed;
    settings.collapsed = state.collapsed;
    panel.classList.toggle('collapsed', state.collapsed);
    btn.textContent = state.collapsed ? '展开' : '收起';
    saveSettings();

    setTimeout(() => {
      applySavedPanelPosition();
    }, 0);
  }

  function onAutoFilterToggle(event) {
    settings.autoFilterOnPageChange = !!event.target.checked;
    saveSettings();
    updateCheckboxStateText();
    scheduleStateRender(true);

    if (settings.autoFilterOnPageChange && state.pageDirty && state.active && !state.busy) {
      applyFilter();
    }
  }

  function onPrefetchToggle(event) {
    settings.prefetchNextPage = !!event.target.checked;
    saveSettings();
    updateCheckboxStateText();
    if (!settings.prefetchNextPage) {
      state.prefetchBusy = false;
      state.prefetchStatus = '已关闭';
    } else {
      state.prefetchStatus = '等待筛选完成后预缓存';
      if (state.runStatus === 'done' && state.active && !state.busy) {
        prefetchNextPage();
      }
    }
    scheduleStateRender(true);
  }

  function ensurePanel() {
    if ($('#tpdb-age-filter')) return;

    const panel = document.createElement('div');
    panel.id = 'tpdb-age-filter';
    panel.innerHTML = `
      <div class="head" id="tpdb-age-head">
        <div class="head-left">
          <h3>拍摄当时年龄筛选</h3>
          <div class="head-sub" id="tpdb-head-sub">自动换页: ${settings.autoFilterOnPageChange ? '开' : '关'}</div>
        </div>
        <div class="head-actions">
          <button id="tpdb-age-toggle" class="mini-btn" type="button">${settings.collapsed ? '展开' : '收起'}</button>
        </div>
      </div>
      <div class="body">
        <div class="section-title">筛选条件</div>
        <div class="row">
          <input id="tpdb-age-min" type="number" min="18" placeholder="最小年龄">
          <input id="tpdb-age-max" type="number" min="18" placeholder="最大年龄">
        </div>
        <div class="row">
          <select id="tpdb-age-mode">
            <option value="any">任一演员命中</option>
            <option value="all">全部演员命中</option>
          </select>
        </div>
        <label><input id="tpdb-age-unknown" type="checkbox" checked> 年龄未知时保留 <span id="tpdb-age-unknown-state" class="check-state">开启</span></label>

        <div class="section-title">行为设置</div>
        <label><input id="tpdb-age-auto" type="checkbox" ${settings.autoFilterOnPageChange ? 'checked' : ''}> 换页后自动重新筛选 <span id="tpdb-age-auto-state" class="check-state">${settings.autoFilterOnPageChange ? '开启' : '关闭'}</span></label>
        <label><input id="tpdb-age-prefetch" type="checkbox" ${settings.prefetchNextPage ? 'checked' : ''}> 自动预缓存下一页 <span id="tpdb-age-prefetch-state" class="check-state">${settings.prefetchNextPage ? '开启' : '关闭'}</span></label>

        <div class="row tight">
          <button id="tpdb-age-apply" type="button">应用筛选</button>
          <button id="tpdb-age-reset" type="button">重置</button>
        </div>

        <div class="section-title">当前状态</div>
        <div id="tpdb-age-status" class="status">初始化中...</div>
      </div>
    `;

    document.body.appendChild(panel);

    state.collapsed = !!settings.collapsed;
    panel.classList.toggle('collapsed', state.collapsed);

    $('#tpdb-age-apply').addEventListener('click', applyFilter);
    $('#tpdb-age-reset').addEventListener('click', resetFilter);
    $('#tpdb-age-toggle').addEventListener('click', toggleCollapse);
    $('#tpdb-age-auto').addEventListener('change', onAutoFilterToggle);
    $('#tpdb-age-prefetch').addEventListener('change', onPrefetchToggle);
    $('#tpdb-age-unknown').addEventListener('change', updateCheckboxStateText);
    $('#tpdb-age-head').addEventListener('mousedown', onDragStart);

    applySavedPanelPosition();
    scheduleStateRender(true);
  }

  function scheduleReapply() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      ensurePanel();
      if (state.busy) return;

      const sig = getListSignature();
      if (sig === lastListSignature) return;

      lastListSignature = sig;

      ensureAllYandexButtons();

      if (state.active) {
        if (settings.autoFilterOnPageChange) {
          applyFilter();
        } else {
          state.pageDirty = true;
          state.runStatus = 'idle';
          state.progressText = '';
          scheduleStateRender(true);
        }
      } else {
        scheduleStateRender(true);
      }
    }, 500);
  }

  function init() {
    cleanupPersistentCache(false);
    ensurePanel();
    ensureAllYandexButtons();

    lastListSignature = getListSignature();
    listObserver = new MutationObserver(scheduleReapply);
    resumeObserver();

    window.addEventListener('resize', () => {
      applySavedPanelPosition();
    });

    window.addEventListener('beforeunload', flushCacheSave, { once: true });
  }

  init();
})();
