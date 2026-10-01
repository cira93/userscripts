// ==UserScript==
// @name         YouTube 方向键增强安全版 v1.2：控制栏倍速
// @namespace    youtube-arrow-enhancer-safe-v12
// @version      1.3.2
// @description  方向键控制音量/快进后退，按住右方向键临时3倍速，控制栏倍速与网页全屏。
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        volumeStep: 0.05,
        seekStep: 5,
        holdDelayMs: 220,
        holdSpeed: 3,
        storageKey: 'yt-arrow-enhancer-v12-default-rate',

        speedList: buildSpeedList(0.1, 10, 0.25)
    };

    let rightKeyDown = false;
    let rightHoldTimer = null;
    let boostActive = false;
    let lastNormalRate = 1;
    let hintTimer = null;
    let currentVideo = null;
    let uiCreated = false;
    let placementObserver = null;
    let placementTimer = null;
    let defaultRate = loadDefaultRate();
    let webFullscreenButton = null;
    let webFullscreenState = null;
    let playerResizeFrame = null;
    let playerResizeTimers = [];
    let playerResizeRevision = 0;

    function buildSpeedList(min, max, step) {
        const rates = [min];

        for (let rate = step; rate <= max + 0.0001; rate += step) {
            rates.push(Number(rate.toFixed(2)));
        }

        if (rates[rates.length - 1] !== max) {
            rates.push(max);
        }

        return [...new Set(rates)].sort((a, b) => a - b);
    }

    function isVideoPage() {
        return (
            location.pathname.startsWith('/watch') ||
            location.pathname.startsWith('/shorts') ||
            location.pathname.startsWith('/embed')
        );
    }

    function getVideo() {
        if (!isVideoPage()) return null;

        return (
            document.querySelector('#movie_player video') ||
            document.querySelector('video.html5-main-video') ||
            document.querySelector('video')
        );
    }

    function getPlayerElement() {
        return (
            document.querySelector('#movie_player') ||
            document.querySelector('.html5-video-player') ||
            document.querySelector('ytd-player') ||
            getVideo()
        );
    }

    function getControlsElement() {
        const player = getPlayerElement();
        const controls = [
            ...document.querySelectorAll('.ytp-right-controls'),
            ...document.querySelectorAll('.ytp-left-controls')
        ];

        const isUsableControl = el => {
            if (!el || !document.documentElement.contains(el)) return false;

            const rect = el.getBoundingClientRect();
            const insidePlayer = player?.contains?.(el);

            return insidePlayer || rect.width > 0 || rect.height > 0;
        };

        const playerRightControls = player?.querySelector?.('.ytp-right-controls');
        const playerLeftControls = player?.querySelector?.('.ytp-left-controls');

        return (
            (isUsableControl(playerRightControls) && playerRightControls) ||
            controls.find(el => el.classList.contains('ytp-right-controls') && isUsableControl(el)) ||
            (isUsableControl(playerLeftControls) && playerLeftControls) ||
            controls.find(isUsableControl) ||
            document.querySelector('.ytp-chrome-controls')
        );
    }

    function isEditableTarget(el) {
        if (!el) return false;

        const tag = (el.tagName || '').toLowerCase();

        return (
            tag === 'input' ||
            tag === 'textarea' ||
            tag === 'select' ||
            el.isContentEditable ||
            Boolean(el.closest?.('[contenteditable="true"]'))
        );
    }

    function clamp(num, min, max) {
        return Math.min(max, Math.max(min, num));
    }

    function formatRate(rate) {
        const n = Number(rate);
        return Number.isInteger(n) ? `${n}x` : `${Number(n.toFixed(2))}x`;
    }

    function normalizeRate(rate) {
        const n = Number(rate);
        return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
    }

    function loadDefaultRate() {
        try {
            return normalizeRate(localStorage.getItem(CFG.storageKey));
        } catch (_) {
            return null;
        }
    }

    function saveDefaultRate(rate) {
        const normalizedRate = normalizeRate(rate);
        if (!normalizedRate) return;

        defaultRate = normalizedRate;

        try {
            localStorage.setItem(CFG.storageKey, String(normalizedRate));
        } catch (_) {
            // localStorage may be unavailable in restricted browsing modes.
        }

        updateSpeedButton();
    }

    function injectStyle() {
        if (document.querySelector('#yt-arrow-enhancer-v12-style')) return;

        const style = document.createElement('style');
        style.id = 'yt-arrow-enhancer-v12-style';
        style.textContent = `
            #yt-arrow-enhancer-v12-hint {
                position: fixed;
                left: 50%;
                top: 18%;
                transform: translateX(-50%);
                z-index: 2147483647;
                background: rgba(0, 0, 0, 0.78);
                color: white;
                padding: 8px 14px;
                border-radius: 10px;
                font: 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                opacity: 0;
                pointer-events: none;
                transition: opacity 120ms ease;
            }

            #yt-arrow-enhancer-v12-hint.show {
                opacity: 1;
            }

            #yt-arrow-speed-btn-v12 {
                position: relative;
                display: none;
                float: left;
                width: 54px !important;
                min-width: 54px !important;
                height: 48px;
                z-index: 2147483647;
                border: 0;
                background: transparent;
                color: white;
                padding: 0 4px;
                cursor: pointer;
                user-select: none;
                font: 600 16px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                text-align: center;
                align-items: center;
                justify-content: center;
                vertical-align: top;
                transform: translateY(-4px);
                opacity: .92;
            }

            #yt-arrow-speed-btn-v12.yt-arrow-speed-visible-v12 {
                display: inline-flex !important;
            }

            #yt-arrow-speed-btn-v12:hover,
            #yt-arrow-speed-btn-v12.yt-arrow-speed-open-v12 {
                opacity: 1;
            }

            #yt-arrow-speed-menu-v12 {
                display: none;
                position: fixed;
                z-index: 2147483647;
                padding: 6px;
                border-radius: 10px;
                background: rgba(20, 20, 20, 0.94);
                box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
                grid-template-columns: minmax(72px, 1fr);
                gap: 4px;
                width: 86px;
                max-height: min(70vh, 520px);
                overflow: auto;
            }

            #yt-arrow-speed-menu-v12.yt-arrow-speed-open-v12 {
                display: grid;
            }

            .yt-arrow-speed-option-v12 {
                border: 0;
                border-radius: 7px;
                padding: 5px 8px;
                background: rgba(255, 255, 255, 0.12);
                color: white;
                cursor: pointer;
                width: 100%;
                font: 500 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                text-align: center;
            }

            .yt-arrow-speed-option-v12:hover,
            .yt-arrow-speed-option-v12.active {
                background: rgba(255, 255, 255, 0.24);
            }

            .yt-arrow-speed-option-v12.default {
                box-shadow: inset 3px 0 0 rgba(255, 255, 255, 0.75);
            }

            #yt-arrow-web-fullscreen-btn-v12 {
                display: none !important;
                position: relative;
                float: left;
                box-sizing: border-box;
                width: var(--yt-arrow-control-width, 48px) !important;
                height: var(--yt-arrow-control-height, 48px) !important;
                min-width: 0 !important;
                flex: 0 0 var(--yt-arrow-control-width, 48px);
                padding: 0 !important;
                border: 0;
                background: transparent;
                color: white;
                cursor: pointer;
                opacity: .9;
                align-items: center;
                justify-content: center;
                vertical-align: top;
            }

            #yt-arrow-web-fullscreen-btn-v12:hover,
            #yt-arrow-web-fullscreen-btn-v12[aria-pressed="true"] {
                opacity: 1;
            }

            #yt-arrow-web-fullscreen-btn-v12:focus-visible {
                outline: 2px solid white;
                outline-offset: -5px;
            }

            #yt-arrow-web-fullscreen-btn-v12::after {
                content: attr(aria-label);
                position: absolute;
                bottom: calc(100% + 12px);
                left: 50%;
                transform: translateX(-50%);
                padding: 6px 8px;
                border-radius: 4px;
                background: rgba(28, 28, 28, .95);
                color: white;
                font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                white-space: nowrap;
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
                z-index: 10;
            }

            #yt-arrow-web-fullscreen-btn-v12:hover::after,
            #yt-arrow-web-fullscreen-btn-v12:focus-visible::after {
                opacity: 1;
                visibility: visible;
            }

            #yt-arrow-web-fullscreen-btn-v12.yt-arrow-web-fullscreen-visible-v12 {
                display: inline-flex !important;
            }

            #yt-arrow-web-fullscreen-btn-v12 svg {
                display: block !important;
                position: static !important;
                width: 72% !important;
                height: 72% !important;
                max-width: 36px;
                max-height: 36px;
                flex: none;
                pointer-events: none;
            }

            #yt-arrow-web-fullscreen-btn-v12 svg,
            #yt-arrow-web-fullscreen-btn-v12 svg * {
                fill: none !important;
                stroke: white !important;
                stroke-width: 2 !important;
                stroke-linecap: round !important;
                stroke-linejoin: round !important;
                opacity: 1 !important;
                visibility: visible !important;
            }

            #yt-arrow-web-fullscreen-btn-v12 .yt-arrow-web-fullscreen-arrows-v12 path {
                stroke-width: 3 !important;
            }

            html.yt-arrow-web-fullscreen-v12,
            html.yt-arrow-web-fullscreen-v12 body {
                overflow: hidden !important;
                overscroll-behavior: none;
            }

            .yt-arrow-web-fullscreen-ancestor-v12 {
                overflow: visible !important;
                transform: none !important;
                translate: none !important;
                scale: none !important;
                rotate: none !important;
                filter: none !important;
                backdrop-filter: none !important;
                perspective: none !important;
                contain: none !important;
                content-visibility: visible !important;
                will-change: auto !important;
                clip-path: none !important;
                z-index: 2147483646 !important;
            }

            .yt-arrow-web-fullscreen-player-v12 {
                position: fixed !important;
                inset: 0 !important;
                width: 100vw !important;
                height: 100vh !important;
                height: 100dvh !important;
                min-width: 0 !important;
                min-height: 0 !important;
                max-width: none !important;
                max-height: none !important;
                margin: 0 !important;
                padding: 0 !important;
                border-radius: 0 !important;
                z-index: 2147483646 !important;
                background: #000 !important;
            }

            .yt-arrow-web-fullscreen-player-v12 .html5-video-container {
                position: absolute !important;
                inset: 0 !important;
                width: 100% !important;
                height: 100% !important;
            }

            .yt-arrow-web-fullscreen-player-v12 video.html5-main-video {
                position: absolute !important;
                inset: 0 !important;
                width: 100% !important;
                height: 100% !important;
                max-width: none !important;
                max-height: none !important;
                object-fit: contain !important;
            }

            .yt-arrow-controls-sized-v12 .ytp-chrome-bottom {
                left: var(--yt-arrow-controls-inset, 12px) !important;
                right: var(--yt-arrow-controls-inset, 12px) !important;
                width: calc(100% - 2 * var(--yt-arrow-controls-inset, 12px)) !important;
                max-width: calc(100% - 2 * var(--yt-arrow-controls-inset, 12px)) !important;
                box-sizing: border-box;
            }

            .yt-arrow-controls-sized-v12 .ytp-chrome-controls {
                width: 100% !important;
                max-width: 100% !important;
                box-sizing: border-box;
            }

            .yt-arrow-controls-sized-v12 .ytp-right-controls {
                flex-shrink: 0;
            }
        `;

        document.head.appendChild(style);
    }

    function showHint(text) {
        if (!isVideoPage()) return;

        let hint = document.querySelector('#yt-arrow-enhancer-v12-hint');

        if (!hint) {
            hint = document.createElement('div');
            hint.id = 'yt-arrow-enhancer-v12-hint';
            document.body.appendChild(hint);
        }

        hint.textContent = text;
        hint.classList.add('show');

        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => {
            hint.classList.remove('show');
        }, 800);
    }

    function adjustVolume(delta) {
        const video = getVideo();
        if (!video) return;

        const baseVolume = video.muted ? 0 : video.volume;
        const newVolume = clamp(baseVolume + delta, 0, 1);

        video.volume = newVolume;
        video.muted = newVolume === 0;

        showHint(`音量 ${Math.round(newVolume * 100)}%`);
    }

    function seek(seconds) {
        const video = getVideo();
        if (!video) return;

        const maxTime = Number.isFinite(video.duration) ? video.duration : Infinity;
        video.currentTime = clamp(video.currentTime + seconds, 0, maxTime);

        showHint(`${seconds > 0 ? '快进' : '后退'} ${Math.abs(seconds)} 秒`);
    }

    function setRate(rate, saveAsNormal = true) {
        const video = getVideo();
        if (!video) return;

        const r = normalizeRate(rate);
        if (!r) return;

        video.playbackRate = r;

        if (saveAsNormal && !boostActive) {
            lastNormalRate = r;
        }

        updateSpeedButton();
    }

    function applyDefaultRate(video = getVideo()) {
        if (!video || !defaultRate || boostActive) return;

        video.playbackRate = defaultRate;
        lastNormalRate = defaultRate;

        updateSpeedButton();
    }

    function enterBoost() {
        const video = getVideo();
        if (!video || boostActive) return;

        lastNormalRate = video.playbackRate || lastNormalRate || 1;
        boostActive = true;

        video.playbackRate = CFG.holdSpeed;

        updateSpeedButton();
    }

    function leaveBoost() {
        const video = getVideo();
        if (!video || !boostActive) return;

        boostActive = false;
        video.playbackRate = lastNormalRate || 1;

        updateSpeedButton();
    }

    function resetRightKeyState() {
        rightKeyDown = false;
        clearTimeout(rightHoldTimer);
        rightHoldTimer = null;

        if (boostActive) {
            leaveBoost();
        }
    }

    function handleKeyDown(e) {
        if (
            e.defaultPrevented ||
            e.ctrlKey ||
            e.altKey ||
            e.metaKey ||
            isEditableTarget(e.target) ||
            !isVideoPage()
        ) {
            return;
        }

        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
            return;
        }

        e.preventDefault();
        e.stopImmediatePropagation();

        if (e.code === 'ArrowUp') {
            adjustVolume(CFG.volumeStep);
            return;
        }

        if (e.code === 'ArrowDown') {
            adjustVolume(-CFG.volumeStep);
            return;
        }

        if (e.code === 'ArrowLeft') {
            seek(-CFG.seekStep);
            return;
        }

        if (e.code === 'ArrowRight') {
            if (!rightKeyDown) {
                rightKeyDown = true;

                clearTimeout(rightHoldTimer);
                rightHoldTimer = setTimeout(() => {
                    if (rightKeyDown) {
                        enterBoost();
                    }
                }, CFG.holdDelayMs);
            }
        }
    }

    function handleKeyUp(e) {
        if (e.code !== 'ArrowRight') return;

        if (!rightKeyDown && !boostActive && !rightHoldTimer) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        rightKeyDown = false;
        clearTimeout(rightHoldTimer);
        rightHoldTimer = null;

        if (boostActive) {
            leaveBoost();
        } else {
            seek(CFG.seekStep);
        }
    }

    function closeSpeedMenu() {
        const btn = document.querySelector('#yt-arrow-speed-btn-v12');
        const menu = document.querySelector('#yt-arrow-speed-menu-v12');

        btn?.classList.remove('yt-arrow-speed-open-v12');
        menu?.classList.remove('yt-arrow-speed-open-v12');
    }

    function updateWebFullscreenButton() {
        if (!webFullscreenButton) return;

        const active = Boolean(webFullscreenState);
        const label = active ? '退出网页全屏' : '网页全屏';
        const pressed = String(active);

        if (webFullscreenButton.getAttribute('aria-pressed') === pressed &&
            webFullscreenButton.querySelector('svg')) return;

        webFullscreenButton.setAttribute('aria-label', label);
        webFullscreenButton.setAttribute('aria-pressed', pressed);

        // Lucide AppWindow and Maximize2/Minimize2, fitted to the native icon canvas.
        const paths = active ? [
            'm14 10 7-7',
            'M20 10h-6V4',
            'm3 21 7-7',
            'M4 14h6v6'
        ] : [
            'M15 3h6v6',
            'm21 3-7 7',
            'm3 21 7-7',
            'M9 21H3v-6'
        ];

        const createSvgElement = (tag, attributes) => {
            const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
            Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
            return element;
        };

        const svg = createSvgElement('svg', {
            viewBox: '0 0 24 24',
            'aria-hidden': 'true',
            focusable: 'false'
        });
        svg.appendChild(createSvgElement('rect', { x: 2, y: 4, width: 20, height: 16, rx: 2 }));
        svg.appendChild(createSvgElement('path', { d: 'M10 4v4 M2 8h20 M6 4v4' }));

        const arrows = createSvgElement('g', {
            class: 'yt-arrow-web-fullscreen-arrows-v12',
            transform: 'translate(7.2 9.2) scale(0.4)'
        });
        paths.forEach(d => arrows.appendChild(createSvgElement('path', { d })));
        svg.appendChild(arrows);
        webFullscreenButton.replaceChildren(svg);
    }

    function ensureWebFullscreenButton() {
        if (webFullscreenButton) return;

        webFullscreenButton = document.createElement('button');
        webFullscreenButton.id = 'yt-arrow-web-fullscreen-btn-v12';
        webFullscreenButton.type = 'button';
        webFullscreenButton.className = 'ytp-button';
        webFullscreenButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            if (webFullscreenState) {
                exitWebFullscreen();
            } else {
                enterWebFullscreen();
            }
        });

        updateWebFullscreenButton();
    }

    function notifyPlayerResize(player = getPlayerElement()) {
        const revision = ++playerResizeRevision;
        cancelAnimationFrame(playerResizeFrame);
        playerResizeTimers.forEach(clearTimeout);
        playerResizeTimers = [];

        const resize = () => {
            if (revision !== playerResizeRevision || !player?.isConnected) return;

            // Read the restored layout before YouTube recalculates its controls.
            player.getBoundingClientRect();
            window.dispatchEvent(new Event('resize'));
            placeControlButtons();
            positionSpeedMenu();
        };

        playerResizeFrame = requestAnimationFrame(() => {
            playerResizeFrame = requestAnimationFrame(resize);
        });
        playerResizeTimers = [120, 350].map(delay => setTimeout(resize, delay));
    }

    function capturePlayerLayout(player) {
        const properties = ['width', 'height', 'left', 'right', 'top', 'bottom', 'transform'];
        const elements = player.querySelectorAll(
            '.ytp-chrome-bottom, .ytp-chrome-controls, .ytp-progress-bar-container, ' +
            '.html5-video-container, video.html5-main-video'
        );

        return [...elements].map(element => ({
            element,
            properties: properties.map(name => ({
                name,
                value: element.style.getPropertyValue(name),
                priority: element.style.getPropertyPriority(name)
            }))
        }));
    }

    function restorePlayerLayout(layout) {
        layout.forEach(({ element, properties }) => {
            if (!element.isConnected) return;

            properties.forEach(({ name, value, priority }) => {
                if (value) {
                    element.style.setProperty(name, value, priority);
                } else {
                    element.style.removeProperty(name);
                }
            });
        });
    }

    function enterWebFullscreen() {
        const player = getPlayerElement();
        if (!player || !getVideo() || document.fullscreenElement || webFullscreenState) return;

        const ancestors = [];
        for (let el = player.parentElement; el; el = el.parentElement) {
            ancestors.push(el);
        }

        webFullscreenState = {
            player,
            ancestors,
            layout: capturePlayerLayout(player),
            scrollX: window.scrollX,
            scrollY: window.scrollY
        };

        closeSpeedMenu();
        const chromeBottom = player.querySelector('.ytp-chrome-bottom');
        const inset = chromeBottom ? parseFloat(getComputedStyle(chromeBottom).left) : NaN;
        player.style.setProperty('--yt-arrow-controls-inset', `${Number.isFinite(inset) ? clamp(inset, 0, 24) : 12}px`);
        // Keep controls responsive after exit, even if YouTube retains an old pixel width.
        player.classList.add('yt-arrow-controls-sized-v12');
        ancestors.forEach(el => el.classList.add('yt-arrow-web-fullscreen-ancestor-v12'));
        document.documentElement.classList.add('yt-arrow-web-fullscreen-v12');
        player.classList.add('yt-arrow-web-fullscreen-player-v12');
        updateWebFullscreenButton();
        notifyPlayerResize();
    }

    function exitWebFullscreen(restoreScroll = true) {
        if (!webFullscreenState) return;

        const state = webFullscreenState;
        webFullscreenState = null;

        closeSpeedMenu();
        state.player.classList.remove('yt-arrow-web-fullscreen-player-v12');
        state.ancestors.forEach(el => el.classList.remove('yt-arrow-web-fullscreen-ancestor-v12'));
        document.documentElement.classList.remove('yt-arrow-web-fullscreen-v12');
        if (!document.fullscreenElement) restorePlayerLayout(state.layout);
        updateWebFullscreenButton();
        notifyPlayerResize(state.player);

        if (restoreScroll) {
            window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: 'instant' });
        }
    }

    function placeWebFullscreenButton() {
        ensureWebFullscreenButton();
        updateWebFullscreenButton();

        const player = getPlayerElement();
        if (webFullscreenState && (
            !isVideoPage() ||
            !webFullscreenState.player.isConnected ||
            webFullscreenState.player !== player
        )) {
            exitWebFullscreen(false);
        }

        const theaterButton = player?.querySelector?.('.ytp-size-button');
        const controls = theaterButton?.closest('.ytp-right-controls');

        if (!isVideoPage() || !getVideo() || !controls || document.fullscreenElement) {
            webFullscreenButton.classList.remove('yt-arrow-web-fullscreen-visible-v12');
            return;
        }

        const reference = directControlChild(controls, theaterButton);
        const fullscreenReference = directControlChild(
            controls,
            controls.querySelector('.ytp-fullscreen-button')
        );
        const nextButton = fullscreenReference || (
            reference?.nextElementSibling === webFullscreenButton
                ? webFullscreenButton.nextElementSibling
                : reference?.nextElementSibling
        );

        if (reference && (
            webFullscreenButton.parentElement !== controls ||
            webFullscreenButton.nextElementSibling !== nextButton
        )) {
            controls.insertBefore(webFullscreenButton, nextButton || null);
        }

        const theaterStyle = getComputedStyle(theaterButton);
        const fullscreenStyle = fullscreenReference ? getComputedStyle(fullscreenReference) : null;
        const controlSize = name => {
            const size = [theaterStyle, fullscreenStyle]
                .map(style => parseFloat(style?.[name]))
                .find(value => Number.isFinite(value) && value >= 24 && value <= 96);
            return `${size || 48}px`;
        };
        const properties = {
            '--yt-arrow-control-width': controlSize('width'),
            '--yt-arrow-control-height': controlSize('height'),
            order: theaterStyle.order
        };

        Object.entries(properties).forEach(([name, value]) => {
            if (webFullscreenButton.style.getPropertyValue(name) !== value) {
                webFullscreenButton.style.setProperty(name, value);
            }
        });

        webFullscreenButton.classList.add('yt-arrow-web-fullscreen-visible-v12');
    }

    function placeControlButtons() {
        placeSpeedButton();
        placeWebFullscreenButton();
    }

    function positionSpeedMenu() {
        const btn = document.querySelector('#yt-arrow-speed-btn-v12');
        const menu = document.querySelector('#yt-arrow-speed-menu-v12');

        if (!btn || !menu || !menu.classList.contains('yt-arrow-speed-open-v12')) return;

        const rect = btn.getBoundingClientRect();
        const menuWidth = menu.offsetWidth || 124;
        const menuHeight = menu.offsetHeight || 280;
        const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
        const maxTop = Math.max(8, window.innerHeight - menuHeight - 8);
        const left = clamp(rect.right - menuWidth, 8, maxLeft);
        const top = clamp(rect.top - menuHeight - 8, 8, maxTop);

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    function toggleSpeedMenu() {
        const btn = document.querySelector('#yt-arrow-speed-btn-v12');
        const menu = document.querySelector('#yt-arrow-speed-menu-v12');

        if (!btn || !menu) return;

        const willOpen = !menu.classList.contains('yt-arrow-speed-open-v12');

        btn.classList.toggle('yt-arrow-speed-open-v12', willOpen);
        menu.classList.toggle('yt-arrow-speed-open-v12', willOpen);

        if (willOpen) {
            requestAnimationFrame(positionSpeedMenu);
        }
    }

    function directControlChild(controls, el) {
        if (!controls || !el || !controls.contains(el)) return null;

        let node = el;

        while (node && node.parentElement !== controls) {
            node = node.parentElement;
        }

        return node && node !== controls ? node : null;
    }

    function controlSignature(el) {
        if (!el) return '';

        const pieces = [
            el.id,
            el.className,
            el.getAttribute?.('aria-label'),
            el.getAttribute?.('title'),
            el.getAttribute?.('data-tooltip-target-id'),
            el.getAttribute?.('data-title-no-tooltip'),
            el.textContent
        ];

        el.querySelectorAll?.('[id], [class], [aria-label], [title], [data-tooltip-target-id], [data-title-no-tooltip], img[src]').forEach(child => {
            pieces.push(
                child.id,
                child.className,
                child.getAttribute?.('aria-label'),
                child.getAttribute?.('title'),
                child.getAttribute?.('data-tooltip-target-id'),
                child.getAttribute?.('data-title-no-tooltip'),
                child.getAttribute?.('src')
            );
        });

        return pieces
            .filter(Boolean)
            .map(value => String(value))
            .join(' ')
            .toLowerCase();
    }

    function findControlButton(controls, patterns) {
        return [...controls.children].find(child => {
            if (child.id === 'yt-arrow-speed-btn-v12') return false;

            const signature = controlSignature(child);
            return patterns.some(pattern => pattern.test(signature));
        });
    }

    function findAutoplayButton(controls) {
        return findControlButton(controls, [
            /autonav/,
            /autoplay/,
            /自动播放/
        ]);
    }

    function findTranslateButton(controls) {
        return findControlButton(controls, [
            /immersive/,
            /translate/,
            /translation/,
            /沉浸/,
            /翻译/
        ]);
    }

    function getSpeedButtonReference(controls, btn) {
        const children = [...controls.children].filter(child => child !== btn);
        const translateButton = findTranslateButton(controls);
        const autoplayButton = findAutoplayButton(controls);
        const settingsButton = directControlChild(
            controls,
            controls.querySelector('.ytp-settings-button')
        );

        if (translateButton && autoplayButton) {
            const translateIndex = children.indexOf(translateButton);
            const autoplayIndex = children.indexOf(autoplayButton);

            return translateIndex < autoplayIndex ? autoplayButton : translateButton;
        }

        if (translateButton) {
            const nextButton = translateButton.nextElementSibling;
            return nextButton === btn ? btn.nextElementSibling : nextButton;
        }

        return (
            autoplayButton ||
            settingsButton ||
            controls.firstElementChild ||
            null
        );
    }

    function placeSpeedButtonInControls(controls, btn) {
        const reference = getSpeedButtonReference(controls, btn);

        if (btn.parentElement === controls && btn.nextElementSibling === reference) {
            return;
        }

        try {
            controls.insertBefore(btn, reference);
        } catch (_) {
            controls.appendChild(btn);
        }
    }

    function ensureSpeedButton() {
        if (uiCreated) return;

        injectStyle();

        const btn = document.createElement('button');
        btn.id = 'yt-arrow-speed-btn-v12';
        btn.type = 'button';
        btn.className = 'ytp-button';
        btn.title = '播放速度';
        btn.setAttribute('aria-label', '播放速度');
        btn.textContent = '1x';

        const menu = document.createElement('div');
        menu.id = 'yt-arrow-speed-menu-v12';

        CFG.speedList.forEach(rate => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'yt-arrow-speed-option-v12';
            item.dataset.rate = String(rate);
            item.textContent = formatRate(rate);
            item.title = `点击切换到 ${formatRate(rate)}，按住 Option/Alt 点击设为默认`;

            item.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();

                if (event.altKey) {
                    saveDefaultRate(rate);
                }

                setRate(rate, true);
                closeSpeedMenu();
            });

            menu.appendChild(item);
        });

        btn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();

            toggleSpeedMenu();
        });

        document.addEventListener('click', event => {
            if (!btn.contains(event.target) && !menu.contains(event.target)) {
                closeSpeedMenu();
            }
        }, true);

        document.body.appendChild(btn);
        document.body.appendChild(menu);

        uiCreated = true;
    }

    function startPlacementObserver() {
        if (!placementTimer) {
            placementTimer = setInterval(placeControlButtons, 500);
        }

        if (placementObserver) return;

        placementObserver = new MutationObserver(() => {
            placeControlButtons();
        });

        placementObserver.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    function placeSpeedButton() {
        ensureSpeedButton();

        const btn = document.querySelector('#yt-arrow-speed-btn-v12');
        const video = getVideo();

        if (!btn) return;

        if (!isVideoPage() || !video) {
            btn.classList.remove('yt-arrow-speed-visible-v12');
            closeSpeedMenu();
            return;
        }

        const controls = getControlsElement();

        if (!controls) {
            btn.classList.remove('yt-arrow-speed-visible-v12');
            closeSpeedMenu();
            return;
        }

        placeSpeedButtonInControls(controls, btn);

        btn.classList.add('yt-arrow-speed-visible-v12');
        positionSpeedMenu();
    }

    function updateSpeedButton() {
        const video = getVideo();
        const btn = document.querySelector('#yt-arrow-speed-btn-v12');

        if (!video) return;

        if (btn) {
            const rateLabel = formatRate(video.playbackRate || 1);
            const defaultLabel = defaultRate ? `，默认 ${formatRate(defaultRate)}` : '';
            btn.textContent = rateLabel;
            btn.title = `播放速度 ${rateLabel}${defaultLabel}`;
            btn.setAttribute('aria-label', `播放速度 ${rateLabel}${defaultLabel}`);
        }

        document.querySelectorAll('.yt-arrow-speed-option-v12').forEach(item => {
            const rate = Number(item.dataset.rate);

            item.classList.toggle(
                'active',
                Math.abs(rate - video.playbackRate) < 0.01
            );
            item.classList.toggle(
                'default',
                Boolean(defaultRate) && Math.abs(rate - defaultRate) < 0.01
            );
        });
    }

    function attachVideoListeners() {
        const video = getVideo();
        if (!video || video === currentVideo) return;

        currentVideo = video;
        lastNormalRate = video.playbackRate || 1;
        applyDefaultRate(video);

        video.addEventListener('ratechange', () => {
            if (!boostActive) {
                lastNormalRate = video.playbackRate || 1;
            }

            updateSpeedButton();
        });

        video.addEventListener('loadedmetadata', () => {
            applyDefaultRate(video);
            updateSpeedButton();
            placeControlButtons();
        });
    }

    function refresh() {
        injectStyle();
        ensureSpeedButton();
        placeWebFullscreenButton();

        if (!isVideoPage()) {
            const btn = document.querySelector('#yt-arrow-speed-btn-v12');
            if (btn) {
                btn.classList.remove('yt-arrow-speed-visible-v12');
                closeSpeedMenu();
            }
            return;
        }

        attachVideoListeners();
        startPlacementObserver();
        placeControlButtons();
        updateSpeedButton();
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && webFullscreenState && !document.fullscreenElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
            exitWebFullscreen();
            webFullscreenButton?.focus({ preventScroll: true });
            return;
        }

        handleKeyDown(event);
    }, true);
    document.addEventListener('keyup', handleKeyUp, true);

    window.addEventListener('blur', resetRightKeyState);
    window.addEventListener('resize', placeControlButtons);
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) exitWebFullscreen(false);
        placeControlButtons();
    });

    window.addEventListener('yt-navigate-start', () => {
        exitWebFullscreen(false);
    });

    window.addEventListener('yt-navigate-finish', () => {
        resetRightKeyState();
        setTimeout(refresh, 300);
        setTimeout(refresh, 900);
    });

    setInterval(refresh, 2500);

    refresh();
})();
