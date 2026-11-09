// ==UserScript==
// @name         Bilibili 扩展倍速（最高 10x）
// @namespace    local.bilibili.extended-speed
// @version      1.1.0
// @updateURL      https://raw.githubusercontent.com/cira93/userscripts/main/bilibili-extended-speed/bilibili-extended-speed.user.js
// @downloadURL    https://raw.githubusercontent.com/cira93/userscripts/main/bilibili-extended-speed/bilibili-extended-speed.user.js
// @description  为 Bilibili 视频播放器增加 2.5x–10x 倍速选项，并默认开启可用字幕。
// @author       You
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/festival/*
// @match        https://www.bilibili.com/list/watchlater*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window.self) return;

  const CONTROL_ID = 'bili-extended-speed-control';
  const STYLE_ID = 'bili-extended-speed-style';
  const RATE_EPSILON = 0.001;
  const WHEEL_SCROLL_MULTIPLIER = 2.5;
  const SUBTITLE_ITEM_SELECTOR = [
    '.bpx-player-ctrl-subtitle-language-item[data-lan]',
    '.bpx-player-ctrl-subtitle [data-lan]',
  ].join(', ');
  const PRESET_RATES = [
    10, 9, 8, 7, 6, 5,
    4.5, 4, 3.5, 3, 2.5, 2,
    1.5, 1.25, 1, 0.75, 0.5,
  ];

  let desiredRate = 1;
  let userHasSelectedRate = false;
  let applyingRate = false;
  let mountTimer = 0;
  let menuCloseTimer = 0;
  let subtitleContextKey = '';
  let subtitleState = 'idle';
  let subtitleAttempts = 0;
  let subtitleTimer = 0;
  let subtitleRequestId = 0;

  function formatRate(rate) {
    return `${Number.isInteger(rate) ? rate.toFixed(1) : rate}x`;
  }

  function isUsableVideo(video) {
    return video instanceof HTMLVideoElement && video.isConnected;
  }

  function getPrimaryVideo() {
    const videos = [...document.querySelectorAll('video')].filter(isUsableVideo);
    if (videos.length === 0) return null;

    return videos.reduce((largest, video) => {
      const area = video.getBoundingClientRect().width * video.getBoundingClientRect().height;
      const largestArea = largest.getBoundingClientRect().width * largest.getBoundingClientRect().height;
      return area > largestArea ? video : largest;
    });
  }

  function updateControl() {
    const control = document.getElementById(CONTROL_ID);
    if (!control) return;

    const result = control.querySelector('.bes-result');
    if (result) {
      result.textContent = Math.abs(desiredRate - 1) < RATE_EPSILON
        ? '倍速'
        : formatRate(desiredRate);
    }

    control.querySelectorAll('.bes-item').forEach((item) => {
      const isActive = Math.abs(Number(item.dataset.rate) - desiredRate) < RATE_EPSILON;
      item.classList.toggle('bes-active', isActive);
      item.setAttribute('aria-checked', String(isActive));
    });
  }

  function applyRate(rate, markAsUserChoice = false) {
    const normalizedRate = Number(rate);
    if (!Number.isFinite(normalizedRate) || normalizedRate < 0.5 || normalizedRate > 10) return;

    desiredRate = normalizedRate;
    if (markAsUserChoice) userHasSelectedRate = true;

    applyingRate = true;
    document.querySelectorAll('video').forEach((video) => {
      try {
        video.defaultPlaybackRate = desiredRate;
        video.playbackRate = desiredRate;
      } catch (error) {
        console.warn('[Bilibili 扩展倍速] 设置倍速失败：', error);
      }
    });
    applyingRate = false;

    updateControl();
  }

  function getSubtitleContext() {
    const video = getPrimaryVideo();
    if (!video) return null;

    const pageUrl = `${location.pathname}${location.search}`;
    const mediaUrl = video.currentSrc || video.src || '';
    return { video, key: `${pageUrl}|${mediaUrl}` };
  }

  function resetSubtitleState(key = '') {
    if (subtitleTimer) window.clearTimeout(subtitleTimer);
    subtitleTimer = 0;
    subtitleRequestId += 1;
    subtitleContextKey = key;
    subtitleState = 'idle';
    subtitleAttempts = 0;
  }

  function getSubtitleItems() {
    return [...document.querySelectorAll(SUBTITLE_ITEM_SELECTOR)];
  }

  function isActiveSubtitleItem(item) {
    return item.classList.contains('bpx-state-active')
      || item.classList.contains('active')
      || item.getAttribute('aria-selected') === 'true'
      || item.getAttribute('aria-checked') === 'true';
  }

  function choosePreferredSubtitle(items) {
    const usableItems = items.filter((item) => {
      return !item.classList.contains('disabled') && item.getAttribute('aria-disabled') !== 'true';
    });
    const languageOf = (item) => (item.dataset.lan || '').toLowerCase();

    return usableItems.find((item) => languageOf(item) === 'ai-zh')
      || usableItems.find((item) => languageOf(item).startsWith('zh'))
      || usableItems[0]
      || null;
  }

  function finishSubtitleAttempt(items) {
    // Re-clicking the selected language keeps the language choice while also
    // reopening subtitles when Bilibili remembers a language but has captions off.
    const preferredItem = items.find(isActiveSubtitleItem) || choosePreferredSubtitle(items);
    if (!preferredItem) return false;

    preferredItem.click();
    subtitleState = 'done';
    return true;
  }

  function tryEnableDefaultSubtitle(expectedKey, requestId) {
    const context = getSubtitleContext();
    if (!context || context.key !== expectedKey || requestId !== subtitleRequestId) return;

    subtitleAttempts += 1;
    const existingItems = getSubtitleItems();
    if (existingItems.length > 0 && finishSubtitleAttempt(existingItems)) return;

    const subtitleButton = document.querySelector('.bpx-player-ctrl-subtitle');
    if (!subtitleButton) {
      subtitleState = subtitleAttempts >= 8 ? 'done' : 'idle';
      if (subtitleState === 'idle') scheduleDefaultSubtitle(800);
      return;
    }

    subtitleButton.click();
    subtitleState = 'checking';

    let pollCount = 0;
    const pollForItems = () => {
      const currentContext = getSubtitleContext();
      if (!currentContext || currentContext.key !== expectedKey || requestId !== subtitleRequestId) return;

      const items = getSubtitleItems();
      if (items.length > 0 && finishSubtitleAttempt(items)) return;

      pollCount += 1;
      if (pollCount < 8) {
        subtitleTimer = window.setTimeout(pollForItems, 250);
      } else {
        // No language items means this video most likely has no subtitles.
        subtitleTimer = 0;
        subtitleState = 'done';
      }
    };

    subtitleTimer = window.setTimeout(pollForItems, 250);
  }

  function scheduleDefaultSubtitle(delay = 1200) {
    const context = getSubtitleContext();
    if (!context) return;

    if (context.key !== subtitleContextKey) resetSubtitleState(context.key);
    if (subtitleState !== 'idle' || subtitleTimer) return;

    subtitleState = 'scheduled';
    const requestId = subtitleRequestId;
    subtitleTimer = window.setTimeout(() => {
      subtitleTimer = 0;
      tryEnableDefaultSubtitle(context.key, requestId);
    }, delay);
  }

  function closeMenu(control) {
    if (menuCloseTimer) {
      window.clearTimeout(menuCloseTimer);
      menuCloseTimer = 0;
    }
    control.classList.remove('bes-open');
    control.setAttribute('aria-expanded', 'false');
  }

  function openMenu(control) {
    if (menuCloseTimer) {
      window.clearTimeout(menuCloseTimer);
      menuCloseTimer = 0;
    }
    control.classList.add('bes-open');
    control.setAttribute('aria-expanded', 'true');
  }

  function scheduleMenuClose(control) {
    if (menuCloseTimer) window.clearTimeout(menuCloseTimer);
    menuCloseTimer = window.setTimeout(() => {
      menuCloseTimer = 0;
      closeMenu(control);
    }, 180);
  }

  function buildControl() {
    const control = document.createElement('div');
    control.id = CONTROL_ID;
    control.className = 'bpx-player-ctrl-btn bes-control';
    control.tabIndex = 0;
    control.setAttribute('role', 'button');
    control.setAttribute('aria-label', '播放倍速');
    control.setAttribute('aria-haspopup', 'menu');
    control.setAttribute('aria-expanded', 'false');

    const result = document.createElement('div');
    result.className = 'bes-result';
    result.textContent = '倍速';

    const menu = document.createElement('ul');
    menu.className = 'bes-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '选择播放倍速');

    PRESET_RATES.forEach((rate) => {
      const item = document.createElement('li');
      item.className = 'bes-item';
      item.dataset.rate = String(rate);
      item.textContent = formatRate(rate);
      item.tabIndex = -1;
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyRate(rate, true);
        closeMenu(control);
      });
      menu.appendChild(item);
    });

    result.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      control.classList.contains('bes-open') ? closeMenu(control) : openMenu(control);
    });

    control.addEventListener('pointerenter', () => openMenu(control));
    control.addEventListener('pointerleave', () => scheduleMenuClose(control));
    menu.addEventListener('pointerenter', () => openMenu(control));
    menu.addEventListener('wheel', (event) => {
      if (menu.scrollHeight <= menu.clientHeight) return;

      const pixelDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 34
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * menu.clientHeight
          : event.deltaY;

      event.preventDefault();
      event.stopPropagation();
      menu.scrollTop += pixelDelta * WHEEL_SCROLL_MULTIPLIER;
    }, { passive: false });
    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        control.classList.contains('bes-open') ? closeMenu(control) : openMenu(control);
      } else if (event.key === 'Escape') {
        closeMenu(control);
      }
    });
    control.addEventListener('focusout', (event) => {
      if (!control.contains(event.relatedTarget)) closeMenu(control);
    });

    control.append(result, menu);
    return control;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.bes-mounted .bpx-player-ctrl-playbackrate {
        display: none !important;
      }

      #${CONTROL_ID}.bes-control {
        position: relative;
        box-sizing: border-box;
        min-width: 50px;
        margin-right: 10px;
        color: #fff;
        cursor: pointer;
        outline: none;
      }

      #${CONTROL_ID} .bes-result {
        box-sizing: border-box;
        min-width: 50px;
        padding: 0;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        text-align: center;
        white-space: nowrap;
      }

      /* Fill the visual gap between the button and menu so hover is continuous. */
      #${CONTROL_ID}.bes-control::after {
        content: '';
        position: absolute;
        bottom: 100%;
        left: 50%;
        display: none;
        width: 80px;
        height: 12px;
        transform: translateX(-50%);
      }

      #${CONTROL_ID}.bes-open::after {
        display: block;
      }

      #${CONTROL_ID} .bes-menu {
        position: absolute;
        bottom: calc(100% + 12px);
        left: 50%;
        z-index: 100;
        display: block;
        box-sizing: border-box;
        width: 80px;
        max-height: min(70vh, 520px);
        margin: 0;
        padding: 6px 0;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-color: rgba(255, 255, 255, 0.35) transparent;
        scrollbar-width: thin;
        color: #fff;
        background: rgba(20, 20, 20, 0.92);
        border-radius: 3px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
        list-style: none;
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translateX(-50%) translateY(6px);
        transition: opacity 0.14s ease, transform 0.14s ease, visibility 0s 0.14s;
      }

      #${CONTROL_ID} .bes-menu::-webkit-scrollbar {
        width: 5px;
      }

      #${CONTROL_ID} .bes-menu::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.35);
        border-radius: 999px;
      }

      #${CONTROL_ID} .bes-menu::-webkit-scrollbar-track {
        background: transparent;
      }

      #${CONTROL_ID}.bes-open .bes-menu {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
        transform: translateX(-50%) translateY(0);
        transition: opacity 0.14s ease, transform 0.14s ease;
      }

      #${CONTROL_ID} .bes-item {
        box-sizing: border-box;
        height: 34px;
        margin: 0;
        padding: 0;
        color: #fff;
        font-size: 14px;
        font-weight: 400;
        line-height: 34px;
        text-align: center;
        list-style: none;
        cursor: pointer;
        user-select: none;
      }

      #${CONTROL_ID} .bes-item:hover,
      #${CONTROL_ID} .bes-item:focus-visible {
        background: rgba(255, 255, 255, 0.12);
        outline: none;
      }

      #${CONTROL_ID} .bes-item.bes-active {
        color: var(--bpx-primary-color, #00aeec);
        font-weight: 600;
      }

      .bpx-player-container[data-ctrl-hidden='true'] #${CONTROL_ID} .bes-menu {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function findMountPoint() {
    const nativeControl = document.querySelector('.bpx-player-ctrl-playbackrate');
    if (nativeControl?.parentElement) {
      return { parent: nativeControl.parentElement, before: nativeControl };
    }

    const rightControls = document.querySelector('.bpx-player-control-bottom-right');
    if (!rightControls?.querySelector('.bpx-player-ctrl-btn')) return null;

    const before = rightControls.querySelector(
      '.bpx-player-ctrl-subtitle, .bpx-player-ctrl-volume, .bpx-player-ctrl-setting'
    );
    return { parent: rightControls, before };
  }

  function ensureMounted() {
    injectStyle();

    const mountPoint = findMountPoint();
    if (!mountPoint) return;

    let control = document.getElementById(CONTROL_ID);
    if (!control) {
      const video = getPrimaryVideo();
      if (!userHasSelectedRate && video && Number.isFinite(video.playbackRate)) {
        desiredRate = video.playbackRate;
      }
      control = buildControl();
    }

    if (control.parentElement !== mountPoint.parent || control.nextElementSibling !== mountPoint.before) {
      mountPoint.parent.insertBefore(control, mountPoint.before);
    }

    document.documentElement.classList.add('bes-mounted');
    updateControl();
    scheduleDefaultSubtitle();
  }

  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = window.setTimeout(() => {
      mountTimer = 0;
      ensureMounted();
    }, 50);
  }

  document.addEventListener('ratechange', (event) => {
    const video = event.target;
    if (!isUsableVideo(video) || applyingRate) return;

    if (!userHasSelectedRate) {
      desiredRate = video.playbackRate;
      updateControl();
      return;
    }

    if (Math.abs(video.playbackRate - desiredRate) >= RATE_EPSILON) {
      window.setTimeout(() => applyRate(desiredRate), 0);
    }
  }, true);

  ['loadedmetadata', 'play', 'playing'].forEach((eventName) => {
    document.addEventListener(eventName, (event) => {
      if (eventName === 'loadedmetadata' && isUsableVideo(event.target)) {
        resetSubtitleState();
        scheduleDefaultSubtitle(1000);
      }

      if (!userHasSelectedRate || !isUsableVideo(event.target)) return;
      if (Math.abs(event.target.playbackRate - desiredRate) >= RATE_EPSILON) {
        applyRate(desiredRate);
      }
    }, true);
  });

  document.addEventListener('pointerdown', (event) => {
    const control = document.getElementById(CONTROL_ID);
    if (control && !control.contains(event.target)) closeMenu(control);
  }, true);

  const observer = new MutationObserver(scheduleMount);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.setInterval(ensureMounted, 1500);
  scheduleMount();
})();
