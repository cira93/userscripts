const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  problem, parseJson, md5, wbiQuery, apiData, normalizeComment, newJob,
  rootPage, replyPage, report, commentExport, collectComments, commentClient,
} = require('../bilibili-subtitle.user.js');

const video = { aid: '123', bvid: 'BV123', title: '中文测试' };
const images = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
};
const comment = (id, options = {}) => ({
  rpid_str: String(id), root_str: '0', parent_str: '0', ctime: 1700000000,
  rcount: 0, like: 5, member: { mid: '42', uname: '测试用户' }, content: { message: '正文[doge]' }, ...options,
});
const child = (id, root = '1', parent = root) => comment(id, { root_str: root, parent_str: parent });
const main = (replies, end = true, next = '', total = replies.length) => ({
  cursor: { is_end: end, mode: 2, all_count: total, pagination_reply: { next_offset: next } }, replies,
});
const threadPage = (replies, count = replies.length, num = 1, size = 20) => ({ page: { count, num, size }, replies });
const job = () => newJob(video, '42');

// 模拟按行增量、与进度同事务提交的存储，刷新只恢复上次已提交的状态。
function memoryStore() {
  let committed = null;
  return {
    fail: false,
    async save(state, { rows = [], threads = [] } = {}) {
      if (this.fail) throw new Error('QuotaExceededError');
      const { rows: _rows, threads: _threads, ...meta } = state;
      const next = structuredClone(committed || { rows: new Map(), threads: new Map() });
      Object.assign(next, structuredClone(meta));
      for (const row of rows) next.rows.set(row.id, structuredClone(row));
      for (const t of threads) next.threads.set(t.id, structuredClone(t));
      committed = next;
    },
    read: () => structuredClone(committed),
  };
}

test('MD5 与独立 crypto 实现一致，含 UTF-8、填充分界和长输入', () => {
  for (const text of ['', 'a', 'abc', '中文🙂', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(10000)]) {
    assert.equal(md5(text), createHash('md5').update(text).digest('hex'));
  }
});

test('WBI 排序、空格编码和已公开的签名向量一致；不改变原参数', () => {
  const params = { foo: '114', bar: '514', zab: 1919810 };
  assert.equal(wbiQuery(params, images, 1702204169), 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
  assert.equal(params.wts, undefined);
  assert.match(wbiQuery({ a: '中 文!()*' }, images, 1), /^a=%E4%B8%AD%20%E6%96%87&wts=1/);
  assert.throws(() => wbiQuery({}, {}), /WBI/);
});

test('长整数 ID 无损解析，同时保留字符串正文中的数字、转义和换行', () => {
  const input = '{"rpid":9007199254740993123,"root":9007199254740993122,"ctime":1700000000,"content":{"message":"数字9007199254740993123与\\\"引号\\\"\\n换行"}}';
  const data = parseJson(input);
  assert.equal(data.rpid, '9007199254740993123');
  assert.equal(data.root, '9007199254740993122');
  assert.equal(data.content.message, '数字9007199254740993123与"引号"\n换行');
  assert.equal(typeof data.ctime, 'number');
  assert.throws(() => normalizeComment(comment(Number.MAX_SAFE_INTEGER + 5, { rpid_str: undefined, rpid: Number.MAX_SAFE_INTEGER + 5 })));
});

test('保留多行正文、图片、表情和回复其他楼中楼的关系', () => {
  const row = normalizeComment(child('3', '1', '2'));
  assert.equal(row.parent_id, '2');
  const image = normalizeComment(comment('4', { content: {
    message: '  正文\r\n[doge]  ', pictures: [{ img_src: 'https://i0.hdslb.com/a.png', img_width: 10 }],
    emote: { '[doge]': { url: 'https://i0.hdslb.com/doge.png' } },
  } }));
  assert.equal(image.text, '  正文\n[doge]  ');
  assert.equal(image.pictures[0].url, 'https://i0.hdslb.com/a.png');
  assert.equal(image.emotes['[doge]'], 'https://i0.hdslb.com/doge.png');
  assert.throws(() => normalizeComment(child('3', '99'), '1'), /不匹配/);
  assert.throws(() => normalizeComment(child('1'), '1'), /不匹配/);
});

test('跨页、置顶、热评及预览回复统一去重，楼中楼预览不当成完整线程', async () => {
  const state = job(), db = memoryStore(), calls = [];
  const root = comment('1', { rcount: 2, replies: [child('2')] });
  await collectComments(state, {
    save: db.save.bind(db),
    async fetchPage(path, p) {
      calls.push([path, p]);
      if (path.endsWith('/main')) {
        if (!JSON.parse(p.pagination_str).offset) return { ...main([root], false, 'next-1', 4), top: { upper: root }, hots: [root] };
        return { ...main([comment('4')], true, '', 4), top_replies: [root] };
      }
      if (path.endsWith('/reply')) return threadPage([child('2'), child('3', '1', '2')]);
      return { count: 4 };
    },
  });
  assert.equal(state.rows.size, 4);
  assert.equal(report(state).roots, 2);
  assert.equal(report(state).replies, 2);
  assert.equal(report(state).status, 'traversal_finished');
  assert.equal(calls.filter(([p]) => p.endsWith('/reply')).length, 1);
  const exported = JSON.parse(commentExport(db.read(), 'json'));
  assert.equal(exported.comments.find((c) => c.id === '3').parent_id, '2');
});

test('暂停后刷新，从已提交的下一游标继续，跨页重复 ID 不增加条数', async () => {
  const state = job(), db = memoryStore(), controller = new AbortController();
  await collectComments(state, {
    save: db.save.bind(db), signal: controller.signal,
    async fetchPage() { return main([comment('1')], false, 'saved-offset', 2); },
    changed(s) { if (s.rootPages === 1 && s.status === 'running') controller.abort(); },
  });
  const resumed = db.read();
  assert.equal(resumed.status, 'paused');
  assert.equal(resumed.cursor, 'saved-offset');
  assert.equal(resumed.rows.size, 1);
  const offsets = [];
  await collectComments(resumed, {
    save: db.save.bind(db),
    async fetchPage(path, p) {
      if (!path.endsWith('/main')) return { count: 2 };
      offsets.push(JSON.parse(p.pagination_str).offset);
      return main([comment('1'), comment('2')], true, '', 2);
    },
  });
  assert.deepEqual(offsets, ['saved-offset']);
  assert.equal(db.read().rows.size, 2);
});

test('楼中楼分页断点续传保持当前页；重启不重抓已完成页', async () => {
  const state = job(), db = memoryStore(), controller = new AbortController();
  rootPage(state, main([comment('1', { rcount: 3 })], true, '', 4));
  await db.save(state, { rows: [...state.rows.values()], threads: [...state.threads.values()] });
  await collectComments(state, {
    save: db.save.bind(db), signal: controller.signal,
    async fetchPage() { return threadPage([child('2'), child('3')], 3, 1, 2); },
    changed(s) { if (s.replyPages === 1 && s.status === 'running') controller.abort(); },
  });
  const resumed = db.read(), pages = [];
  await collectComments(resumed, {
    save: db.save.bind(db),
    async fetchPage(path, p) {
      if (!path.endsWith('/reply')) return { count: 4 };
      pages.push(p.pn);
      return threadPage([child('4', '1', '3')], 3, 2, 2);
    },
  });
  assert.deepEqual(pages, [2]);
  assert.equal(report(db.read()).collected, 4);
  assert.equal(report(db.read()).status, 'traversal_finished');
});

test('限流只暂停当前分页，已有数据可导出，手动重试成功后保留已恢复记录', async () => {
  const state = job(), db = memoryStore();
  await assert.rejects(collectComments(state, {
    save: db.save.bind(db),
    async fetchPage(_path, p) {
      if (!JSON.parse(p.pagination_str).offset) return main([comment('1')], false, 'next', 2);
      return apiData({ code: -412, message: '限流' });
    },
  }), /-412/);
  const saved = db.read();
  assert.equal(saved.stage, 'roots');
  assert.equal(report(saved).status, 'incomplete');
  assert.equal(JSON.parse(commentExport(saved, 'json')).comments.length, 1);
  assert.equal(saved.failures[0].resolved, false);
  await collectComments(saved, {
    save: db.save.bind(db),
    async fetchPage(path) { return path.endsWith('/main') ? main([comment('2')], true, '', 2) : { count: 2 }; },
  });
  assert.equal(saved.failures[0].resolved, true);
});

test('不可访问的单个楼层记为失败且继续其他楼层；重新继续仅重试失败楼层', async () => {
  const state = job(), db = memoryStore(), first = [];
  await collectComments(state, {
    save: db.save.bind(db),
    async fetchPage(path, p) {
      if (path.endsWith('/main')) return main([comment('1', { rcount: 1 }), comment('5', { rcount: 1 })], true, '', 4);
      if (path.endsWith('/count')) return { count: 4 };
      first.push(p.root);
      if (p.root === '1') throw problem('根评论不可访问', 'api', { code: -404 });
      return threadPage([child('6', '5')]);
    },
  });
  assert.deepEqual(first, ['1', '5']);
  assert.equal(report(db.read()).status, 'finished_with_gaps');
  const resumed = db.read(), retries = [];
  await collectComments(resumed, {
    save: db.save.bind(db),
    async fetchPage(path, p) {
      if (path.endsWith('/count')) return { count: 4 };
      retries.push(p.root);
      return threadPage([child('2')]);
    },
  });
  assert.deepEqual(retries, ['1']);
  assert.equal(report(resumed).status, 'traversal_finished');
  assert.equal(resumed.failures[0].resolved, true);
});

test('空页、缺游标、重复游标、重复分页和排序改变不会被误报为完成', () => {
  for (const data of [main([], false, 'x'), main([comment('1')], false), { ...main([comment('1')]), cursor: { is_end: true, mode: 3 } }]) {
    assert.throws(() => rootPage(job(), data));
  }
  const state = job();
  rootPage(state, main([comment('1')], false, 'x'));
  assert.throws(() => rootPage(state, main([comment('2')], false, 'x')), /游标/);
  assert.throws(() => rootPage(state, main([comment('1')], true)), /重复/);
  assert.equal(state.rows.size, 1);
  assert.equal(state.rootPages, 1);
});

test('整页校验失败不会污染已保存的评论或推进游标', () => {
  const state = job();
  assert.throws(() => rootPage(state, main([comment('1'), { rpid_str: '2' }])));
  assert.equal(state.rows.size, 0);
  assert.equal(state.threads.size, 0);
  assert.equal(state.rootPages, 0);
  rootPage(state, main([comment('1', { rcount: 2 })]));
  const t = state.threads.get('1');
  assert.throws(() => replyPage(state, t, threadPage([child('2'), child('3', '99')], 2)));
  assert.equal(t.page, 1);
  assert.equal(state.rows.size, 1);
});

test('重复的楼中楼页面、错误页码和提前空页都会暂停', () => {
  const state = job();
  rootPage(state, main([comment('1', { rcount: 4 })]));
  const t = state.threads.get('1');
  assert.throws(() => replyPage(state, t, threadPage([], 4, 1, 2)), /空页/);
  assert.throws(() => replyPage(state, t, threadPage([child('2')], 4, 2, 2)), /分页/);
  replyPage(state, t, threadPage([child('2'), child('3')], 4, 1, 2));
  assert.throws(() => replyPage(state, t, threadPage([child('2'), child('3')], 4, 2, 2)), /重复/);
  assert.equal(t.page, 2);
});

test('总数变化、精选、折叠和每个楼层的数量差异均进入报告', async () => {
  const state = job(), db = memoryStore();
  await collectComments(state, {
    save: db.save.bind(db),
    async fetchPage(path) {
      if (path.endsWith('/main')) return { ...main([comment('1', { rcount: 2 })], true, '', 3), folder: { has_folded: true }, control: { web_selection: true } };
      if (path.endsWith('/reply')) return threadPage([child('2')], 2);
      return { count: 4 };
    },
  });
  const r = report(db.read());
  assert.equal(r.status, 'finished_with_gaps');
  assert.equal(r.difference, 2);
  assert.equal(r.threads[0].difference, 1);
  assert.equal(r.threads_with_difference, 1);
  assert.ok(r.warnings.some((w) => w.includes('精选')));
  assert.ok(r.warnings.some((w) => w.includes('折叠')));
  assert.ok(r.warnings.some((w) => w.includes('总数发生变化')));
});

test('零评论区正常结束，数量相同仍带有可访问范围说明', async () => {
  const state = job(), db = memoryStore();
  await collectComments(state, { save: db.save.bind(db), fetchPage: async (p) => p.endsWith('/main') ? main([]) : { count: 0 } });
  assert.equal(report(state).status, 'traversal_finished');
  assert.match(report(state).scope, /不能证明/);
});

test('最后的总数校验失败，继续时只重试校验', async () => {
  const state = job(), db = memoryStore();
  await assert.rejects(collectComments(state, {
    save: db.save.bind(db), fetchPage: async (p) => {
      if (p.endsWith('/main')) return main([]);
      throw problem('网络失败', 'network');
    },
  }), /网络失败/);
  assert.equal(db.read().stage, 'verify');
  const calls = [];
  await collectComments(db.read(), { save: db.save.bind(db), fetchPage: async (p) => { calls.push(p); return { count: 0 }; } });
  assert.deepEqual(calls, ['/x/v2/reply/count']);
  assert.equal(db.read().failures[0].resolved, true);
});

test('存储配额错误停止后续请求；已提交进度不会前移或缺行', async () => {
  const state = job(), db = memoryStore();
  let requests = 0;
  await assert.rejects(collectComments(state, {
    save: db.save.bind(db),
    async fetchPage() { requests++; db.fail = true; return main([comment('1')], false, 'not-committed'); },
  }), (e) => e.kind === 'storage');
  assert.equal(requests, 1);
  assert.equal(db.read().cursor, '');
  assert.equal(db.read().rows.size, 0);
  assert.equal(db.read().rootPages, 0);
});

test('TXT、CSV、JSON 保留正文和关联；CSV 转义引号、换行并防止公式执行', () => {
  const state = job();
  rootPage(state, main([comment('9007199254740993123', {
    member: { mid: '42', uname: '=SUM(1,2)' }, content: { message: '\t=HYPERLINK("https://example.com")\n第二行,中文' },
  })]));
  const csv = commentExport(state, 'csv');
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.ok(csv.includes('"\'\t=HYPERLINK(""https://example.com"")\n第二行,中文"'));
  assert.match(csv, /"9007199254740993123"/);
  const json = JSON.parse(commentExport(state, 'json'));
  assert.equal(json.comments[0].text, '\t=HYPERLINK("https://example.com")\n第二行,中文');
  assert.equal(json.report.status, 'incomplete');
  assert.match(commentExport(state, 'txt'), /9007199254740993123/);
  assert.equal(JSON.parse(commentExport(state, 'report')).collected, 1);
});

test('客户端最短间隔、有限网络重试、WBI 签名；风险错误不自动重试', async () => {
  let time = 0, failures = 0;
  const calls = [], waits = [];
  const client = commentClient({
    interval: 0.1, now: () => time, random: () => 0,
    wait: async (ms) => { waits.push(ms); time += ms; },
    async requestFn(url) {
      calls.push({ url, time });
      if (url.includes('/nav?')) return { code: 0, data: { isLogin: true, mid: 42, wbi_img: images } };
      if (failures++ === 0) throw problem('离线', 'network');
      return { code: 0, data: main([]) };
    },
  });
  assert.equal(await client.initialize(), '42');
  await client.fetchPage('/x/v2/reply/wbi/main', { oid: '123' }, true);
  assert.ok(calls[1].time - calls[0].time >= 1500);
  assert.ok(waits.includes(3000));
  assert.match(calls[1].url, /w_rid=[a-f0-9]{32}/);
  let riskCalls = 0;
  const risk = commentClient({ wait: async () => {}, requestFn: async () => { riskCalls++; return { code: -412, message: '限流' }; } });
  await assert.rejects(risk.fetchPage('/test'), (e) => e.kind === 'risk');
  assert.equal(riskCalls, 1);
});

test('风险令牌、签名错误和未登录按类别停止，不把错误解释为零评论', async () => {
  for (const [input, kind] of [[{ code: -101 }, 'auth'], [{ code: -403 }, 'signature'], [{ code: 0, data: { v_voucher: 'x' } }, 'risk']]) {
    assert.throws(() => apiData(input), (e) => e.kind === kind);
  }
  const client = commentClient({ wait: async () => {}, requestFn: async () => ({ code: 0, data: { isLogin: false, wbi_img: images } }) });
  await assert.rejects(client.initialize(), /登录/);
});
