// ==UserScript==
// @name         B站字幕和评论提取
// @namespace    local.bilibili.subtitle
// @version      2.0.1
// @description  导出当前分P字幕，以及整个视频可访问的评论和楼中楼；支持暂停续传、去重和采集报告。
// @match        https://www.bilibili.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @connect      hdslb.com
// @connect      bilibili.com
// ==/UserScript==

(function () {
  'use strict';

  function route(href) {
    const url = new URL(href);
    const id = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)(?:\/|$)/i)?.[1];
    if (!id) return null;
    const p = Number(url.searchParams.get('p') || 1);
    if (!Number.isSafeInteger(p) || p < 1) return null;
    return { id, p, key: `${id}:${p}` };
  }

  function timestamp(seconds) {
    const ms = Math.round(seconds * 1000);
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
  }

  function cues(data) {
    if (!Array.isArray(data?.body)) throw new Error('字幕格式异常，未找到正文。');
    const result = data.body.map((row) => {
      if (typeof row?.from !== 'number' || typeof row?.to !== 'number' ||
          !Number.isFinite(row.from) || !Number.isFinite(row.to) ||
          row.from < 0 || row.to <= row.from || typeof row.content !== 'string') {
        throw new Error('字幕包含无效时间轴或正文，已停止导出。');
      }
      return { from: row.from, to: row.to, content: row.content.replace(/\r\n?/g, '\n').trim() };
    }).filter((row) => row.content);
    if (!result.length) throw new Error('字幕正文为空。');
    return result.sort((a, b) => a.from - b.from);
  }

  function convert(data, format) {
    const rows = cues(data);
    if (format === 'txt') return rows.map((row) => row.content).join('\r\n') + '\r\n';
    if (format !== 'srt') throw new Error('不支持的格式。');
    return rows.map((row, i) => `${i + 1}\r\n${timestamp(row.from)} --> ${timestamp(row.to)}\r\n${row.content.replace(/\n+/g, '\r\n')}`).join('\r\n\r\n') + '\r\n';
  }

  function filename(value) {
    return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 150) || '字幕';
  }

  function subtitleUrl(value) {
    const url = new URL(value, 'https://www.bilibili.com');
    if (!['http:', 'https:'].includes(url.protocol) ||
        !/(^|\.)(hdslb\.com|bilibili\.com)$/.test(url.hostname)) {
      throw new Error('字幕地址不属于已支持的 B 站域名。');
    }
    url.protocol = 'https:';
    return url.href;
  }

  function problem(message, kind = 'format', extra = {}) {
    return Object.assign(new Error(message), { kind }, extra);
  }

  // 只处理 JSON 字符串之外的整数，避免评论 ID 超过 2^53 后被舍入。
  function parseJson(text) {
    return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
      /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? `"${token}"` : token));
  }

  function idString(value, fallback = '0') {
    if (value == null) return fallback;
    if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) {
      throw problem('评论 ID 格式异常，已暂停以避免破坏回复关系。');
    }
    return String(value);
  }

  function countValue(value) {
    return ['number', 'string'].includes(typeof value) && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0
      ? Number(value) : null;
  }

  // WBI 使用 MD5；按 RFC 1321 计算，脚本不加载远程依赖。
  function md5(value) {
    const bytes = new TextEncoder().encode(value);
    const length = Math.ceil((bytes.length + 9) / 64) * 64;
    const buffer = new Uint8Array(length);
    buffer.set(bytes);
    buffer[bytes.length] = 128;
    const view = new DataView(buffer.buffer);
    view.setUint32(length - 8, bytes.length * 8 >>> 0, true);
    view.setUint32(length - 4, Math.floor(bytes.length / 0x20000000), true);
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    for (let offset = 0; offset < length; offset += 64) {
      let aa = a, bb = b, cc = c, dd = d;
      for (let i = 0; i < 64; i++) {
        const round = i >>> 4;
        const f = round === 0 ? (bb & cc) | (~bb & dd) : round === 1 ? (dd & bb) | (~dd & cc)
          : round === 2 ? bb ^ cc ^ dd : cc ^ (bb | ~dd);
        const g = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
        const n = (aa + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getUint32(offset + g * 4, true)) | 0;
        const shift = shifts[round * 4 + i % 4];
        const next = (bb + ((n << shift) | (n >>> (32 - shift)))) | 0;
        aa = dd; dd = cc; cc = bb; bb = next;
      }
      a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
    }
    return [a, b, c, d].map((n) => [0, 8, 16, 24].map((s) => ((n >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('');
  }

  function wbiQuery(params, images, seconds = Math.floor(Date.now() / 1000)) {
    const key = (url) => String(url || '').match(/\/([a-f0-9]{32})\.[a-z]+(?:\?.*)?$/i)?.[1];
    const img = key(images?.img_url), sub = key(images?.sub_url);
    if (!img || !sub) throw problem('未取得 WBI 参数，请稍后重新继续。', 'signature');
    const tab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
    const raw = img + sub;
    const mixin = tab.map((n) => raw[n]).join('').slice(0, 32);
    const values = { ...params, wts: seconds };
    const query = Object.keys(values).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(values[k]).replace(/[!'()*]/g, ''))}`).join('&');
    return `${query}&w_rid=${md5(query + mixin)}`;
  }

  function apiData(result) {
    if (result?.code !== 0) {
      const code = result?.code;
      const kind = [-101, -111].includes(code) ? 'auth' : [-352, -412, -509].includes(code) ? 'risk' : code === -403 ? 'signature' : 'api';
      throw problem(kind === 'auth' ? '请在 B 站网页登录后继续。'
        : `B站接口错误 ${code ?? '未知'}：${result?.message || '请稍后重试'}`, kind, { code });
    }
    if (result.data?.v_voucher) throw problem('B站要求安全验证，请在网页完成验证后手动继续。', 'risk');
    if (!result.data || typeof result.data !== 'object') throw problem('接口数据缺失，已暂停。');
    return result.data;
  }

  function normalizeComment(item, rootHint = '0') {
    const id = idString(item?.rpid_str ?? item?.rpid);
    if (id === '0' || typeof item?.content?.message !== 'string') throw problem('评论缺少 ID 或正文，已暂停。');
    const root = idString(item.root_str ?? item.root, rootHint);
    if (rootHint !== '0' && (root !== rootHint || id === rootHint)) throw problem('楼中楼所属评论不匹配，已暂停。');
    const ctime = countValue(item.ctime);
    if (ctime === null || !Number.isFinite(new Date(ctime * 1000).getTime())) throw problem('评论发布时间无效。');
    return {
      id, root_id: root, parent_id: idString(item.parent_str ?? item.parent, root),
      uid: idString(item.member?.mid ?? item.mid_str ?? item.mid), username: item.member?.uname || '',
      text: item.content.message.replace(/\r\n?/g, '\n'), created_at: new Date(ctime * 1000).toISOString(),
      ctime, likes: countValue(item.like) ?? 0,
      pictures: (Array.isArray(item.content.pictures) ? item.content.pictures : []).map((p) => ({ url: p.img_src || '', width: p.img_width, height: p.img_height })),
      emotes: Object.fromEntries(Object.entries(item.content.emote || {}).map(([k, v]) => [k, v?.url || ''])),
    };
  }

  function newJob(videoInfo, account) {
    return {
      schema: 1, key: `${videoInfo.aid}:${account}`, account, video: videoInfo,
      stage: 'roots', status: 'paused', cursor: '', seenCursors: [], rootFingerprints: [], rootPages: 0, replyPages: 0,
      firstTotal: null, latestTotal: null, startedAt: new Date().toISOString(), updatedAt: null,
      warnings: [], failures: [], rows: new Map(), threads: new Map(),
    };
  }

  function warn(state, message) { if (!state.warnings.includes(message)) state.warnings.push(message); }
  function observe(state, data) {
    if (data.control?.web_selection) warn(state, '本评论区开启了评论精选，只能获取当前账号可见的评论。');
    if (data.folder?.has_folded) warn(state, '接口提示存在折叠评论，折叠内容的覆盖范围无法确认。');
  }

  function addRows(state, rows) {
    for (const row of rows) state.rows.set(row.id, row);
    return rows;
  }

  function rootPage(state, data) {
    const cursor = data.cursor;
    if (!cursor || typeof cursor.is_end !== 'boolean' || (cursor.mode != null && Number(cursor.mode) !== 2)) {
      throw problem('一级评论分页或时间排序不可用，已暂停；未标记为完成。');
    }
    if (data.replies != null && !Array.isArray(data.replies)) throw problem('一级评论列表格式异常。');
    const next = cursor.pagination_reply?.next_offset;
    if (!cursor.is_end && (typeof next !== 'string' || !next || next === state.cursor || state.seenCursors.includes(next))) {
      throw problem('一级评论缺少下一页游标或游标重复，已暂停；未标记为完成。');
    }
    if (!cursor.is_end && !data.replies?.length) throw problem('一级评论提前返回空页，已暂停；未标记为完成。');
    const fingerprint = (data.replies || []).map((r) => idString(r?.rpid_str ?? r?.rpid)).join(',');
    if (fingerprint && state.rootFingerprints.includes(fingerprint)) throw problem('一级评论重复返回同一页，已暂停；未标记为完成。');
    const pinned = [...(Array.isArray(data.top_replies) ? data.top_replies : []), ...Object.values(data.top || {}), data.upper?.top];
    const items = [...(data.replies || []), ...(Array.isArray(data.hots) ? data.hots : []), ...pinned.filter((x) => x?.rpid || x?.rpid_str)];
    const rows = [], threads = new Map();
    // 先校验整页，再改变进度；预览回复也保存，但仍独立遍历楼中楼。
    for (const item of items) {
      const root = normalizeComment(item);
      if (root.root_id !== '0') throw problem('一级评论接口返回了不匹配的回复关系。');
      rows.push(root);
      const previews = Array.isArray(item.replies) ? item.replies : [];
      rows.push(...previews.map((child) => normalizeComment(child, root.id)));
      const expected = countValue(item.rcount) ?? countValue(item.count);
      const previous = threads.get(root.id) || state.threads.get(root.id);
      const target = expected === null ? null : Math.max(expected, previous?.expected || 0, previews.length);
      threads.set(root.id, previous ? { ...previous, expected: target,
        done: previous.done && target === 0 } : { id: root.id, expected: target, page: 1, done: target === 0, failed: false, fingerprints: [] });
    }
    observe(state, data);
    const total = countValue(cursor.all_count);
    if (total !== null) {
      if (state.firstTotal === null) state.firstTotal = total;
      if (state.latestTotal !== null && total !== state.latestTotal) warn(state, '采集期间接口评论总数发生变化。');
      state.latestTotal = total;
    }
    addRows(state, rows);
    for (const [id, thread] of threads) state.threads.set(id, thread);
    if (fingerprint) state.rootFingerprints.push(fingerprint);
    state.rootPages++;
    if (cursor.is_end) state.stage = 'replies';
    else { state.seenCursors.push(next); state.cursor = next; }
    return { rows, threads: [...threads.values()] };
  }

  function replyPage(state, thread, data) {
    const page = data.page;
    const count = countValue(page?.count), size = countValue(page?.size);
    if (count === null || !size || size > 20 || Number(page.num) !== thread.page || (data.replies != null && !Array.isArray(data.replies))) {
      throw problem('楼中楼分页数据异常，已暂停；未标记为完成。');
    }
    if (data.root && idString(data.root.rpid_str ?? data.root.rpid) !== thread.id) throw problem('楼中楼根评论不匹配。');
    const rows = (data.replies || []).map((item) => normalizeComment(item, thread.id));
    const end = thread.page * size >= count;
    if (!rows.length && count > 0) throw problem('楼中楼提前返回空页，已暂停；未标记为完成。');
    if (rows.length > size) throw problem('楼中楼每页数量异常。');
    const fingerprint = rows.map((r) => r.id).join(',');
    if (rows.length && thread.fingerprints.includes(fingerprint)) throw problem('楼中楼重复返回相同页面，已暂停；未标记为完成。');
    if (thread.expected !== null && count !== thread.expected) warn(state, '部分楼中楼回复数量发生变化，详见逐楼统计。');
    observe(state, data);
    if (rows.length) thread.fingerprints.push(fingerprint);
    thread.expected = count;
    thread.page++;
    thread.done = end;
    thread.failed = false;
    state.replyPages++;
    addRows(state, rows);
    return { rows, threads: [thread] };
  }

  function report(state) {
    const counts = new Map();
    let roots = 0, replies = 0;
    for (const row of state.rows.values()) {
      if (row.root_id === '0') roots++;
      else { replies++; counts.set(row.root_id, (counts.get(row.root_id) || 0) + 1); }
    }
    const threads = [...state.threads.values()].map((t) => ({
      id: t.id, expected: t.expected, collected: counts.get(t.id) || 0, done: t.done, failed: t.failed,
      next_page: t.page, difference: t.expected === null ? null : t.expected - (counts.get(t.id) || 0),
    }));
    const failed = threads.filter((t) => t.failed).length;
    const unfinished = threads.filter((t) => !t.done && !t.failed).length;
    const mismatch = threads.filter((t) => t.difference !== null && t.difference !== 0).length;
    const difference = state.latestTotal === null ? null : state.latestTotal - state.rows.size;
    const ended = state.stage === 'done';
    return {
      schema: 1, video: state.video, started_at: state.startedAt, saved_at: state.updatedAt,
      status: !ended ? 'incomplete' : failed || mismatch || (difference !== null && difference !== 0) ? 'finished_with_gaps' : 'traversal_finished',
      scope: '当前账号在采集期间可访问的评论；分页结束或数量相同不能证明覆盖全部历史评论。',
      roots, replies, collected: state.rows.size, api_total_first: state.firstTotal, api_total_latest: state.latestTotal,
      difference, root_pages: state.rootPages, reply_pages: state.replyPages,
      threads_done: threads.filter((t) => t.done).length, threads_failed: failed, threads_pending: unfinished,
      threads_with_difference: mismatch, warnings: [...state.warnings], failures: state.failures.map((f) => ({ ...f })), threads,
    };
  }

  function orderedComments(state) {
    const all = [...state.rows.values()];
    const roots = all.filter((r) => r.root_id === '0').sort((a, b) => b.ctime - a.ctime || a.id.localeCompare(b.id));
    const groups = new Map();
    for (const row of all) if (row.root_id !== '0') {
      if (!groups.has(row.root_id)) groups.set(row.root_id, []);
      groups.get(row.root_id).push(row);
    }
    const rows = [];
    for (const root of roots) {
      rows.push(root);
      for (const child of (groups.get(root.id) || []).sort((a, b) => a.ctime - b.ctime || a.id.localeCompare(b.id))) rows.push(child);
      groups.delete(root.id);
    }
    for (const group of groups.values()) for (const row of group) rows.push(row);
    return rows;
  }

  function commentExport(state, format) {
    const summary = report(state), rows = orderedComments(state);
    if (format === 'json') return JSON.stringify({ report: summary, comments: rows }, null, 2);
    if (format === 'report') return JSON.stringify(summary, null, 2);
    if (format === 'txt') return [
      `视频：${state.video.title}\nhttps://www.bilibili.com/video/${state.video.bvid}`,
      `状态：${summary.status}\n一级评论 ${summary.roots}，楼中楼 ${summary.replies}，接口最近报告 ${summary.api_total_latest ?? '未知'}，差额 ${summary.difference ?? '未知'}`,
      summary.scope, ...summary.warnings,
      ...summary.failures.map((f) => `失败记录${f.resolved ? '（已恢复）' : '（未解决）'}：${f.at} ${f.unit} ${f.message}`),
      ...rows.map((r) => `[${r.root_id === '0' ? '一级评论' : '楼中楼'} ${r.id}] ${r.username} (UID ${r.uid})\n${r.created_at} | 点赞 ${r.likes} | 根评论 ${r.root_id} | 回复 ${r.parent_id}\n${r.text}${r.pictures.length ? '\n图片：' + r.pictures.map((p) => p.url).join('\n') : ''}`),
    ].join('\r\n\r\n') + '\r\n';
    if (format !== 'csv') throw problem('不支持的评论导出格式。');
    // CSV 用户文本加前置单引号，避免 Excel 把评论正文解释成公式。
    const cell = (v, text = false) => {
      let s = String(v ?? '');
      if (text && /^[\s\uFEFF]*[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const header = ['评论ID', '根评论ID', '回复目标ID', 'UID', '昵称', '发布时间UTC', '点赞数', '正文', '图片URL', '采集状态'];
    return [header.map((v) => cell(v)).join(','), ...rows.map((r) => [
      cell(r.id), cell(r.root_id), cell(r.parent_id), cell(r.uid), cell(r.username, true), cell(r.created_at), cell(r.likes),
      cell(r.text, true), cell(r.pictures.map((p) => p.url).join('\n'), true), cell(summary.status),
    ].join(','))].join('\r\n') + '\r\n';
  }

  function checkAbort(signal) { if (signal?.aborted) throw problem('采集已暂停。', 'abort'); }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      const abort = () => { clearTimeout(timer); reject(problem('采集已暂停。', 'abort')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async function collectComments(state, { fetchPage, save, changed = () => {}, signal }) {
    const checkpoint = async (delta = {}) => {
      state.updatedAt = new Date().toISOString();
      try { await save(state, delta); }
      catch (e) { throw problem(`本地保存失败：${e.message || '存储空间不足'}。已停止，请保留上一次进度。`, 'storage'); }
      changed(state);
    };
    let unit = '开始';
    try {
      state.status = 'running';
      const retry = [...state.threads.values()].filter((t) => t.failed);
      for (const t of retry) t.failed = false;
      if (state.stage === 'done' && retry.length) state.stage = 'replies';
      await checkpoint({ threads: retry });
      while (state.stage === 'roots') {
        checkAbort(signal);
        unit = `一级评论:${state.cursor || '第一页'}`;
        const data = await fetchPage('/x/v2/reply/wbi/main', {
          oid: state.video.aid, type: 1, mode: 2, plat: 1, web_location: '1315875',
          pagination_str: JSON.stringify({ offset: state.cursor }),
        }, true);
        checkAbort(signal);
        const delta = rootPage(state, data);
        for (const f of state.failures) if (f.unit === unit) f.resolved = true;
        await checkpoint(delta);
      }
      // 不可访问的单个楼层留在失败列表，继续处理其他楼层；限流和网络异常则暂停整个任务。
      for (const thread of state.threads.values()) while (!thread.done && !thread.failed) {
        checkAbort(signal);
        unit = `楼中楼:${thread.id}:第${thread.page}页`;
        let data;
        try { data = await fetchPage('/x/v2/reply/reply', { oid: state.video.aid, type: 1, root: thread.id, ps: 20, pn: thread.page }); }
        catch (e) {
          if (e.kind !== 'api' || e.code !== -404) throw e;
          thread.failed = true;
          state.failures.push({ at: new Date().toISOString(), unit, message: e.message, code: e.code, resolved: false });
          await checkpoint({ threads: [thread] });
          continue;
        }
        checkAbort(signal);
        const delta = replyPage(state, thread, data);
        for (const f of state.failures) if (f.unit === unit) f.resolved = true;
        await checkpoint(delta);
      }
      checkAbort(signal);
      unit = '结束数量校验';
      // 数量校验失败也保留结束阶段，以便手动继续校验，避免误报完成。
      state.stage = 'verify';
      const latest = await fetchPage('/x/v2/reply/count', { oid: state.video.aid, type: 1 });
      checkAbort(signal);
      const total = countValue(latest.count);
      if (total === null) throw problem('接口未返回有效评论总数，已暂停数量校验。');
      if (state.latestTotal !== null && total !== state.latestTotal) warn(state, '采集期间接口评论总数发生变化。');
      state.latestTotal = total;
      state.stage = 'done';
      state.status = 'finished';
      for (const f of state.failures) if (f.unit === unit) f.resolved = true;
      await checkpoint();
    } catch (error) {
      if (error.kind === 'storage') throw error;
      state.status = 'paused';
      if (error.kind !== 'abort') state.failures.push({ at: new Date().toISOString(), unit, message: error.message, code: error.code, kind: error.kind, resolved: false });
      await checkpoint();
      if (error.kind !== 'abort') throw error;
    }
    return state;
  }

  function commentStore() {
    let opening;
    function open() {
      if (!opening) opening = new Promise((resolve, reject) => {
        const req = indexedDB.open('bilibili-comment-exporter', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('jobs', { keyPath: 'key' });
          for (const name of ['rows', 'threads']) db.createObjectStore(name, { keyPath: ['job', 'id'] }).createIndex('job', 'job');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { opening = null; reject(req.error); };
        req.onblocked = () => { opening = null; reject(problem('本地数据库被其他旧标签页占用，请关闭旧标签页后重试。', 'storage')); };
      });
      return opening;
    }
    async function read(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['jobs', 'rows', 'threads'], 'readonly');
        const job = tx.objectStore('jobs').get(key);
        const rows = tx.objectStore('rows').index('job').getAll(key);
        const threads = tx.objectStore('threads').index('job').getAll(key);
        tx.oncomplete = () => {
          if (!job.result) { resolve(null); return; }
          if (job.result.schema !== 1) { reject(problem('本地进度版本不兼容。', 'storage')); return; }
          const unpack = (items) => new Map(items.map(({ job: _job, ...item }) => [item.id, item]));
          resolve({ ...job.result, rows: unpack(rows.result), threads: unpack(threads.result) });
        };
        tx.onerror = tx.onabort = () => reject(tx.error || problem('读取本地进度失败。', 'storage'));
      });
    }
    return {
      read,
      async find(id) {
        const db = await open();
        const jobs = await new Promise((resolve, reject) => {
          const req = db.transaction('jobs').objectStore('jobs').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const match = jobs.filter((j) => j.video.bvid === id || `av${j.video.aid}`.toLowerCase() === id.toLowerCase())
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
        return match ? read(match.key) : null;
      },
      async save(state, { rows = [], threads = [] } = {}) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(['jobs', 'rows', 'threads'], 'readwrite');
          tx.oncomplete = resolve;
          tx.onerror = tx.onabort = () => reject(tx.error || problem('写入本地进度失败。', 'storage'));
          try {
            const { rows: _rows, threads: _threads, ...meta } = state;
            tx.objectStore('jobs').put(meta);
            for (const row of rows) tx.objectStore('rows').put({ ...row, job: state.key });
            for (const thread of threads) tx.objectStore('threads').put({ ...thread, job: state.key });
          } catch (error) {
            // put() 同步抛错也必须主动中止，不能只提交已写入的游标。
            tx.abort();
            reject(error);
          }
        });
      },
      async remove(key) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction(['jobs', 'rows', 'threads'], 'readwrite');
          tx.objectStore('jobs').delete(key);
          for (const name of ['rows', 'threads']) {
            const req = tx.objectStore(name).index('job').openCursor(key);
            req.onsuccess = () => { if (req.result) { req.result.delete(); req.result.continue(); } };
          }
          tx.oncomplete = resolve;
          tx.onerror = tx.onabort = () => reject(tx.error || problem('删除本地进度失败。', 'storage'));
        });
      },
    };
  }

  function commentClient({ signal, interval = 2000, requestFn = request, wait = delay,
    now = Date.now, random = Math.random, note = () => {} } = {}) {
    let last = -Infinity, images = null, keyTime = 0, account = null;
    const spacing = Math.max(1500, Math.min(60000, Number(interval) || 2000));
    async function call(path, params = {}, signed = false) {
      for (let attempt = 0; ; attempt++) {
        checkAbort(signal);
        await wait(Math.max(0, last + spacing + random() * 500 - now()), signal);
        checkAbort(signal);
        last = now();
        const query = signed ? wbiQuery(params, images, Math.floor(now() / 1000)) : new URLSearchParams(params).toString();
        try { return apiData(await requestFn(`https://api.bilibili.com${path}?${query}`, false, signal)); }
        catch (e) {
          if (e.kind !== 'network' || attempt >= 2 || signal?.aborted) throw e;
          note(`网络暂时失败，${(attempt + 1) * 3} 秒后重试（${attempt + 1}/2）…`);
          await wait((attempt + 1) * 3000, signal);
        }
      }
    }
    async function initialize() {
      const data = await call('/x/web-interface/nav');
      if (!data.isLogin || !data.mid) throw problem('请在 B 站网页登录后开始或继续采集。', 'auth');
      const currentAccount = idString(data.mid);
      if (account && account !== currentAccount) throw problem('登录账号已改变，请重新点击继续以加载该账号的进度。', 'auth');
      account = currentAccount;
      images = data.wbi_img;
      // 提前校验参数；不请求口令对应的图片地址。
      wbiQuery({}, images);
      keyTime = now();
      return account;
    }
    return {
      initialize,
      async fetchPage(path, params, signed = false) {
        if (signed && (!images || now() - keyTime > 30 * 60 * 1000)) await initialize();
        return call(path, params, signed);
      },
    };
  }

  // 同一份实现供 Node 测试加载；浏览器运行不依赖外部库。
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = { route, timestamp, cues, convert, filename, subtitleUrl, problem, parseJson, md5, wbiQuery,
      apiData, normalizeComment, newJob, rootPage, replyPage, report, commentExport, collectComments, commentStore, commentClient };
    return;
  }

  function request(url, anonymous = false, signal) {
    return new Promise((resolve, reject) => {
      checkAbort(signal);
      let handle;
      const finish = (callback, value) => { signal?.removeEventListener('abort', abort); callback(value); };
      const abort = () => { handle?.abort(); finish(reject, problem('采集已暂停。', 'abort')); };
      signal?.addEventListener('abort', abort, { once: true });
      handle = GM_xmlhttpRequest({
        method: 'GET', url, anonymous, timeout: 20000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            const kind = [403, 412, 429].includes(response.status) ? 'risk' : response.status === 401 ? 'auth'
              : response.status >= 500 || response.status === 0 ? 'network' : 'api';
            finish(reject, problem(`请求失败（HTTP ${response.status}），请稍后重试。`, kind, { code: response.status }));
            return;
          }
          try { finish(resolve, parseJson(response.responseText)); }
          catch { finish(reject, problem('接口未返回有效 JSON，可能需要网页验证。请检查 B 站页面后重试。', 'risk')); }
        },
        onerror: () => finish(reject, problem('网络请求失败，请检查网络和篡改猴站点权限。', 'network')),
        ontimeout: () => finish(reject, problem('请求超时，请重试。', 'network')),
        onabort: () => finish(reject, problem('采集已暂停。', 'abort')),
      });
    });
  }

  async function api(path, params) {
    const result = await request(`https://api.bilibili.com${path}?${new URLSearchParams(params)}`);
    return apiData(result);
  }

  const host = document.createElement('div');
  host.id = 'bilibili-subtitle-exporter';
  host.style.cssText = 'position:fixed;right:20px;bottom:32px;z-index:2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{font:14px/1.5 system-ui,sans-serif;color:#202b3c;color-scheme:light}
      :host([hidden]){display:none!important}
      *{box-sizing:border-box}button,select,input{font:inherit}
      button{cursor:pointer;border:0;border-radius:8px;padding:8px 12px;background:#087fa3;color:white}
      button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,select:focus-visible{outline:3px solid #ffb347}
      #panel{width:min(420px,calc(100vw - 40px));max-height:80vh;overflow:auto;padding:16px;background:#fff;border:1px solid #d5e4eb;border-radius:12px;box-shadow:0 5px 24px #0002;margin-bottom:8px}
      [hidden]{display:none!important}h2{font-size:16px;margin:0 0 10px}
      #title{font-size:12px;overflow-wrap:anywhere;color:#536273;margin-bottom:8px}
      #status,#comment-status,#comment-log{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0}
      select{width:100%;padding:7px;margin:6px 0 10px;background:white;color:#202b3c;border:1px solid #adbdc7;border-radius:6px}
      .actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}#toggle{float:right}label{display:block;margin-top:10px}
      #note,.note{font-size:12px;color:#64748b;margin:10px 0 0}
      hr{border:0;border-top:1px solid #d5e4eb;margin:18px 0}input{width:75px;padding:5px}
      #comment-log{font:12px/1.5 system-ui;max-height:160px;overflow:auto}summary{cursor:pointer}
      .secondary{background:#edf4f7;color:#294356}
    </style>
    <section id="panel" hidden aria-label="B站字幕和评论提取">
      <h2>当前分 P · 字幕提取</h2>
      <div id="title"></div>
      <button id="read" type="button">读取字幕</button>
      <div id="status" role="status" aria-live="polite">点击读取当前视频字幕。</div>
      <label for="language">字幕语言</label>
      <select id="language" disabled aria-label="字幕语言"></select>
      <div class="actions"><button id="txt" disabled>下载 TXT</button><button id="srt" disabled>下载 SRT</button></div>
      <p id="note">仅提取已有字幕；不含语音转文字。全屏播放时请先退出全屏。</p>
      <hr>
      <h2>整个视频 · 评论与楼中楼</h2>
      <p class="note">评论由所有分 P 共用。自动保存到本浏览器，刷新后点击继续。需要先登录 B 站。</p>
      <label for="comment-interval">请求间隔（秒，另加少量随机等待）
        <input id="comment-interval" type="number" min="1.5" max="60" step="0.5" value="2">
      </label>
      <div class="actions"><button id="comments-start">开始采集</button><button id="comments-pause" disabled>暂停</button></div>
      <div id="comment-status" role="status" aria-live="polite">正在检查本地进度…</div>
      <div class="actions">
        <button id="comments-txt" disabled>评论 TXT</button><button id="comments-csv" disabled>评论 CSV</button><button id="comments-json" disabled>评论 JSON</button>
      </div>
      <div class="actions"><button id="comments-report" class="secondary" disabled>采集报告 JSON</button><button id="comments-clear" class="secondary" disabled>清空本地进度</button></div>
      <details><summary>采集记录与完整性说明</summary><pre id="comment-log"></pre></details>
      <p class="note">可随时导出已保存结果。已删除、审核中或权限不可见的评论无法保证获取；分页结束或数量相同不能证明覆盖全部历史评论。CSV 中长 ID 请按文本列导入，原始 ID 以 JSON 为准。</p>
    </section>
    <button id="toggle" type="button" aria-expanded="false" aria-controls="panel">字幕 / 评论提取</button>`;
  document.body.append(host);
  const el = (id) => shadow.getElementById(id);
  let activeKey = '';
  let version = 0;
  let busy = false;
  let video = null;
  let tracks = [];
  const cache = new Map();
  const localComments = commentStore();
  let commentVideo = '', commentEpoch = 0, commentState = null, commentController = null;
  let commentBusy = false, commentLoading = false, commentStorageError = false, commentNote = '';

  function renderComments(note) {
    if (note !== undefined) commentNote = note;
    const summary = commentState ? report(commentState) : null;
    const ended = summary && commentState.stage === 'done' && !summary.threads_failed;
    el('comments-start').disabled = commentBusy || commentLoading || commentStorageError || ended;
    el('comments-start').textContent = !commentState ? '开始采集' : ended ? '遍历已结束' : summary.threads_failed ? '继续 / 重试失败楼层' : '继续采集';
    el('comments-pause').disabled = !commentBusy || commentController?.signal.aborted;
    el('comment-interval').disabled = commentBusy || commentLoading;
    el('comments-clear').disabled = commentBusy || commentLoading || !commentState;
    for (const format of ['txt', 'csv', 'json', 'report']) el(`comments-${format}`).disabled = !commentState || commentLoading;
    const stage = !summary ? '' : commentBusy ? '采集中' : commentState.stage === 'done'
      ? summary.status === 'finished_with_gaps' ? '遍历结束，有数量差异或失败楼层' : '遍历结束（当前可访问范围）' : '已暂停，可继续';
    el('comment-status').textContent = [commentNote, summary ?
      `${commentState.video.title}\n${stage}\n一级评论 ${summary.roots} · 楼中楼 ${summary.replies} · 去重后 ${summary.collected}\n一级评论 ${summary.root_pages} 页 · 楼中楼 ${summary.reply_pages} 页\n楼层已完成 ${summary.threads_done} · 待处理 ${summary.threads_pending} · 失败 ${summary.threads_failed}\n接口最近总数 ${summary.api_total_latest ?? '未知'} · 差额 ${summary.difference ?? '未知'}` : '点击开始，获取整个视频可访问的评论。'].filter(Boolean).join('\n');
    el('comment-log').textContent = summary ? [
      `保存于 ${summary.saved_at || '尚未保存'}；进度按视频和登录账号分别保存。`,
      summary.scope, ...summary.warnings,
      ...summary.failures.slice(-20).map((f) => `${f.resolved ? '已恢复' : '未解决'} | ${f.at} | ${f.unit} | ${f.message}`),
      summary.failures.length > 20 ? '完整失败记录见采集报告。' : '',
    ].filter(Boolean).join('\n') : '数据只存放在本浏览器的 B 站本地数据库；清理站点数据会删除进度。';
  }

  async function loadLocalComments(id, epoch) {
    try {
      const state = await localComments.find(id);
      if (epoch !== commentEpoch) return;
      commentState = state;
      commentStorageError = false;
      commentNote = state ? '已恢复本地进度。点击继续后会核对当前登录账号。' : '';
    } catch (error) {
      if (epoch !== commentEpoch) return;
      commentStorageError = true;
      commentNote = `无法使用本地数据库：${error.message}。请检查浏览器存储权限后刷新。`;
    } finally {
      if (epoch === commentEpoch) { commentLoading = false; renderComments(); }
    }
  }

  function syncCommentRoute(current) {
    const id = current?.id || '';
    if (id === commentVideo) return;
    commentController?.abort();
    commentController = null;
    commentVideo = id;
    const epoch = ++commentEpoch;
    commentBusy = false;
    commentState = null;
    commentStorageError = false;
    commentLoading = !!id;
    renderComments(id ? '正在检查本地进度…' : '请打开普通视频页。');
    if (id) void loadLocalComments(id, epoch);
  }

  async function jobLock(key, action) {
    if (!navigator.locks?.request) throw problem('当前浏览器不支持安全续传所需的 Web Locks，请使用新版 Chrome、Edge 或 Firefox。', 'storage');
    return navigator.locks.request(`bilibili-comment-exporter:${key}`, { ifAvailable: true }, (lock) => {
      if (!lock) throw problem('另一个标签页正在采集或清理这个视频，请先在那个标签页暂停。', 'locked');
      return action();
    });
  }

  el('comments-start').onclick = async () => {
    const current = syncRoute();
    if (!current || commentBusy || commentLoading) return;
    const epoch = commentEpoch, controller = new AbortController();
    commentController = controller;
    commentBusy = true;
    let state;
    const valid = () => { syncRoute(); return epoch === commentEpoch; };
    const show = (note) => { if (valid()) renderComments(note); };
    renderComments('正在核对登录账号和视频信息…');
    try {
      const client = commentClient({ signal: controller.signal,
        interval: Number(el('comment-interval').value) * 1000, note: show });
      const account = await client.initialize();
      const info = await client.fetchPage('/x/web-interface/view', /^av/i.test(current.id) ? { aid: current.id.slice(2) } : { bvid: current.id });
      checkAbort(controller.signal);
      const aid = idString(info.aid);
      if (aid === '0' || !/^BV[0-9A-Za-z]+$/.test(info.bvid || '')) throw problem('视频信息缺少有效的 AV/BV 号。');
      await jobLock(`${aid}:${account}`, async () => {
        checkAbort(controller.signal);
        state = await localComments.read(`${aid}:${account}`) || newJob({ aid, bvid: info.bvid, title: info.title || info.bvid }, account);
        checkAbort(controller.signal);
        if (!valid()) return;
        commentState = state;
        show('按时间采集一级评论，再逐楼采集回复。每页写入后自动保存。');
        await collectComments(state, {
          signal: controller.signal, fetchPage: client.fetchPage, save: localComments.save,
          changed: () => { if (valid()) { commentState = state; renderComments(); } },
        });
        show(controller.signal.aborted ? '已暂停，最后一页已保存，可继续或导出。' : '遍历已结束。请查看数量差异和采集报告。');
      });
    } catch (error) {
      if (error.kind === 'storage' && state) {
        // 存储失败时只恢复最后一次已提交事务，不能用内存里已前移的游标覆盖它。
        try { state = await localComments.read(state.key); if (valid()) commentState = state; } catch { /* 保留明确的存储失败提示 */ }
      }
      show(error.kind === 'abort' ? '已暂停，可以继续采集。' : `${error.message || '采集失败'}${error.kind === 'risk' ? '\n请在 B 站网页检查验证提示，稍后手动继续。' : ''}`);
    } finally {
      if (valid()) { commentBusy = false; commentController = null; renderComments(); }
    }
  };
  el('comments-pause').onclick = () => {
    commentController?.abort();
    renderComments('正在暂停并保存进度…');
  };

  function saveFile(content, name, type = 'text/plain;charset=utf-8', bom = true) {
    const url = URL.createObjectURL(new Blob(bom ? ['\uFEFF', content] : [content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  for (const format of ['txt', 'csv', 'json', 'report']) el(`comments-${format}`).onclick = async () => {
    syncRoute();
    if (!commentState) return;
    const epoch = commentEpoch, key = commentState.key;
    try {
      const saved = await localComments.read(key);
      if (epoch !== commentEpoch) return;
      if (!saved) throw problem('尚无已保存的数据，请先开始采集。');
      const status = report(saved).status;
      const label = status === 'incomplete' ? '未完成' : status === 'finished_with_gaps' ? '遍历结束_有差异' : '遍历结束';
      const name = filename(`${saved.video.title}_${saved.video.bvid}_${format === 'report' ? '采集报告' : '评论'}_${label}`) + `.${format === 'report' ? 'json' : format}`;
      saveFile(commentExport(saved, format), name, format === 'json' || format === 'report' ? 'application/json;charset=utf-8' : format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8', format === 'txt' || format === 'csv');
      renderComments(`已发起下载：${name}${format === 'csv' ? '\n完整性和失败记录请同时下载采集报告。' : ''}`);
    } catch (error) { if (epoch === commentEpoch) renderComments(`导出失败：${error.message}`); }
  };

  el('comments-clear').onclick = async () => {
    if (!commentState || commentBusy || commentLoading) return;
    const state = commentState, epoch = commentEpoch;
    if (!window.confirm(`清空“${state.video.title}”这份本地评论和进度？请先导出需要保留的结果。`)) return;
    commentLoading = true;
    renderComments('正在清空本地进度…');
    try {
      await jobLock(state.key, () => localComments.remove(state.key));
      if (epoch === commentEpoch) { commentState = null; renderComments('已清空，可以重新采集。'); }
    } catch (error) { if (epoch === commentEpoch) renderComments(error.message); }
    finally { if (epoch === commentEpoch) { commentLoading = false; renderComments(); } }
  };

  function buttons() {
    el('read').disabled = busy;
    el('language').disabled = busy || !tracks.length;
    el('txt').disabled = el('srt').disabled = busy || !tracks.length;
  }

  function syncVisibility(current = route(location.href)) {
    // 网页全屏通过播放器状态实现，不一定触发浏览器的 fullscreenchange。
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.querySelector(
      '.bpx-player-container[data-screen="web"], .bpx-player-container[data-screen="full"], body.webscreen-fix, html.webscreen-fix'
    );
    host.hidden = !current || !!fullscreen;
  }

  function syncRoute() {
    const current = route(location.href);
    syncCommentRoute(current);
    syncVisibility(current);
    if ((current?.key || '') !== activeKey) {
      activeKey = current?.key || '';
      version++;
      busy = false;
      video = null;
      tracks = [];
      cache.clear();
      el('language').replaceChildren();
      el('title').textContent = current ? `${current.id} · P${current.p}` : '';
      el('status').textContent = '点击读取当前视频字幕。';
      buttons();
    }
    return current;
  }

  function isCurrent(token, key) {
    syncRoute();
    return token === version && key === activeKey;
  }

  async function run(action) {
    const current = syncRoute();
    if (!current || busy) return;
    const token = ++version;
    busy = true;
    buttons();
    const valid = () => isCurrent(token, current.key);
    try { await action(current, valid); }
    catch (error) { if (valid()) el('status').textContent = error.message || '提取失败，请重试。'; }
    finally { if (valid()) { busy = false; buttons(); } }
  }

  el('read').onclick = () => run(async (current, valid) => {
    tracks = [];
    cache.clear();
    el('language').replaceChildren();
    el('status').textContent = '正在读取视频和字幕列表…';
    const params = /^av/i.test(current.id) ? { aid: current.id.slice(2) } : { bvid: current.id };
    const info = await api('/x/web-interface/view', params);
    if (!valid()) return;
    const page = info.pages?.find((item) => Number(item.page) === current.p);
    if (!page?.cid) throw new Error('未找到当前分 P，请检查网址中的 p 参数。');
    video = { title: info.title, part: page.part, cid: page.cid, p: current.p, id: info.bvid || current.id };
    el('title').textContent = `${video.title} · P${video.p} ${video.part || ''}`;
    const data = await api('/x/player/wbi/v2', { ...params, cid: page.cid });
    if (!valid()) return;
    tracks = (data.subtitle?.subtitles || []).filter((item) => item.subtitle_url);
    if (!tracks.length) {
      el('status').textContent = data.need_login_subtitle
        ? '该视频字幕需要登录。请登录 B 站后重新读取。'
        : '未找到可获取的字幕。可先在播放器中开启字幕后重试；若视频没有字幕，需要另做语音转文字。';
      return;
    }
    tracks.forEach((track, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = track.lan_doc || track.lan || `字幕 ${index + 1}`;
      el('language').append(option);
    });
    el('language').value = '0';
    el('status').textContent = `找到 ${tracks.length} 种字幕，请选择语言和格式。`;
  });

  function download(format) {
    return run(async (_current, valid) => {
      const track = tracks[Number(el('language').value)];
      if (!track || !video) throw new Error('请先读取字幕。');
      el('status').textContent = '正在准备下载…';
      const url = subtitleUrl(track.subtitle_url);
      let data = cache.get(url);
      if (!data) {
        data = await request(url, true);
        if (!valid()) return;
        cache.set(url, data);
      }
      const content = convert(data, format);
      if (!valid()) return;
      const name = filename(`${video.title}_${video.id}_P${video.p}_${video.part || ''}_${track.lan || '字幕'}`) + '.' + format;
      const blobUrl = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      el('status').textContent = `已发起下载：${name}`;
    });
  }
  el('txt').onclick = () => download('txt');
  el('srt').onclick = () => download('srt');
  el('toggle').onclick = () => {
    el('panel').hidden = !el('panel').hidden;
    el('toggle').setAttribute('aria-expanded', String(!el('panel').hidden));
    syncRoute();
  };
  syncRoute();
  // URL 检查不发网络请求，也覆盖 B 站 pushState 导航与分 P 自动切换。
  setInterval(syncRoute, 700);
  window.addEventListener('popstate', syncRoute);
  document.addEventListener('fullscreenchange', () => syncVisibility());
  document.addEventListener('webkitfullscreenchange', () => syncVisibility());
  // 也覆盖播放器延迟加载、替换及网页全屏状态变化，只更新显示，不重置采集。
  new MutationObserver(() => syncVisibility()).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-screen'],
  });
})();
