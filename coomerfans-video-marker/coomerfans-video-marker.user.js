// ==UserScript==
// @name         CoomerFans 视频标记
// @namespace    local.codex.coomerfans
// @version      1.0.0
// @updateURL      https://raw.githubusercontent.com/cira93/userscripts/main/coomerfans-video-marker/coomerfans-video-marker.user.js
// @downloadURL    https://raw.githubusercontent.com/cira93/userscripts/main/coomerfans-video-marker/coomerfans-video-marker.user.js
// @description  在 CoomerFans 作者页标记每个帖子是否包含视频
// @match        https://coomerfans.com/u/*
// @run-at       document-idle
// @noframes
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      coomerfans.com
// ==/UserScript==

(() => {
  "use strict";

  const CONFIG = {
    listSelector: ".posts-list",
    cardSelector: ".post",
    postLinkSelector: 'a[href^="/p/"]',
    concurrency: 3,
    requestTimeoutMs: 20_000,
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    cacheStoreKey: "cfv-cache-v1"
  };

  const state = {
    running: false,
    filterVideosOnly: false,
    rescanTimer: null,
    rescanRequested: false
  };

  const STATUS = {
    pending: { text: "待检测", title: "等待检测", className: "cfv-pending" },
    checking: { text: "检测中…", title: "正在读取帖子详情", className: "cfv-checking" },
    video: { text: "▶ 有视频", title: "这个帖子包含视频", className: "cfv-video" },
    none: { text: "无视频", title: "这个帖子没有检测到视频", className: "cfv-none" },
    error: { text: "检查失败", title: "点击重试", className: "cfv-error" }
  };

  let cache = loadCache();

  GM_addStyle(`
    #cfv-toolbar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin: 0 0 16px;
      padding: 11px 14px;
      border: 1px solid rgba(128, 128, 128, 0.32);
      border-radius: 10px;
      background: rgba(30, 30, 34, 0.96);
      color: #f4f4f5;
      font: 600 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }

    .cfv-controls {
      display: flex;
      align-items: center;
      gap: 12px;
      white-space: nowrap;
    }

    .cfv-filter {
      cursor: pointer;
      font-weight: 500;
      user-select: none;
    }

    .cfv-filter input {
      accent-color: #22c55e;
    }

    #cfv-refresh {
      padding: 6px 10px;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.1);
      color: inherit;
      cursor: pointer;
      font: inherit;
    }

    #cfv-refresh:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.18);
    }

    #cfv-refresh:disabled {
      cursor: wait;
      opacity: 0.55;
    }

    .posts-list .post.cfv-enhanced {
      position: relative;
    }

    .cfv-video-badge {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 5;
      min-width: 72px;
      padding: 5px 9px;
      border: 1px solid transparent;
      border-radius: 999px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
      font: 700 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
      white-space: nowrap;
    }

    .cfv-video-badge:disabled {
      opacity: 1;
    }

    .cfv-pending,
    .cfv-checking {
      border-color: #60a5fa;
      background: #1e3a5f;
      color: #dbeafe;
    }

    .cfv-checking {
      animation: cfv-pulse 1.15s ease-in-out infinite alternate;
    }

    .cfv-video {
      border-color: #4ade80;
      background: #14532d;
      color: #dcfce7;
    }

    .cfv-none {
      border-color: #71717a;
      background: #3f3f46;
      color: #e4e4e7;
    }

    .cfv-error {
      border-color: #f87171;
      background: #7f1d1d;
      color: #fee2e2;
      cursor: pointer;
    }

    .posts-list .post.cfv-hidden {
      display: none !important;
    }

    @keyframes cfv-pulse {
      from { opacity: 0.62; }
      to { opacity: 1; }
    }

    @media (max-width: 640px) {
      #cfv-toolbar {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  `);

  function isAuthorPage() {
    return /^\/u\/[^/]+\/[^/]+(?:\/[^/]+)?\/?$/.test(location.pathname);
  }

  function loadCache() {
    try {
      const saved = GM_getValue(CONFIG.cacheStoreKey, {});
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  }

  function saveCache() {
    try {
      GM_setValue(CONFIG.cacheStoreKey, cache);
    } catch {
      // 缓存失败不影响当前页面的检测结果。
    }
  }

  function getPostPath(link) {
    try {
      const url = new URL(link.getAttribute("href"), location.origin);
      return url.origin === location.origin && /^\/p\//.test(url.pathname)
        ? url.pathname
        : null;
    } catch {
      return null;
    }
  }

  function ensureToolbar(list) {
    let toolbar = document.getElementById("cfv-toolbar");
    if (toolbar) {
      return toolbar;
    }

    toolbar = document.createElement("section");
    toolbar.id = "cfv-toolbar";
    toolbar.setAttribute("aria-label", "视频检测工具");

    const summary = document.createElement("div");
    summary.id = "cfv-summary";
    summary.setAttribute("aria-live", "polite");
    summary.textContent = "正在准备视频检测…";

    const controls = document.createElement("div");
    controls.className = "cfv-controls";

    const filterLabel = document.createElement("label");
    filterLabel.className = "cfv-filter";
    const filter = document.createElement("input");
    filter.type = "checkbox";
    filter.addEventListener("change", () => {
      state.filterVideosOnly = filter.checked;
      applyFilter();
    });
    filterLabel.append(filter, document.createTextNode(" 只看有视频"));

    const refresh = document.createElement("button");
    refresh.id = "cfv-refresh";
    refresh.type = "button";
    refresh.textContent = "重新检查";
    refresh.title = "清除本页缓存并重新读取所有帖子";
    refresh.addEventListener("click", () => {
      void inspectAll({ force: true });
    });

    controls.append(filterLabel, refresh);
    toolbar.append(summary, controls);
    list.parentNode.insertBefore(toolbar, list);
    return toolbar;
  }

  function ensureBadge(card) {
    let badge = card.querySelector(":scope > .cfv-video-badge");
    if (badge) {
      return badge;
    }

    card.classList.add("cfv-enhanced");
    badge = document.createElement("button");
    badge.type = "button";
    badge.className = "cfv-video-badge cfv-pending";
    badge.textContent = STATUS.pending.text;
    badge.title = STATUS.pending.title;
    badge.setAttribute("aria-label", "帖子视频状态：待检测");
    badge.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (card.dataset.cfvStatus === "error" && !state.running) {
        const entry = entryFromCard(card);
        if (entry) {
          void inspectEntries([entry], { force: true });
        }
      }
    });
    card.append(badge);
    return badge;
  }

  function entryFromCard(card) {
    const link =
      card.querySelector("a.view-post[href]") ||
      card.querySelector(CONFIG.postLinkSelector);
    if (!link) {
      return null;
    }

    const pathname = getPostPath(link);
    if (!pathname) {
      return null;
    }

    return {
      card,
      badge: ensureBadge(card),
      pathname,
      url: new URL(pathname, location.origin).href
    };
  }

  function collectEntries() {
    const list = document.querySelector(CONFIG.listSelector);
    if (!list) {
      return [];
    }

    const seen = new Set();
    const entries = [];
    for (const card of list.querySelectorAll(CONFIG.cardSelector)) {
      const entry = entryFromCard(card);
      if (entry && !seen.has(entry.pathname)) {
        seen.add(entry.pathname);
        entries.push(entry);
      }
    }
    return entries;
  }

  function setStatus(entry, statusName, detail = "") {
    const config = STATUS[statusName];
    entry.card.dataset.cfvStatus = statusName;
    entry.badge.className = `cfv-video-badge ${config.className}`;
    entry.badge.textContent = config.text;
    entry.badge.title = detail ? `${config.title}：${detail}` : config.title;
    entry.badge.setAttribute("aria-label", `帖子视频状态：${config.text}`);
    entry.badge.disabled = statusName !== "error";

    applyFilterToCard(entry.card);
    updateSummary();
  }

  function applyFilterToCard(card) {
    const shouldHide =
      state.filterVideosOnly && card.dataset.cfvStatus === "none";
    card.classList.toggle("cfv-hidden", shouldHide);
  }

  function applyFilter() {
    for (const entry of collectEntries()) {
      applyFilterToCard(entry.card);
    }
  }

  function updateSummary() {
    const summary = document.getElementById("cfv-summary");
    if (!summary) {
      return;
    }

    const entries = collectEntries();
    const counts = { video: 0, none: 0, error: 0, checking: 0, pending: 0 };
    for (const { card } of entries) {
      const status = card.dataset.cfvStatus || "pending";
      counts[status] = (counts[status] || 0) + 1;
    }

    const done = counts.video + counts.none + counts.error;
    summary.textContent =
      `视频检测：${done}/${entries.length}` +
      ` · 有 ${counts.video}` +
      ` · 无 ${counts.none}` +
      (counts.error ? ` · 失败 ${counts.error}` : "");

    const refresh = document.getElementById("cfv-refresh");
    if (refresh) {
      refresh.disabled = state.running;
    }
  }

  function detectVideo(doc) {
    if (
      doc.querySelector(
        ".player video source[src], " +
          ".player video source[data-src], " +
          ".player video[src], " +
          ".player video[data-src], " +
          "video.video-js source[src], " +
          "video.video-js source[data-src]"
      )
    ) {
      return true;
    }

    return Array.from(doc.querySelectorAll(".post-content a[href], .content a[href]")).some(
      (link) => {
        try {
          return /\.(?:mp4|m4v|webm|mov)$/i.test(new URL(link.href).pathname);
        } catch {
          return false;
        }
      }
    );
  }

  function fetchPostHtml(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { Accept: "text/html" },
        timeout: CONFIG.requestTimeoutMs,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          resolve(response.responseText);
        },
        ontimeout() {
          reject(new Error("请求超时"));
        },
        onerror() {
          reject(new Error("网络请求失败"));
        },
        onabort() {
          reject(new Error("请求被取消"));
        }
      });
    });
  }

  function isFreshCache(value) {
    return (
      value &&
      typeof value.hasVideo === "boolean" &&
      Number.isFinite(value.checkedAt) &&
      Date.now() - value.checkedAt < CONFIG.cacheTtlMs
    );
  }

  async function inspectOne(entry) {
    setStatus(entry, "checking");
    try {
      const html = await fetchPostHtml(entry.url);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const hasVideo = detectVideo(doc);
      setStatus(entry, hasVideo ? "video" : "none");
      cache[entry.pathname] = { hasVideo, checkedAt: Date.now() };
      saveCache();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      setStatus(entry, "error", detail);
    }
  }

  async function runQueue(entries) {
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < entries.length) {
        const entry = entries[nextIndex];
        nextIndex += 1;
        await inspectOne(entry);
      }
    };

    const workerCount = Math.min(CONFIG.concurrency, entries.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async function inspectEntries(entries, { force = false } = {}) {
    if (!entries.length || state.running) {
      return;
    }

    state.running = true;
    updateSummary();

    try {
      if (force) {
        for (const entry of entries) {
          delete cache[entry.pathname];
        }
        saveCache();
      }

      const pending = [];
      for (const entry of entries) {
        const saved = cache[entry.pathname];
        if (!force && isFreshCache(saved)) {
          setStatus(entry, saved.hasVideo ? "video" : "none");
        } else {
          setStatus(entry, "pending");
          pending.push(entry);
        }
      }
      await runQueue(pending);
    } finally {
      state.running = false;
      updateSummary();
      if (state.rescanRequested) {
        state.rescanRequested = false;
        void inspectAll();
      }
    }
  }

  async function inspectAll(options = {}) {
    const list = document.querySelector(CONFIG.listSelector);
    if (!list) {
      return;
    }
    if (state.running) {
      state.rescanRequested = true;
      return;
    }

    ensureToolbar(list);
    await inspectEntries(collectEntries(), options);
  }

  function watchForNewPosts() {
    const list = document.querySelector(CONFIG.listSelector);
    if (!list) {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) => mutation.addedNodes.length > 0)) {
        return;
      }
      clearTimeout(state.rescanTimer);
      state.rescanTimer = setTimeout(() => {
        void inspectAll();
      }, 500);
    });
    observer.observe(list, { childList: true });
  }

  if (isAuthorPage()) {
    void inspectAll();
    watchForNewPosts();
  }
})();
