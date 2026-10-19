const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { route, timestamp, convert, filename, subtitleUrl } = require('../bilibili-subtitle.user.js');

test('时间进位、长视频与毫秒精度', () => {
  assert.equal(timestamp(59.9996), '00:01:00,000');
  assert.equal(timestamp(3599.9996), '01:00:00,000');
  assert.equal(timestamp(360000.125), '100:00:00,125');
});

test('字幕排序、空行过滤、中文及 SRT 分隔', () => {
  const input = { body: [
    { from: 2, to: 3, content: '第二句\r\n下一行' },
    { from: 0, to: 1.2, content: '第一句' },
    { from: 4, to: 5, content: ' ' },
  ] };
  assert.equal(convert(input, 'txt'), '第一句\r\n第二句\n下一行\r\n');
  assert.equal(convert(input, 'srt'), '1\r\n00:00:00,000 --> 00:00:01,200\r\n第一句\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\n第二句\r\n下一行\r\n');
});

test('无效数据不会悄悄导出为残缺字幕', () => {
  for (const data of [{}, { body: [] }, { body: [{ from: -1, to: 1, content: 'a' }] },
    { body: [{ from: 2, to: 1, content: 'a' }] }, { body: [{ from: 0, to: Infinity, content: 'a' }] }]) {
    assert.throws(() => convert(data, 'srt'));
  }
});

test('分 P 与无关参数；排除不支持的页面', () => {
  assert.equal(route('https://www.bilibili.com/video/BV123?p=2&spm_id_from=x').key, 'BV123:2');
  assert.equal(route('https://www.bilibili.com/video/av123/').p, 1);
  assert.equal(route('https://www.bilibili.com/bangumi/play/ep123'), null);
  assert.equal(route('https://www.bilibili.com/video/BV123?p=0'), null);
  assert.equal(route('https://www.bilibili.com/video/BV123?p=1.5'), null);
});

test('文件名与字幕 URL 限制', () => {
  assert.equal(filename('标题:a/b?'), '标题_a_b_');
  assert.equal(subtitleUrl('//aisubtitle.hdslb.com/a.json'), 'https://aisubtitle.hdslb.com/a.json');
  assert.throws(() => subtitleUrl('https://hdslb.com.evil.example/a'));
  assert.throws(() => subtitleUrl('javascript:alert(1)'));
});

function browser() {
  const elements = new Map();
  function element() {
    return { style: {}, hidden: false, disabled: false, value: '', textContent: '', children: [],
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      setAttribute() {}, remove() {}, click() {},
      attachShadow() { return { set innerHTML(_) {}, getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      } }; },
    };
  }
  const requests = [];
  let tick;
  const location = { href: 'https://www.bilibili.com/video/BV123?p=1' };
  const context = { URL, URLSearchParams, Blob, location,
    document: { createElement: element, body: element(), documentElement: element(), querySelector() { return null; }, addEventListener() {} },
    window: { addEventListener() {} },
    MutationObserver: class { observe() {} },
    GM_xmlhttpRequest(options) { requests.push(options); },
    setTimeout() {}, setInterval(fn) { tick = fn; },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../bilibili-subtitle.user.js'), 'utf8'), context);
  return { elements, requests, location, tick: () => tick(),
    respond(index, data) { requests[index].onload({ status: 200, responseText: JSON.stringify({ code: 0, data }) }); },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const video = { title: '测试', bvid: 'BV123', pages: [{ page: 1, cid: 100, part: '第一P' }, { page: 2, cid: 200, part: '第二P' }] };

test('当前分 P 的 cid 正确，下载前支持语言选择', async () => {
  const b = browser();
  b.location.href = 'https://www.bilibili.com/video/BV123?p=2';
  b.tick();
  const pending = b.elements.get('read').onclick();
  b.respond(0, video);
  await flush();
  assert.match(b.requests[1].url, /cid=200/);
  b.respond(1, { subtitle: { subtitles: [{ lan: 'zh', lan_doc: '中文', subtitle_url: '//aisubtitle.hdslb.com/a' }] } });
  await pending;
  assert.equal(b.elements.get('language').children.length, 1);
  assert.equal(b.elements.get('srt').disabled, false);
});

test('切换后旧字幕响应不回填，也不覆盖新请求的忙碌状态', async () => {
  const b = browser();
  const old = b.elements.get('read').onclick();
  b.respond(0, video);
  await flush();
  b.location.href = 'https://www.bilibili.com/video/BV123?p=2';
  b.tick();
  const fresh = b.elements.get('read').onclick();
  b.respond(1, { subtitle: { subtitles: [{ lan: 'old', subtitle_url: '//aisubtitle.hdslb.com/old' }] } });
  await old;
  assert.equal(b.elements.get('language').children.length, 0);
  assert.equal(b.elements.get('read').disabled, true);
  b.respond(2, video);
  await flush();
  b.respond(3, { need_login_subtitle: true });
  await fresh;
  assert.match(b.elements.get('status').textContent, /需要登录/);
  assert.equal(b.elements.get('read').disabled, false);
  assert.equal(b.elements.get('srt').disabled, true);
});

test('API 错误与无字幕状态可区分，并恢复重试按钮', async () => {
  const b = browser();
  const pending = b.elements.get('read').onclick();
  b.requests[0].onload({ status: 200, responseText: JSON.stringify({ code: -412, message: '请求被拦截' }) });
  await pending;
  assert.match(b.elements.get('status').textContent, /-412/);
  assert.equal(b.elements.get('read').disabled, false);
  assert.equal(b.elements.get('srt').disabled, true);
});
