// ==UserScript==
// @name         视频伪全屏（无动画、无提示）
// @namespace    local.video.pseudo-fullscreen
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/cira93/userscripts/main/video-pseudo-fullscreen/video-pseudo-fullscreen.user.js
// @downloadURL  https://raw.githubusercontent.com/cira93/userscripts/main/video-pseudo-fullscreen/video-pseudo-fullscreen.user.js
// @description  把 YouTube / Bilibili 播放器的"全屏"改成铺满浏览器窗口，不调用浏览器真全屏，因此没有 macOS 全屏动画，也没有"按 Esc 退出全屏"提示。按住 Option(Alt) 再点全屏按钮可使用真全屏。
// @match        https://www.youtube.com/*
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// ==/UserScript==

(() => {
  'use strict';

  const W = window;
  const D = W.document;
  const EP = W.Element.prototype;
  const DP = W.Document.prototype;

  const real = {
    request: EP.requestFullscreen,
    webkitRequest: EP.webkitRequestFullscreen,
    exit: DP.exitFullscreen,
    webkitExit: DP.webkitExitFullscreen,
    get: (name) => Object.getOwnPropertyDescriptor(DP, name)?.get,
  };
  const realGetters = {};
  for (const n of ['fullscreenElement', 'webkitFullscreenElement', 'webkitCurrentFullScreenElement', 'fullscreen', 'webkitIsFullScreen']) {
    realGetters[n] = real.get(n);
  }

  let current = null;          // element in pseudo-fullscreen
  let ancestors = [];
  let wantReal = false;        // Option/Alt held on the triggering input

  // ---------- styles ----------
  const css = `
    html.__pfs-on, html.__pfs-on body { overflow: hidden !important; }
    .__pfs-el {
      position: fixed !important; inset: 0 !important;
      width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important;
      min-width: 0 !important; min-height: 0 !important;
      margin: 0 !important; padding: 0 !important; border: 0 !important; border-radius: 0 !important;
      z-index: 2147483647 !important; background: #000 !important; transform: none !important;
    }
    .__pfs-anc {
      transform: none !important; filter: none !important; backdrop-filter: none !important;
      perspective: none !important; contain: none !important; will-change: auto !important;
      clip-path: none !important; mask: none !important; overflow: visible !important;
      z-index: 2147483647 !important;
    }`;
  function injectStyle() {
    if (D.getElementById('__pfs-style')) return;
    const s = D.createElement('style');
    s.id = '__pfs-style';
    s.textContent = css;
    (D.head || D.documentElement).appendChild(s);
  }

  // ---------- events ----------
  function fire(target) {
    const t = target && target.isConnected ? target : D;
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      t.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
    W.dispatchEvent(new Event('resize'));
  }

  // ---------- enter / exit ----------
  function enter(el) {
    if (current === el) return;
    if (current) leave(false);
    injectStyle();
    current = el;
    ancestors = [];
    // YouTube requests fullscreen on <html> and lays itself out; only pin real elements.
    if (el !== D.documentElement && el !== D.body) {
      el.classList.add('__pfs-el');
      for (let p = el.parentElement; p && p !== D.documentElement; p = p.parentElement) {
        p.classList.add('__pfs-anc');
        ancestors.push(p);
      }
    }
    D.documentElement.classList.add('__pfs-on');
    setTimeout(() => fire(el), 0);
  }

  function leave(notify = true) {
    const el = current;
    if (!el) return;
    el.classList.remove('__pfs-el');
    for (const p of ancestors) p.classList.remove('__pfs-anc');
    ancestors = [];
    D.documentElement.classList.remove('__pfs-on');
    current = null;
    if (notify) setTimeout(() => fire(el), 0);
  }

  // ---------- API overrides ----------
  function fakeRequest(options) {
    if (wantReal && real.request) {
      wantReal = false;
      return real.request.call(this, options);
    }
    enter(this);
    return Promise.resolve();
  }
  EP.requestFullscreen = fakeRequest;
  if (real.webkitRequest) EP.webkitRequestFullscreen = fakeRequest;
  if ('webkitRequestFullScreen' in EP) EP.webkitRequestFullScreen = fakeRequest;

  function fakeExit() {
    if (current) {
      leave(true);
      return Promise.resolve();
    }
    const realEl = realGetters.fullscreenElement?.call(D);
    if (realEl && real.exit) return real.exit.call(D);
    return Promise.resolve();
  }
  DP.exitFullscreen = fakeExit;
  if (real.webkitExit) DP.webkitExitFullscreen = fakeExit;
  if ('webkitCancelFullScreen' in DP) DP.webkitCancelFullScreen = fakeExit;

  const elementGetter = (name) => function () {
    return current || (realGetters[name] ? realGetters[name].call(this) : null);
  };
  const boolGetter = (name) => function () {
    return !!current || (realGetters[name] ? realGetters[name].call(this) : false);
  };
  for (const [name, make] of [
    ['fullscreenElement', elementGetter], ['webkitFullscreenElement', elementGetter],
    ['webkitCurrentFullScreenElement', elementGetter],
    ['fullscreen', boolGetter], ['webkitIsFullScreen', boolGetter],
  ]) {
    if (realGetters[name] || name in DP) {
      Object.defineProperty(DP, name, { configurable: true, enumerable: true, get: make(name) });
    }
  }

  // ---------- input handling ----------
  // Option/Alt + click (or Option/Alt + F) asks for real fullscreen.
  const remember = (e) => { wantReal = !!e.altKey; };
  W.addEventListener('pointerdown', remember, true);
  W.addEventListener('mousedown', remember, true);
  W.addEventListener('keydown', (e) => {
    remember(e);
    if (e.key === 'Escape' && current) {
      e.preventDefault();
      e.stopImmediatePropagation();
      D.exitFullscreen();
    }
  }, true);

  // Leave pseudo-fullscreen if the element disappears (SPA navigation).
  setInterval(() => { if (current && !current.isConnected) leave(true); }, 1000);
})();
