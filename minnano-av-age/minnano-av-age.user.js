// ==UserScript==
// @name         みんなのAV：女演员拍摄时年龄 + 年龄筛选 + 合并分页 + sukebei 搜索
// @namespace    minnano-av-age
// @version      1.6.0
// @updateURL      https://raw.githubusercontent.com/cira93/userscripts/main/minnano-av-age/minnano-av-age.user.js
// @downloadURL    https://raw.githubusercontent.com/cira93/userscripts/main/minnano-av-age/minnano-av-age.user.js
// @description  在 minnano-av.com 的影片信息里显示女演员拍摄时的年龄（按发售日推算）；可按年龄段筛选并隐藏不符合的结果；每页合并多个原始页（比如 30 页变 15 页）；一键在新标签页用番号搜索 sukebei.nyaa.si
// @match        https://www.minnano-av.com/*
// @match        https://minnano-av.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 可调参数 ----------
  const SHOOT_LEAD_DAYS = 180;        // 拍摄一般早于发售 0~6 个月：生日落在这段时间里就显示年龄区间
  const CONCURRENCY = 2;              // 同时抓取的页面数，别太大，免得触发 Cloudflare
  const FETCH_GAP_MS = 150;           // 每次抓取之间稍微停一下
  const UNKNOWN_RETRY_DAYS = 7;       // 生日未知的女演员，7 天后再重新查一次
  const PRESETS = [                   // 面板里的快捷年龄段
    { label: '≤20', min: null, max: 20 },
    { label: '20–25', min: 20, max: 25 },
    { label: '25–30', min: 25, max: 30 },
    { label: '30–35', min: 30, max: 35 },
    { label: '35+', min: 35, max: null },
  ];

  // 番号转成 sukebei 能搜到的形式：OKS-202 → "OKS 202"，259LUXU-1234 → "259 LUXU 1234"，FC2 保持不拆
  const nyaaQuery = code => code
    .replace(/[-_\s]+/g, ' ')
    .replace(/([A-Za-z])(\d{2,})/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .trim();
  const nyaaUrl = code => 'https://sukebei.nyaa.si/?f=0&c=0_0&q=' + encodeURIComponent(nyaaQuery(code));

  // ---------- 存储（篡改猴里用 GM_*，否则退回 localStorage） ----------
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const store = {
    get(key, def) {
      try {
        if (hasGM) return GM_getValue(key, def);
        const raw = localStorage.getItem('mav_' + key);
        return raw == null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (hasGM) GM_setValue(key, val);
        else localStorage.setItem('mav_' + key, JSON.stringify(val));
      } catch (e) { /* ignore */ }
    },
  };
  const birthCache = store.get('birthdays', {});   // { "/actress123.html": { b: "2004-06-30" | "2004" | null, t: 时间戳 } }
  const codeCache = store.get('codes', {});         // { "/av123.html": "OKS-202" }
  let saveTimer = null;
  function saveCaches() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { store.set('birthdays', birthCache); store.set('codes', codeCache); }, 500);
  }

  // 筛选设置：min/max 为 null 表示不限
  const settings = Object.assign(
    { min: null, max: null, showUnknown: false, merge: 2, collapsed: false },
    store.get('settings', {})
  );
  const saveSettings = () => store.set('settings', settings);

  // ---------- 样式：浅色 / 深色两套变量，跟随网站当前主题 ----------
  const CSS = `
    :root {
      --mav-font: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif;
      --mav-bg: rgba(255,255,255,.97); --mav-fg: #1f2328; --mav-sub: #6b7280; --mav-line: #e5e7eb;
      --mav-field: #f3f4f6; --mav-field-line: #e2e4e9; --mav-hover: #eceef2;
      --mav-accent: #3b82f6; --mav-accent-soft: rgba(59,130,246,.12); --mav-accent-fg: #fff;
      --mav-chip-bg: #eef4ff; --mav-chip-fg: #2557c7; --mav-chip-line: #d3e0fb;
      --mav-unk-bg: #f3f4f6; --mav-unk-fg: #7b818c; --mav-unk-line: #e5e7eb;
      --mav-match-bg: #fff3d6; --mav-match-fg: #9a5b00; --mav-match-line: #f3cd6b;
      --mav-btn-bg: #ecfdf5; --mav-btn-fg: #047857; --mav-btn-line: #a7f3d0;
      --mav-shadow: 0 10px 30px rgba(15,23,42,.18), 0 2px 6px rgba(15,23,42,.08);
    }
    html.mav-dark {
      --mav-bg: rgba(27,28,33,.96); --mav-fg: #e7e9ee; --mav-sub: #9aa1ad; --mav-line: #33363e;
      --mav-field: #24262c; --mav-field-line: #383b44; --mav-hover: #2c2f36;
      --mav-accent: #4f8cff; --mav-accent-soft: rgba(79,140,255,.16); --mav-accent-fg: #fff;
      --mav-chip-bg: rgba(79,140,255,.13); --mav-chip-fg: #a9c3ff; --mav-chip-line: rgba(79,140,255,.32);
      --mav-unk-bg: rgba(255,255,255,.05); --mav-unk-fg: #8b919c; --mav-unk-line: rgba(255,255,255,.1);
      --mav-match-bg: rgba(245,158,11,.16); --mav-match-fg: #fbbf24; --mav-match-line: rgba(245,158,11,.45);
      --mav-btn-bg: rgba(16,185,129,.1); --mav-btn-fg: #6ee7b7; --mav-btn-line: rgba(16,185,129,.32);
      --mav-shadow: 0 12px 32px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3);
    }

    /* 网站给所有元素设了 line-height: 1，脚本自己的元素改回继承，免得文字被压扁 */
    .mav-age *, .mav-search-wrap *, .mav-box *, .mav-loader * { line-height: inherit; }

    /* 列表里的年龄标签和搜索按钮 */
    .mav-age { margin: 6px 0 0; font: 12px/1.7 var(--mav-font); }
    .mav-age-label { color: var(--mav-sub); margin-right: 2px; }
    .mav-chip { display: inline-block; max-width: 100%; box-sizing: border-box; margin: 0 4px 3px 0; padding: 1px 8px;
      border-radius: 10px; background: var(--mav-chip-bg); color: var(--mav-chip-fg); border: 1px solid var(--mav-chip-line);
      white-space: normal; overflow-wrap: anywhere; vertical-align: top; cursor: help; font: 12px/1.5 var(--mav-font); }
    .mav-chip-age { white-space: nowrap; }
    .mav-chip.mav-unknown, .mav-chip.mav-loading { background: var(--mav-unk-bg); color: var(--mav-unk-fg); border-color: var(--mav-unk-line); }
    .mav-chip.mav-match { background: var(--mav-match-bg); color: var(--mav-match-fg); border-color: var(--mav-match-line); font-weight: 600; }
    .mav-age-inline { margin-left: 6px; font: 12px var(--mav-font); color: var(--mav-chip-fg); cursor: help; }
    /* 三个搜索按钮拼成一条；所在栏太窄时自动换成短标签、去掉图标 */
    .mav-search-wrap { container-type: inline-size; width: 100%; margin: 4px 0 0; }
    .mav-search-wrap.mav-inline { display: inline-block; width: auto; container-type: normal; margin: 0 0 0 8px; vertical-align: middle; }
    .mav-search { display: flex; flex-wrap: nowrap; justify-content: center; }
    .mav-search-btn { display: inline-flex; align-items: center; justify-content: center; gap: 3px; padding: 0 8px;
      cursor: pointer; font: 11.5px/1.75 var(--mav-font); white-space: nowrap; margin-left: -1px;
      border: 1px solid var(--s-line); background: var(--s-bg); color: var(--s-fg); transition: filter .15s; }
    .mav-search-btn:first-child { border-radius: 999px 0 0 999px; margin-left: 0; padding-left: 10px; }
    .mav-search-btn:last-child { border-radius: 0 999px 999px 0; padding-right: 10px; }
    .mav-search-btn:hover { filter: brightness(1.25); position: relative; z-index: 1; }
    .mav-search-btn[disabled] { opacity: .6; cursor: wait; }
    .mav-search-btn svg { width: 11px; height: 11px; flex: none; }
    .mav-search-btn .mav-short { display: none; }
    @container (max-width: 230px) {
      .mav-search-btn { padding: 0 5px; font-size: 11px; }
      .mav-search-btn:first-child { padding-left: 8px; }
      .mav-search-btn:last-child { padding-right: 8px; }
      .mav-search-btn svg, .mav-search-btn .mav-full { display: none; }
      .mav-search-btn .mav-short { display: inline; }
    }
    .mav-s-nyaa   { --s-bg: var(--mav-btn-bg); --s-fg: var(--mav-btn-fg); --s-line: var(--mav-btn-line); }
    .mav-s-missav { --s-bg: #fdf2f8; --s-fg: #be185d; --s-line: #fbcfe8; }
    .mav-s-supjav { --s-bg: #fff7ed; --s-fg: #c2410c; --s-line: #fed7aa; }
    html.mav-dark .mav-s-missav { --s-bg: rgba(236,72,153,.1); --s-fg: #f9a8d4; --s-line: rgba(236,72,153,.35); }
    html.mav-dark .mav-s-supjav { --s-bg: rgba(249,115,22,.1); --s-fg: #fdba74; --s-line: rgba(249,115,22,.35); }
    .av-item.mav-hidden { display: none !important; }

    /* 右下角面板 */
    .mav-box { position: fixed; right: 18px; bottom: 90px; z-index: 99999; width: 268px; box-sizing: border-box;
      background: var(--mav-bg); color: var(--mav-fg); border: 1px solid var(--mav-line); border-radius: 14px;
      box-shadow: var(--mav-shadow); font: 13px/1.5 var(--mav-font); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
    .mav-box *, .mav-box *::before, .mav-box *::after { box-sizing: border-box; font-family: var(--mav-font); }
    .mav-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 10px 14px; cursor: pointer; user-select: none; }
    .mav-title { font-weight: 600; font-size: 13px; letter-spacing: .02em; }
    .mav-summary { flex: 1; min-width: 0; text-align: right; color: var(--mav-sub); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mav-chevron { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: var(--mav-sub);
      transition: transform .2s, background .15s; }
    .mav-head:hover .mav-chevron { background: var(--mav-hover); }
    .mav-box.mav-collapsed .mav-chevron { transform: rotate(180deg); }
    .mav-body { padding: 0 14px 12px; }
    .mav-box.mav-collapsed .mav-body { display: none; }

    .mav-range { display: flex; align-items: center; gap: 6px; }
    .mav-input { width: 64px; height: 30px; padding: 0 10px; border-radius: 8px; text-align: center;
      border: 1px solid var(--mav-field-line); background: var(--mav-field); color: var(--mav-fg);
      font-size: 13px; outline: none; transition: border-color .15s, box-shadow .15s; }
    .mav-input::placeholder { color: var(--mav-sub); opacity: .8; }
    .mav-input:focus { border-color: var(--mav-accent); box-shadow: 0 0 0 3px var(--mav-accent-soft); }
    .mav-range-sep, .mav-range-unit { color: var(--mav-sub); font-size: 12px; }
    .mav-text-btn { margin-left: auto; padding: 4px 6px; border: none; background: none; color: var(--mav-sub);
      font-size: 12px; cursor: pointer; border-radius: 6px; }
    .mav-text-btn:hover { background: var(--mav-hover); color: var(--mav-fg); }

    .mav-presets { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin: 10px 0 2px; }
    .mav-preset { padding: 2px 0; text-align: center; white-space: nowrap; border-radius: 999px; border: 1px solid var(--mav-field-line);
      background: transparent; color: var(--mav-fg); font-size: 12px; line-height: 1.6; cursor: pointer;
      transition: background .15s, border-color .15s, color .15s; }
    .mav-preset:hover { background: var(--mav-hover); }
    .mav-preset.mav-on { background: var(--mav-accent); border-color: var(--mav-accent); color: var(--mav-accent-fg); }

    .mav-divider { height: 1px; background: var(--mav-line); margin: 12px 0; }
    .mav-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
    .mav-row-label { font-size: 12.5px; }

    .mav-switch { position: relative; width: 34px; height: 20px; flex: none; border: none; border-radius: 999px;
      background: var(--mav-field-line); cursor: pointer; transition: background .2s; padding: 0; }
    .mav-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .2s; }
    .mav-switch.mav-on { background: var(--mav-accent); }
    .mav-switch.mav-on::after { transform: translateX(14px); }

    .mav-seg { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--mav-field); border: 1px solid var(--mav-field-line); }
    .mav-seg button { min-width: 26px; height: 24px; padding: 0 6px; border: none; border-radius: 6px; background: none;
      color: var(--mav-sub); font-size: 12px; cursor: pointer; transition: background .15s, color .15s; }
    .mav-seg button:hover { color: var(--mav-fg); }
    .mav-seg button.mav-on { background: var(--mav-accent); color: var(--mav-accent-fg); }

    .mav-foot { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
      margin-top: 12px; font-size: 12px; color: var(--mav-sub); }
    .mav-count b { color: var(--mav-fg); font-weight: 600; font-size: 13px; }
    .mav-progress { height: 3px; margin-top: 8px; border-radius: 999px; background: var(--mav-field-line); overflow: hidden; }
    .mav-progress > i { display: block; height: 100%; width: 0; background: var(--mav-accent); transition: width .3s; }
    .mav-progress.mav-idle { display: none; }

    .mav-loader { margin: 16px 0; padding: 10px; text-align: center; font: 13px var(--mav-font); color: var(--mav-sub);
      border: 1px dashed var(--mav-line); border-radius: 10px; }
    .mav-loader button { margin-left: 8px; padding: 2px 10px; cursor: pointer; border-radius: 6px;
      border: 1px solid var(--mav-field-line); background: var(--mav-field); color: var(--mav-fg); }
  `;
  if (typeof GM_addStyle === 'function') GM_addStyle(CSS);
  else { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); }

  // 看网站背景是深色还是浅色，给 <html> 加上 mav-dark
  function syncTheme() {
    const candidates = [document.body, document.documentElement, document.querySelector('.site_body')];
    let dark = true;
    for (const node of candidates) {
      if (!node) continue;
      const m = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
      if (!m) continue;
      const [r, g, b, a = 1] = m.map(Number);
      if (a < 0.5) continue;
      dark = (0.299 * r + 0.587 * g + 0.114 * b) < 140;
      break;
    }
    document.documentElement.classList.toggle('mav-dark', dark);
  }

  // ---------- 工具函数 ----------
  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    }
    if (children) for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function svg(path, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 14);
    s.setAttribute('height', size || 14);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2.2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    return s;
  }
  const ICON_SEARCH = 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-4-4';
  const ICON_CHEVRON = 'M6 9l6 6l6-6';

  function pathOf(href) {
    try { return new URL(href, location.href).pathname; } catch (e) { return null; }
  }

  // "2026-11-01" / "2026年11月 01日" → Date(UTC)
  function parseDate(text) {
    const m = /(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/.exec(text || '');
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }

  function fmt(d) { return d.toISOString().slice(0, 10); }

  function ageAt(birth, date) {
    let a = date.getUTCFullYear() - birth.getUTCFullYear();
    if (date.getUTCMonth() < birth.getUTCMonth() ||
        (date.getUTCMonth() === birth.getUTCMonth() && date.getUTCDate() < birth.getUTCDate())) a--;
    return a;
  }

  // 返回 { text, title, lo, hi }；lo/hi 为 null 表示未知
  function describeAge(birthStr, release) {
    if (!birthStr) return { text: '年龄未知', title: '女演员页面没有生年月日', lo: null, hi: null };
    if (!release) return { text: '发售日未知', title: '生日 ' + birthStr, lo: null, hi: null };
    if (/^\d{4}$/.test(birthStr)) {           // 只有出生年份
      const hi = release.getUTCFullYear() - +birthStr;
      return { text: `约${hi - 1}–${hi}岁`, title: `只知道出生年份 ${birthStr}；发售日 ${fmt(release)}`, lo: hi - 1, hi };
    }
    const birth = parseDate(birthStr);
    const hi = ageAt(birth, release);
    const lo = ageAt(birth, new Date(release.getTime() - SHOOT_LEAD_DAYS * 86400000));
    return {
      text: hi === lo ? `${hi}岁` : `${lo}–${hi}岁`,
      title: `生日 ${birthStr}，发售日 ${fmt(release)}；拍摄一般早于发售 0–6 个月，按此推算拍摄时年龄`,
      lo, hi,
    };
  }

  // ---------- 限流抓取 ----------
  let active = 0;
  const waiting = [];
  function limited(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        task().then(resolve, reject).finally(() => {
          setTimeout(() => {
            active--;
            const next = waiting.shift();
            if (next) next();
            scheduleStatus();
          }, FETCH_GAP_MS);
        });
      };
      if (active < CONCURRENCY) run(); else waiting.push(run);
    });
  }

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  function parseBirth(doc) {
    const label = [...doc.querySelectorAll('span, th, dt')].find(s => s.textContent.trim() === '生年月日');
    if (!label) return null;
    const text = (label.nextElementSibling || label.parentElement).textContent;
    let m = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(text);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = /(\d{4})年/.exec(text);
    return m ? m[1] : null;
  }

  function parseCode(doc) {
    const node = doc.querySelector('.product-code-copy');
    if (node) {
      const c = node.cloneNode(true);
      c.querySelectorAll('.copy-icon, .copy-feedback').forEach(x => x.remove());
      const t = c.textContent.replace(/📋/g, '').trim();
      if (t) return t;
    }
    const th = [...doc.querySelectorAll('td, th')].find(x => x.textContent.trim() === '品番');
    const v = th && th.nextElementSibling && th.nextElementSibling.textContent.replace(/📋|Copied!/g, '').trim();
    return v || null;
  }

  const birthInflight = new Map();
  function getBirth(actressPath) {
    const c = birthCache[actressPath];
    if (c && (c.b || Date.now() - c.t < UNKNOWN_RETRY_DAYS * 86400000)) return Promise.resolve(c.b);
    if (!birthInflight.has(actressPath)) {
      birthInflight.set(actressPath, limited(() => fetchDoc(actressPath)).then(doc => {
        const b = parseBirth(doc);
        birthCache[actressPath] = { b, t: Date.now() };
        saveCaches();
        return b;
      }).finally(() => birthInflight.delete(actressPath)));
    }
    return birthInflight.get(actressPath);
  }

  async function getCode(videoPath) {
    if (codeCache[videoPath]) return codeCache[videoPath];
    const code = parseCode(await fetchDoc(videoPath));
    if (code) { codeCache[videoPath] = code; saveCaches(); }
    return code;
  }

  // ---------- 搜索按钮：新标签页打开番号搜索 ----------
  const SEARCH_SITES = [
    { key: 'nyaa', label: 'sukebei', short: 'Nyaa', title: 'sukebei.nyaa.si', url: nyaaUrl },
    { key: 'missav', label: 'MissAV', short: 'Miss', title: 'missav.ws', url: code => 'https://missav.ws/search/' + encodeURIComponent(code) },
    { key: 'supjav', label: 'SupJav', short: 'Sup', title: 'supjav.com', url: code => 'https://supjav.com/?s=' + encodeURIComponent(code) },
  ];

  function makeSearchButton(site, videoPath, knownCode) {
    const label = el('span', { class: 'mav-full', text: site.label });
    const btn = el('button', { type: 'button', class: 'mav-search-btn mav-s-' + site.key, title: `在新标签页用番号搜索 ${site.title}` },
      [svg(ICON_SEARCH, 11), label, el('span', { class: 'mav-short', text: site.short })]);
    btn.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const code = knownCode || codeCache[videoPath];
      if (code) { window.open(site.url(code), '_blank', 'noopener'); return; }
      // 列表页还不知道番号：先同步开一个空白页（避免被拦截弹窗），取到番号后再跳转
      const win = window.open('about:blank', '_blank');
      btn.disabled = true;
      try {
        const c = await getCode(videoPath);
        if (!c) throw new Error('这部片子在 minnano-av 上没有品番');
        if (win) { win.opener = null; win.location.href = site.url(c); }
        else window.open(site.url(c), '_blank', 'noopener');
        label.textContent = site.label;
      } catch (err) {
        if (win) win.close();
        btn.title = '获取番号失败：' + (err && err.message || err);
        label.textContent = '重试';
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  function makeSearchGroup(videoPath, knownCode, inline) {
    return el('div', { class: 'mav-search-wrap' + (inline ? ' mav-inline' : '') }, [
      el('div', { class: 'mav-search' }, SEARCH_SITES.map(s => makeSearchButton(s, videoPath, knownCode))),
    ]);
  }

  // 返回 { chip, ready }；ready 解析为 { lo, hi }（未知时为 null）
  function makeChip(name, actressPath, release, inline) {
    const chip = el('span', { class: inline ? 'mav-age-inline' : 'mav-chip mav-loading', text: inline ? '（…）' : `${name} …` });
    const ready = getBirth(actressPath).then(b => {
      const d = describeAge(b, release);
      if (inline) chip.textContent = `（拍摄时 ${d.text}）`;
      else {                                   // 名字可以折行，年龄不拆开
        chip.textContent = '';
        chip.append(el('span', { text: name }), ' ', el('span', { class: 'mav-chip-age', text: d.text }));
      }
      chip.title = d.title;
      if (!inline) chip.className = 'mav-chip' + (d.lo == null ? ' mav-unknown' : '');
      return d.lo == null ? null : { lo: d.lo, hi: d.hi };
    }).catch(err => {
      chip.textContent = inline ? '（年龄获取失败）' : `${name} 获取失败`;
      chip.title = String(err && err.message || err);
      if (!inline) chip.className = 'mav-chip mav-unknown';
      return null;
    });
    return { chip, ready };
  }

  // ---------- 年龄筛选 ----------
  const filterActive = () => settings.min != null || settings.max != null;

  function rangeMatches(r) {
    const min = settings.min != null ? settings.min : -Infinity;
    const max = settings.max != null ? settings.max : Infinity;
    return r.hi >= min && r.lo <= max;        // 拍摄时年龄区间和筛选区间有重叠
  }

  function rangeText() {
    const { min, max } = settings;
    if (min != null && max != null) return `${min}–${max}岁`;
    if (min != null) return `≥${min}岁`;
    if (max != null) return `≤${max}岁`;
    return '不限年龄';
  }

  // item._mav = { chips: [{chip, range}], done: bool }
  function applyFilter(item) {
    const st = item._mav;
    if (!st) return;
    let show = true;
    if (filterActive()) {
      if (!st.done) show = false;              // 年龄还没查到，先藏起来
      else {
        const known = st.chips.filter(c => c.range);
        show = known.length ? known.some(c => rangeMatches(c.range)) : settings.showUnknown;
      }
    }
    item.classList.toggle('mav-hidden', !show);
    for (const c of st.chips) {
      c.chip.classList.toggle('mav-match', !!(filterActive() && c.range && rangeMatches(c.range)));
    }
  }

  function applyFilterAll() {
    document.querySelectorAll('.av-item').forEach(applyFilter);
    scheduleStatus();
  }

  // ---------- 列表页（搜索结果、作品列表等 .av-item） ----------
  function processListItem(item) {
    if (item.dataset.mavDone) return;
    item.dataset.mavDone = '1';
    const target = item.querySelector('.sub-details') || item.querySelector('.details') || item;
    const release = parseDate((item.querySelector('.release-date') || {}).textContent);
    const casts = [...item.querySelectorAll('.cast a')]
      .map(a => ({ name: a.textContent.trim(), path: pathOf(a.getAttribute('href')) }))
      .filter(c => c.path && /^\/actress\d+\.html$/.test(c.path));
    const line = el('div', { class: 'mav-age' }, [el('span', { class: 'mav-age-label', text: '拍摄时' })]);
    const st = { chips: [], done: false };
    item._mav = st;
    const readies = casts.map(c => {
      const { chip, ready } = makeChip(c.name, c.path, release, false);
      const entry = { chip, range: null };
      st.chips.push(entry);
      line.append(' ', chip);
      return ready.then(r => { entry.range = r; });
    });
    if (!casts.length) line.append(' ', el('span', { class: 'mav-chip mav-unknown', text: '无出演者信息' }));
    target.append(line);
    item._mavReady = Promise.all(readies).then(() => { st.done = true; applyFilter(item); scheduleStatus(); });
    applyFilter(item);

    const titleLink = item.querySelector('.ttl a, .jacket a');
    const videoPath = titleLink && pathOf(titleLink.getAttribute('href'));
    if (videoPath && /^\/av\d+\.html$/.test(videoPath)) target.append(makeSearchGroup(videoPath, null, false));
  }

  // ---------- 影片详情页（table.prof-table） ----------
  function processDetailPage() {
    const table = document.querySelector('table.prof-table');
    if (!table || table.dataset.mavDone) return;
    const rowOf = label => [...table.querySelectorAll('tr')].find(tr => tr.children[0] && tr.children[0].textContent.trim() === label);
    const codeRow = rowOf('品番');
    if (!codeRow) return;                      // 不是影片页（比如女演员页也用 prof-table）
    table.dataset.mavDone = '1';
    const dateRow = rowOf('発売日');
    const release = dateRow ? parseDate(dateRow.children[1].textContent) : null;
    const castRow = rowOf('出演者');
    if (castRow) {
      castRow.querySelectorAll('a').forEach(a => {
        const p = pathOf(a.getAttribute('href'));
        if (p && /^\/actress\d+\.html$/.test(p)) a.after(makeChip(a.textContent.trim(), p, release, true).chip);
      });
    }
    const code = parseCode(document);
    if (code) codeRow.children[1].append(makeSearchGroup(location.pathname, code, true));
  }

  // ---------- 合并分页：每页显示 N 个原始页的内容 ----------
  // 原始第 1~N 页合成新的第 1 页，第 N+1~2N 页合成第 2 页……分页条按新页码重画。
  const pager = { ok: false, list: null, note: null, orig: 1, last: 1, vpage: 1, vlast: 1, start: 1, end: 1, loading: 0, failed: [] };

  function pageParamOf(href) {
    try { const p = new URL(href, location.href).searchParams.get('page'); return p ? +p : null; } catch (e) { return null; }
  }

  // 生成原始第 p 页的地址（沿用分页链接里的查询参数，只改 page）
  function origPageUrl(p) {
    const u = new URL(pager.template, location.href);
    u.searchParams.set('page', String(p));
    return u.href;
  }

  function initMerge() {
    const pag = document.querySelector('.pagination .pagination') || document.querySelector('.pagination');
    pager.list = document.querySelector('.av-list-container');
    if (!pag || !pager.list) return;
    const links = [...pag.querySelectorAll('a')];
    const withPage = links.filter(a => pageParamOf(a.getAttribute('href')) != null);
    if (!withPage.length) return;               // 分页参数不是 page，不处理
    pager.template = withPage[0].getAttribute('href');
    pager.pag = pag;
    const cur = pag.querySelector('.current');
    pager.orig = (cur && +cur.textContent.trim()) || pageParamOf(location.href) || 1;
    pager.last = Math.max(pager.orig, ...withPage.map(a => pageParamOf(a.getAttribute('href'))));
    pager.ok = true;

    const n = Math.max(1, settings.merge | 0);
    pager.vpage = Math.floor((pager.orig - 1) / n) + 1;
    pager.vlast = Math.ceil(pager.last / n);
    pager.start = (pager.vpage - 1) * n + 1;
    pager.end = Math.min(pager.start + n - 1, pager.last);
    if (n > 1) {
      renderPagination();
      loadGroup();
    }
  }

  // 把同一组里的其它原始页抓下来，按顺序插到当前页内容的前后
  async function loadGroup() {
    const own = [...pager.list.querySelectorAll('.av-item')];
    const anchorFirst = own[0] || null;
    // 原始页号 → 占位节点：页号小于当前页的放在当前内容前面，大于的放后面，抓回来后原地替换，保证顺序
    const slots = {};
    for (let p = pager.start; p <= pager.end; p++) {
      if (p === pager.orig) continue;
      const slot = document.createComment('mav-page-' + p);
      if (p < pager.orig && anchorFirst) pager.list.insertBefore(slot, anchorFirst);
      else pager.list.append(slot);
      slots[p] = slot;
    }

    const pages = Object.keys(slots).map(Number);
    pager.loading = pages.length;
    pager.note = el('div', { class: 'mav-loader' });
    pager.list.after(pager.note);
    updateNote();
    await Promise.all(pages.map(async p => {
      try {
        const doc = await limited(() => fetchDoc(origPageUrl(p)));
        const items = [...doc.querySelectorAll('.av-list-container .av-item')].map(it => {
          const node = document.adoptNode(it);
          node.querySelectorAll('img[data-src]').forEach(img => { img.src = img.getAttribute('data-src'); img.classList.remove('lazy'); });
          return node;
        });
        slots[p].replaceWith(...items);
        items.forEach(processListItem);
      } catch (e) {
        pager.failed.push(p);
      } finally {
        pager.loading--;
        updateNote();
        scheduleStatus();
      }
    }));
  }

  function updateNote() {
    if (!pager.note) return;
    pager.note.textContent = '';
    if (pager.loading > 0) {
      pager.note.append(`正在合并原始第 ${pager.start}–${pager.end} 页…（还剩 ${pager.loading} 页）`);
    } else if (pager.failed.length) {
      pager.note.append(`原始第 ${pager.failed.sort((a, b) => a - b).join('、')} 页加载失败`,
        el('button', { type: 'button', text: '刷新重试', onclick: () => location.reload() }));
    } else {
      pager.note.remove();
      pager.note = null;
    }
  }

  // 按新页码重画分页条（沿用网站的 <a> / <span class="current"> 结构，样式不变）
  function renderPagination() {
    const n = Math.max(1, settings.merge | 0);
    const urlOfV = v => origPageUrl((v - 1) * n + 1);
    const pag = pager.pag;
    const v = pager.vpage, last = pager.vlast;
    pag.textContent = '';
    const add = (node) => { pag.append(node, ' '); };
    const link = (text, vp) => el('a', { href: urlOfV(vp), text });
    if (v > 1) { add(link('最初', 1)); add(link('前へ', v - 1)); }
    const from = Math.max(1, v - 2), to = Math.min(last, v + 2);
    if (from > 1) add(document.createTextNode('...'));
    for (let i = from; i <= to; i++) add(i === v ? el('span', { class: 'current', text: String(i) }) : link(String(i), i));
    if (to < last) add(document.createTextNode('...'));
    if (v < last) { add(link('次へ', v + 1)); add(link('最後', last)); }
  }

  // ---------- 控制面板 ----------
  const ui = {};
  let statusTimer = null;
  function scheduleStatus() {
    if (!ui.box || statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; renderStatus(); }, 200);
  }

  function renderStatus() {
    const items = [...document.querySelectorAll('.av-item')];
    const total = items.length;
    const shown = items.filter(i => !i.classList.contains('mav-hidden')).length;
    const pending = items.filter(i => i._mav && !i._mav.done).length + (pager.loading > 0 ? pager.loading * 30 : 0);

    ui.page.textContent = pager.ok
      ? `第 ${pager.vpage} / ${pager.vlast} 页` + (pager.start !== pager.end ? ` · 原 ${pager.start}–${pager.end}` : '')
      : '';
    ui.count.textContent = '';
    ui.count.append('显示 ', el('b', { text: String(shown) }), ` / ${total}`);
    const busy = pending > 0;
    ui.progress.classList.toggle('mav-idle', !busy);
    ui.bar.style.width = busy ? Math.round(100 * Math.max(0, total - pending) / Math.max(total, 1)) + '%' : '100%';
    ui.summary.textContent = `${rangeText()} · ${shown}/${total}` + (busy ? ' · 查询中' : '');

    ui.presets.forEach(({ btn, p }) => btn.classList.toggle('mav-on', p.min === settings.min && p.max === settings.max));
    ui.unk.classList.toggle('mav-on', settings.showUnknown);
    ui.unk.setAttribute('aria-checked', String(settings.showUnknown));
  }

  function buildPanel() {
    const numInput = (val, ph, aria) => {
      const i = el('input', { type: 'text', inputmode: 'numeric', maxlength: '2', class: 'mav-input', placeholder: ph, 'aria-label': aria });
      i.value = val == null ? '' : String(val);
      return i;
    };
    const minI = numInput(settings.min, '不限', '最小年龄');
    const maxI = numInput(settings.max, '不限', '最大年龄');

    const commit = () => {
      const v = s => { const n = parseInt(String(s).replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : null; };
      settings.min = v(minI.value);
      settings.max = v(maxI.value);
      saveSettings();
      applyFilterAll();
    };
    let t = null;
    const onType = () => { clearTimeout(t); t = setTimeout(commit, 300); };
    [minI, maxI].forEach(i => {
      i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, ''); onType(); });
      i.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); commit(); i.blur(); } });
    });
    const setRange = (min, max) => {
      minI.value = min == null ? '' : String(min);
      maxI.value = max == null ? '' : String(max);
      clearTimeout(t);
      commit();
    };

    ui.presets = PRESETS.map(p => {
      const btn = el('button', { type: 'button', class: 'mav-preset', text: p.label });
      btn.addEventListener('click', () => {
        const on = p.min === settings.min && p.max === settings.max;
        on ? setRange(null, null) : setRange(p.min, p.max);
      });
      return { btn, p };
    });

    ui.unk = el('button', { type: 'button', class: 'mav-switch', role: 'switch', 'aria-label': '也显示年龄未知的' });
    ui.unk.addEventListener('click', () => { settings.showUnknown = !settings.showUnknown; saveSettings(); applyFilterAll(); });

    const seg = el('div', { class: 'mav-seg', role: 'group', 'aria-label': '每页合并几个原始页' });
    for (let i = 1; i <= 5; i++) {
      const b = el('button', { type: 'button', text: String(i), title: i === 1 ? '不合并（网站原样）' : `每页显示 ${i} 个原始页` });
      if (i === settings.merge) b.classList.add('mav-on');
      b.addEventListener('click', () => {
        if (i === settings.merge) return;
        settings.merge = i;
        saveSettings();
        if (pager.ok) location.href = origPageUrl(Math.floor((pager.start - 1) / i) * i + 1);   // 跳到新分组里包含当前内容的那一页
        else seg.querySelectorAll('button').forEach(x => x.classList.toggle('mav-on', x === b));
      });
      seg.append(b);
    }

    ui.page = el('span');
    ui.count = el('span', { class: 'mav-count' });
    ui.bar = el('i');
    ui.progress = el('div', { class: 'mav-progress mav-idle' }, [ui.bar]);
    ui.summary = el('span', { class: 'mav-summary' });

    const head = el('div', { class: 'mav-head', title: '点击收起 / 展开' }, [
      el('span', { class: 'mav-title', text: '年龄筛选' }),
      ui.summary,
      el('span', { class: 'mav-chevron' }, [svg(ICON_CHEVRON, 16)]),
    ]);
    const body = el('div', { class: 'mav-body' }, [
      el('div', { class: 'mav-range' }, [
        minI, el('span', { class: 'mav-range-sep', text: '至' }), maxI, el('span', { class: 'mav-range-unit', text: '岁' }),
        el('button', { type: 'button', class: 'mav-text-btn', text: '清除', onclick: () => setRange(null, null) }),
      ]),
      el('div', { class: 'mav-presets' }, ui.presets.map(x => x.btn)),
      el('div', { class: 'mav-divider' }),
      el('div', { class: 'mav-row' }, [el('span', { class: 'mav-row-label', text: '显示年龄未知的' }), ui.unk]),
      el('div', { class: 'mav-row' }, [el('span', { class: 'mav-row-label', text: '每页合并原始页' }), seg]),
      el('div', { class: 'mav-foot' }, [ui.page, ui.count]),
      ui.progress,
    ]);
    ui.box = el('div', { class: 'mav-box' + (settings.collapsed ? ' mav-collapsed' : '') }, [head, body]);
    head.addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      saveSettings();
      ui.box.classList.toggle('mav-collapsed', settings.collapsed);
    });
    document.body.appendChild(ui.box);
    renderStatus();
  }

  // ---------- 启动 ----------
  function run() {
    syncTheme();
    document.querySelectorAll('.av-item').forEach(processListItem);
    processDetailPage();
  }

  run();
  if (document.querySelector('.av-item')) {
    initMerge();
    buildPanel();
  }
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; run(); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  // 网站切换浅色 / 深色时同步面板配色
  const themeObs = new MutationObserver(syncTheme);
  [document.documentElement, document.body].forEach(n => themeObs.observe(n, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] }));
})();
