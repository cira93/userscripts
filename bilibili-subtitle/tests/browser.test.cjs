// 可选：安装 Playwright 及 Chromium 后运行；所有网络由夹具接管，不接触真实账号。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* 核心测试无需第三方依赖 */ }
const source = fs.readFileSync(require.resolve('../bilibili-subtitle.user.js'), 'utf8');
let browser;
before(async () => { if (chromium) browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function fixtures({ scenario }) {
  window.__requests = [];
  window.__pending = [];
  window.__aborts = 0;
  window.__scenario = scenario;
  const realTimeout = window.setTimeout.bind(window);
  // 只加速脚本等待；低频规则本身另有使用独立时钟的核心测试。
  window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms >= 1000 ? 2 : ms, ...args);
  const realInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms) => {
    const timer = realInterval(fn, ms === 700 ? 20 : ms);
    if (ms === 700) window.__routeInterval = timer;
    return timer;
  };
  const row = (id, root = '0', parent = root, extra = {}) => ({
    rpid_str: id, root_str: root, parent_str: parent, rcount: 0,
    ctime: 1700000000, like: 3, member: { mid: '42', uname: '用户' }, content: { message: '中文\n正文[doge]' }, ...extra,
  });
  const first = row('1', '0', '0', { rcount: 2, replies: [row('2', '1')] });
  function main(rows, end, next, count = 5) {
    return { cursor: { is_end: end, mode: 2, all_count: count, pagination_reply: { next_offset: next } }, replies: rows, top: { upper: first } };
  }
  window.GM_xmlhttpRequest = (options) => {
    const url = new URL(options.url);
    window.__requests.push(options.url);
    let aborted = false;
    const deliver = () => {
      let result;
      if (url.pathname.endsWith('/nav')) result = window.__scenario === 'login' ? { code: -101, message: '未登录' }
        : { code: 0, data: { isLogin: true, mid: 42, wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
        } } };
      else if (url.pathname.endsWith('/view')) {
        const id = url.searchParams.get('bvid') || 'BV123';
        result = { code: 0, data: { aid: id === 'BV999' ? 999 : 123, bvid: id, title: `测试视频${id}`, pages: [{ page: 1, cid: 100 }] } };
      } else if (url.pathname.endsWith('/main')) {
        if (url.searchParams.get('oid') === '999') result = { code: 0, data: { ...main([row('9')], true, '', 1), top: {} } };
        else if (JSON.parse(url.searchParams.get('pagination_str')).offset) {
          result = window.__scenario === 'risk' ? { code: -412, message: '请求被限流' } : { code: 0, data: main([row('5')], true, '') };
        } else result = { code: 0, data: main([first, row('4')], false, 'next-page') };
      } else if (url.pathname.endsWith('/reply')) result = { code: 0, data: { page: { count: 2, num: 1, size: 20 }, replies: [row('2', '1'), row('3', '1', '2')] } };
      else if (url.pathname.endsWith('/count')) result = { code: 0, data: { count: url.searchParams.get('oid') === '999' ? 1 : 5 } };
      else throw new Error(`Unexpected API ${url.pathname}`);
      // 刻意允许取消后的陈旧 onload，验证脚本不会接纳过期响应。
      options.onload({ status: 200, responseText: JSON.stringify(result) });
    };
    const held = window.__scenario === 'hold' && url.pathname.endsWith('/main') &&
      JSON.parse(url.searchParams.get('pagination_str')).offset && url.searchParams.get('oid') !== '999';
    if (held) window.__pending.push(deliver);
    else realTimeout(() => { if (!aborted) deliver(); }, 0);
    return { abort() { aborted = true; window.__aborts++; options.onabort?.(); } };
  };
  if (scenario === 'quota') {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'rows') throw new DOMException('模拟存储已满', 'QuotaExceededError');
      return put.apply(this, args);
    };
  }
  window.confirm = () => true;
}

async function setup(scenario = 'normal') {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1100, height: 1000 } });
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (e) => errors.push(e.message)));
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><title>本地测试夹具</title><body><main>视频测试页</main></body></html>' }));
  await context.addInitScript(fixtures, { scenario });
  await context.addInitScript({ content: `window.addEventListener('DOMContentLoaded', () => {\n${source}\n});` });
  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/video/BV123');
  await waitReady(page);
  return { context, page, errors };
}
const get = (page, id) => page.locator(`#bilibili-subtitle-exporter #${id}`);
async function waitReady(page) {
  await page.waitForFunction(() => document.getElementById('bilibili-subtitle-exporter')?.shadowRoot?.getElementById('comment-status')?.textContent.includes('点击开始') ||
    document.getElementById('bilibili-subtitle-exporter')?.shadowRoot?.getElementById('comment-status')?.textContent.includes('恢复本地进度'));
  if (!await get(page, 'panel').isVisible()) await get(page, 'toggle').click();
}
async function waitText(page, text) {
  await page.waitForFunction((text) => document.getElementById('bilibili-subtitle-exporter').shadowRoot.getElementById('comment-status').textContent.includes(text), text);
}
async function exported(page, format) {
  const download = page.waitForEvent('download');
  await get(page, `comments-${format}`).click();
  const file = await download;
  const stream = await file.createReadStream();
  const parts = [];
  for await (const part of stream) parts.push(part);
  return { name: file.suggestedFilename(), text: Buffer.concat(parts).toString('utf8') };
}
async function saved(page, key = '123:42') {
  return page.evaluate((key) => new Promise((resolve, reject) => {
    const req = indexedDB.open('bilibili-comment-exporter', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction(['jobs', 'rows'], 'readonly');
      const job = tx.objectStore('jobs').get(key), rows = tx.objectStore('rows').index('job').getAll(key);
      tx.oncomplete = () => { req.result.close(); resolve({ job: job.result, rows: rows.result }); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), key);
}
const optional = { skip: !chromium && '可选浏览器测试：需安装 playwright 和 Chromium', timeout: 30000 };

test('浏览器：网页全屏立即隐藏且采集继续，退出后恢复面板，宽屏保持显示', optional, async () => {
  const { context, page, errors } = await setup('hold');
  const host = page.locator('#bilibili-subtitle-exporter');
  try {
    await get(page, 'comments-start').click();
    await page.waitForFunction(() => window.__pending.length === 1);
    await page.evaluate(() => {
      // 关闭 URL 轮询，确保全屏切换依靠状态监听及时更新。
      clearInterval(window.__routeInterval);
      const player = document.createElement('div');
      player.className = 'bpx-player-container';
      player.dataset.screen = 'wide';
      player.innerHTML = '<button class="bpx-player-ctrl-web">网页全屏</button>';
      document.body.append(player);
    });
    assert.equal(await host.isVisible(), true);
    await page.evaluate(() => {
      document.querySelector('.bpx-player-container').dataset.screen = 'web';
      document.body.classList.add('webscreen-fix');
    });
    await host.waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.__scenario = 'normal'; window.__pending.shift()(); });
    await waitText(page, '遍历已结束。');
    assert.equal((await saved(page)).rows.length, 5);
    assert.equal(await page.evaluate(() => window.__aborts), 0);
    assert.equal(await host.isVisible(), false, '采集状态更新不能重新显示浮层');
    await page.evaluate(() => { document.querySelector('.bpx-player-container').dataset.screen = 'normal'; });
    assert.equal(await host.isVisible(), false, '网页全屏标记未退出前仍应隐藏');
    await page.evaluate(() => document.body.classList.remove('webscreen-fix'));
    await host.waitFor({ state: 'visible' });
    assert.equal(await get(page, 'panel').isVisible(), true);
    await get(page, 'toggle').click();
    await page.evaluate(() => { document.querySelector('.bpx-player-container').dataset.screen = 'full'; });
    await host.waitFor({ state: 'hidden' });
    await page.evaluate(() => document.querySelector('.bpx-player-container').remove());
    await host.waitFor({ state: 'visible' });
    assert.equal(await get(page, 'panel').isVisible(), false, '保留进入全屏前的收起状态');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('浏览器：原生全屏隐藏整个浮层，退出后恢复且不请求评论', optional, async () => {
  const { context, page, errors } = await setup();
  const host = page.locator('#bilibili-subtitle-exporter');
  try {
    await page.evaluate(() => {
      clearInterval(window.__routeInterval);
      const button = document.createElement('button');
      button.id = 'native-fullscreen';
      button.textContent = '全屏测试';
      button.onclick = () => document.documentElement.requestFullscreen();
      document.body.append(button);
    });
    await page.locator('#native-fullscreen').click();
    await page.waitForFunction(() => !!document.fullscreenElement && document.getElementById('bilibili-subtitle-exporter').hidden);
    assert.equal(await host.isVisible(), false);
    await page.evaluate(() => document.exitFullscreen());
    await host.waitFor({ state: 'visible' });
    assert.equal(await get(page, 'panel').isVisible(), true);
    assert.equal(await page.evaluate(() => window.__requests.length), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('浏览器：暂停、刷新续传、原生 IndexedDB 和三种真实文件下载', optional, async () => {
  const { context, page, errors } = await setup('hold');
  try {
    await get(page, 'comments-start').click();
    await page.waitForFunction(() => window.__pending.length === 1);
    await get(page, 'comments-pause').click();
    await page.waitForFunction(() => !document.getElementById('bilibili-subtitle-exporter').shadowRoot.getElementById('comments-start').disabled);
    assert.equal((await saved(page)).rows.length, 3);
    const partial = await exported(page, 'json');
    assert.match(partial.name, /未完成/);
    assert.equal(JSON.parse(partial.text).report.status, 'incomplete');
    await page.reload();
    await waitReady(page);
    assert.equal(await page.evaluate(() => window.__requests.length), 0, '刷新不应自动请求接口');
    await page.evaluate(() => { window.__scenario = 'normal'; });
    await get(page, 'comments-start').click();
    await waitText(page, '遍历已结束。');
    const urls = await page.evaluate(() => window.__requests);
    const mainRequests = urls.filter((u) => new URL(u).pathname.endsWith('/main'));
    assert.equal(mainRequests.length, 1);
    assert.equal(JSON.parse(new URL(mainRequests[0]).searchParams.get('pagination_str')).offset, 'next-page');
    const json = JSON.parse((await exported(page, 'json')).text);
    assert.equal(json.comments.length, 5);
    assert.equal(json.report.roots, 3);
    assert.equal(json.report.replies, 2);
    assert.equal(json.report.status, 'traversal_finished');
    assert.equal(json.comments.find((c) => c.id === '3').parent_id, '2');
    assert.match((await exported(page, 'csv')).text, /评论ID/);
    assert.match((await exported(page, 'txt')).text, /中文\n正文/);
    assert.equal(JSON.parse((await exported(page, 'report')).text).difference, 0);
    await get(page, 'comments-clear').click();
    await waitText(page, '已清空');
    const empty = await saved(page);
    assert.equal(empty.job, undefined);
    assert.equal(empty.rows.length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('浏览器：分 P 切换不打断评论，切换视频取消旧请求且陈旧响应不会回填', optional, async () => {
  const { context, page, errors } = await setup('hold');
  try {
    await get(page, 'comments-start').click();
    await page.waitForFunction(() => window.__pending.length === 1);
    await page.evaluate(() => history.pushState({}, '', '/video/BV123?p=2'));
    await page.waitForFunction(() => document.getElementById('bilibili-subtitle-exporter').shadowRoot.getElementById('title').textContent.includes('P2'));
    assert.equal(await page.evaluate(() => window.__aborts), 0);
    await page.evaluate(() => history.pushState({}, '', '/video/BV999'));
    await waitReady(page);
    assert.equal(await page.evaluate(() => window.__aborts), 1);
    await page.evaluate(() => window.__pending[0]());
    await get(page, 'comments-start').click();
    await waitText(page, '遍历已结束。');
    const data = JSON.parse((await exported(page, 'json')).text);
    assert.equal(data.report.video.bvid, 'BV999');
    assert.deepEqual(data.comments.map((r) => r.id), ['9']);
    assert.equal((await saved(page, '123:42')).rows.length, 3);
    assert.equal((await saved(page, '999:42')).rows.length, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('浏览器：同一视频跨标签页互斥，不覆盖另一个标签页的进度', optional, async () => {
  const { context, page, errors } = await setup('hold');
  try {
    await get(page, 'comments-start').click();
    await page.waitForFunction(() => window.__pending.length === 1);
    const second = await context.newPage();
    await second.goto('https://www.bilibili.com/video/BV123');
    await waitReady(second);
    await get(second, 'comments-start').click();
    await waitText(second, '另一个标签页');
    assert.equal((await saved(second)).rows.length, 3);
    assert.equal(await second.evaluate(() => window.__requests.filter((u) => u.includes('/reply/')).length), 0);
    await get(page, 'comments-pause').click();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('浏览器：同步配额错误中止整个 IndexedDB 事务，不会只保存游标而丢失评论', optional, async () => {
  const { context, page, errors } = await setup('quota');
  try {
    await get(page, 'comments-start').click();
    await waitText(page, '本地保存失败');
    const data = await saved(page);
    assert.equal(data.rows.length, 0);
    assert.equal(data.job.cursor, '');
    assert.equal(data.job.rootPages, 0);
    assert.equal(await page.evaluate(() => window.__requests.filter((u) => u.includes('/reply/')).length), 1);
    const partial = JSON.parse((await exported(page, 'json')).text);
    assert.equal(partial.comments.length, 0);
    assert.equal(partial.report.root_pages, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('浏览器：接口限流暂停并保留可导出的前一页；不会自动重试', optional, async () => {
  const { context, page, errors } = await setup('risk');
  try {
    await get(page, 'comments-start').click();
    await waitText(page, '-412');
    const data = JSON.parse((await exported(page, 'json')).text);
    assert.equal(data.report.status, 'incomplete');
    assert.equal(data.report.failures[0].kind, 'risk');
    assert.equal(data.comments.length, 3);
    assert.equal((await saved(page)).job.cursor, 'next-page');
    assert.equal(await page.evaluate(() => window.__requests.filter((u) => u.includes('/reply/')).length), 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('浏览器：未登录只提示登录，不创建进度或请求评论接口', optional, async () => {
  const { context, page, errors } = await setup('login');
  try {
    await get(page, 'comments-start').click();
    await waitText(page, '登录');
    await page.waitForFunction(() => !document.getElementById('bilibili-subtitle-exporter').shadowRoot.getElementById('comments-start').disabled);
    assert.equal(await page.evaluate(() => window.__requests.length), 1);
    assert.equal((await saved(page)).job, undefined);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
