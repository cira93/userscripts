const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../fc2ppvdb-enhanced.user.js'), 'utf8');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const harness = `
const Logger = { scope: () => ({ debug(){}, error(){}, warn(){} }), warn(){} };
const Config = { CLASSES: { cardRebuilt: 'card-rebuilt', processedCard: 'processed-card' } };
const PageContext = { Unknown: 0 };
const AppEvents = { CARD_DISCOVERED: 'card' };
const markGridContainer = el => el?.setAttribute('data-enh-grid-container', '1');
const CoreEvents = { emit: (event, { host, id }) => {
  if (host.dataset.fail) return;
  const card = document.createElement('div');
  card.className = 'processed-card'; card.textContent = id;
  host.replaceChildren(card);
} };
${slice('  class SourceKeyManager {', '  const log$n = Logger.scope("SiteManager");')}
window.BaseSite = BaseSite;
window.CardProcessingQueue = CardProcessingQueue;
window.SiteListObserver = SiteListObserver;
window.DomObserver = DomObserver;
`;
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div class="grid"></div></main>');
    await page.addScriptTag({ content: harness });
    const results = await page.evaluate(async () => {
      const check = (value, message) => { if (!value) throw new Error(message); };
      const tick = () => new Promise(resolve => setTimeout(resolve, 0));
      const waitFor = async predicate => {
        for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
        throw new Error('Timed out waiting for DOM');
      };
      const grid = document.querySelector('.grid');
      const make = (id) => {
        const card = document.createElement('article'); card.className = 'card'; card.dataset.key = id;
        grid.appendChild(card); return card;
      };
      const createSite = extractor => new BaseSite({ list: {
        cardSelector: '.card:not(.card-rebuilt)', containerSelector: '.grid', extractor
      } });
      const results = [];
      let unblock;
      const slow = make('slow'), fast = make('same-id');
      let calls = 0;
      const site = createSite(async card => {
        calls++;
        if (card === slow) await new Promise(resolve => { unblock = resolve; });
        return { id: card.dataset.key, type: 'fc2' };
      });
      const initial = site.initListMode();
      await waitFor(() => fast.classList.contains('card-rebuilt'));
      check(!slow.classList.contains('card-rebuilt'), 'slow extraction must not block ready cards');
      const dynamic = make('same-id');
      await waitFor(() => dynamic.classList.contains('card-rebuilt'));
      check(!slow.classList.contains('card-rebuilt'), 'new cards must be observed during initial extraction');
      // Updating our own DOM must not rediscover and extract cards again.
      fast.firstChild.appendChild(document.createElement('span'));
      await tick();
      check(calls === 3, 'self mutations should not schedule new extraction');
      unblock(); await initial;
      check(grid.querySelectorAll('.processed-card').length === 3, 'duplicate IDs should render in distinct hosts');
      site.cleanup(); grid.replaceChildren();
      results.push('ready cards render before blocked cards; dynamic insertion; duplicate IDs; own mutations');

      const limits = { active: 0, max: 0, calls: 0 };
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const nodes = Array.from({ length: 25 }, (_, i) => make(String(i)));
      const queue = new CardProcessingQueue(async () => {
        limits.calls++; limits.active++; limits.max = Math.max(limits.max, limits.active);
        await gate; limits.active--;
      }, 4);
      const all = queue.enqueue(nodes);
      const duplicate = queue.enqueue(nodes);
      await tick(); check(limits.active === 4, 'concurrency must be bounded');
      release(); await Promise.all([all, duplicate]);
      check(limits.max === 4 && limits.calls === 25, 'duplicate queue entries must be coalesced');
      grid.replaceChildren();
      results.push('shared queue concurrency limit and host deduplication');

      let finish;
      const stale = make('stale');
      const staleSite = createSite(async card => {
        await new Promise(resolve => { finish = resolve; }); return { id: card.dataset.key };
      });
      const pending = staleSite.initListMode();
      await waitFor(() => finish);
      staleSite.cleanup(); finish(); await pending;
      check(!stale.querySelector('.processed-card'), 'cleanup must invalidate in-flight extraction');
      check(!stale.hasAttribute('data-enh-rebuilding'), 'cleanup must release rebuilding flag');
      grid.replaceChildren();
      results.push('navigation cleanup invalidates stale asynchronous work');

      const reused = make('reused');
      const releases = [];
      const reuseSite = createSite(async card => {
        await new Promise(resolve => releases.push(resolve));
        return { id: card.dataset.key };
      });
      const oldRun = reuseSite.initListMode();
      await waitFor(() => releases.length === 1);
      reuseSite.cleanup();
      const newRun = reuseSite.initListMode();
      await waitFor(() => releases.length === 2);
      releases[0](); await oldRun;
      check(reused.hasAttribute('data-enh-rebuilding'), 'stale run must not clear the new run lock');
      releases[1](); await newRun;
      check(!!reused.querySelector('.processed-card'), 'reused host must render after navigation');
      reuseSite.cleanup(); grid.replaceChildren();
      results.push('reused hosts survive cleanup and overlapping extraction');


      const failed = make('retry'); failed.dataset.fail = '1';
      const retrySite = createSite(card => ({ id: card.dataset.key }));
      await retrySite.initListMode();
      check(!failed.classList.contains('card-rebuilt'), 'failed mount must not mark host processed');
      check(!failed.hasAttribute('data-enh-processed'), 'failed mount must remain retryable');
      delete failed.dataset.fail;
      await retrySite.cardQueue.enqueue([failed]);
      check(!!failed.querySelector('.processed-card'), 'failed mount must succeed on retry');
      retrySite.cleanup(); grid.replaceChildren();
      results.push('failed mounts remain retryable');

      // Container observation must discover a container inserted after initialization.
      const lateSite = createSite(card => ({ id: card.dataset.key }));
      lateSite.config.list.mutationObserverTarget = 'container';
      await lateSite.initListMode();
      const newGrid = document.createElement('div'); newGrid.className = 'grid';
      newGrid.innerHTML = '<article class="card" data-key="late"></article>';
      document.querySelector('main').appendChild(newGrid);
      await waitFor(() => newGrid.querySelector('.processed-card'));
      lateSite.cleanup();
      results.push('late list containers are observed and processed');
      return results;
    });
    // Use the actual shipped tooltip CSS against the native bookmark wrapper.
    const tooltipCss = source.match(/    \.fc2-enh-tooltip \{[\s\S]*?\.resource-btn:hover \.fc2-enh-tooltip \{[^}]+\}/)[0];
    await page.setContent(`<style>${tooltipCss}</style>
      <div id="bookmark"><div class="tooltip flex items-center" data-tip="Add to favorites"><button id="unheart-button">Favorite</button></div></div>
      <button class="resource-btn">Action<span class="fc2-enh-tooltip">Tip</span></button>`);
    assert.equal(await page.locator('#unheart-button').isVisible(), true);
    assert.equal(await page.locator('.fc2-enh-tooltip').isVisible(), false);
    await page.locator('.resource-btn').hover();
    assert.equal(await page.locator('.fc2-enh-tooltip').isVisible(), true);
    assert.equal(/\.tooltip\s*\{/.test(source), false);
    results.push('native bookmark remains visible; plugin tooltip still responds to hover');
    for (const result of results) console.log(`PASS ${result}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
