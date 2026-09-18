const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../bilibili-search-enhancer.user.js'), 'utf8');
const context = { module: { exports: {} }, TextEncoder, URL };
vm.runInNewContext(script, context);
const {md5,sign,matches,terms,readConfig}=context.module.exports;
test('MD5 agrees with Node crypto for Unicode and multi-block inputs',()=>{
  for(const s of ['', 'abc', 'Python 异步', 'x'.repeat(1000)]) assert.equal(md5(s),crypto.createHash('md5').update(s).digest('hex'));
});
test('WBI published reference vector',()=>{
  assert.equal(sign({foo:'114',bar:'514',zab:1919810},'7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45',1702204169),'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4');
});
test('All terms required across fields; exclusions and title scope work',()=>{
 const v={title:'Ｐｙｔｈｏｎ 教程',description:'异步入门',tags:'编程'};
 const required=terms('Python 异步');
 assert.equal(matches(v,required,[],'all'),true);
 assert.equal(matches(v,required,[],'title'),false);
 assert.equal(matches(v,required,['入门'],'all'),false);
 assert.equal(matches(v,terms('Python 爬虫'),[],'all'),false);
 assert.equal(matches({title:'异步任务',description:'',tags:''},required,[],'all'),false);
});

test('Native URLs retain sort, duration, category, date, and deep-link page',()=>{
 const c=readConfig('https://search.bilibili.com/video?keyword=Python&order=pubdate&duration=2&tids_1=36&tids_2=201&pubtime_begin_s=100&pubtime_end_s=200&page=3');
 assert.equal(c.params.tids,'201');assert.equal(c.params.order,'pubdate');assert.equal(c.params.duration,'2');
 assert.equal(c.params.pubtime_begin_s,'100');assert.equal(c.params.pubtime_end_s,'200');assert.equal(c.page,3);
 assert.equal(readConfig('https://search.bilibili.com/bangumi?keyword=Python'),null);
 assert.equal(readConfig('https://search.bilibili.com/all'),null);
 assert.equal(readConfig('https://search.bilibili.com/all?keyword=Python&spm_id_from=x').key,readConfig('https://search.bilibili.com/all?keyword=Python').key);
});

const runtimeModules=process.env.CODEX_TEST_MODULES;
let firefox;
try { ({firefox}=require(require.resolve('playwright',{paths:runtimeModules?[runtimeModules]:undefined}))); } catch {}
const fixture=`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:14px system-ui}.search-header{padding:20px}.search-content{max-width:1200px;margin:20px auto}.video-list{display:grid;grid-template-columns:repeat(5,1fr)}nav{margin:20px 0}.bili-video-card{height:180px}
</style></head><body><header class="search-header"><form id="native-form"><input id="native-query" value="Python 异步"><button>搜索</button></form></header>
<main class="search-content"><nav><a id="native-video" href="/video?keyword=Python">视频</a> 综合 视频 番剧 用户 <button id="native-sort">最新发布</button></nav>
<div id="native-grid" class="video-list row"><div class="video-list-item col_3"><div class="bili-video-card"><a href="https://www.bilibili.com/video/BV0000000001">原生视频卡片</a></div></div></div><div class="vui_pagenation"><button>原始下一页</button></div></main>
<script>document.querySelector('#native-form').onsubmit=e=>{e.preventDefault();history.pushState({},'', '/all?keyword='+encodeURIComponent(document.querySelector('#native-query').value));};document.querySelector('#native-sort').onclick=()=>{const u=new URL(location.href);u.searchParams.set('order','pubdate');u.searchParams.set('duration','2');u.searchParams.set('tids','201');u.searchParams.set('pubtime_begin_s','100');history.pushState({},'',u);};</script>
</body></html>`;

test('Firefox: native integration, refill, filters, hydration, dark mode, errors and navigation',{skip:!firefox,timeout:60000},async()=>{
 const browser=await firefox.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1400,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://search.bilibili.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
 await page.goto('https://search.bilibili.com/all?keyword=Python%20异步');
 await page.evaluate(()=>{
  window.calls=[];window.mode='normal';window.menus={};window.preferences={};
  window.GM_getValue=(key,fallback)=>preferences[key]??fallback;
  window.GM_setValue=(key,value)=>preferences[key]=value;
  window.GM_registerMenuCommand=(label,callback)=>menus[label]=callback;
  window.GM_xmlhttpRequest=opts=>{
   const url=new URL(opts.url);let cancelled=false;
   const p=Number(url.searchParams.get('page'));const q=url.searchParams.get('keyword');
   if(p)window.calls.push(Object.fromEntries(url.searchParams));
   const mode=window.mode;
   const timer=setTimeout(()=>{
    if(cancelled)return;
    let data;
    if(url.pathname.endsWith('/nav'))data={code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png'}}};
    else if(mode==='error')data={code:-412,message:'请求被拦截'};
    else {
     const make=(n,title)=>({bvid:'BV'+String(n).padStart(10,'0'),title,description:'异步',tag:'编程',author:'测试UP',mid:42,pic:'',duration:'10:00',play:123,video_review:4,pubdate:1700000000});
     let list;
     if(mode==='empty')list=Array.from({length:20},(_,i)=>make(p*100+i,'完全无关'));
     else if(q!=='Python 异步')list=[make(999,q)];
     else if(p===1)list=[make(1,'Python'),make(2,'无关')];
     else if(p===2)list=[make(1,'<em>Python</em>'),make(3,'<em>Python</em>')];
     else list=Array.from({length:20},(_,i)=>make(p*100+i,'Python'));
     data={code:0,data:{result:list,numPages:mode==='empty'?2:q!=='Python 异步'?1:5}};
    }
    opts.onload({status:200,responseText:JSON.stringify(data)});
   },mode==='slow'?800:5);
   return {abort(){cancelled=true;clearTimeout(timer);opts.onabort?.();}};
  };
 });
 await page.addScriptTag({content:script});
 const results=page.locator('#bse-results');
 await page.waitForFunction(()=>document.querySelectorAll('.bse-card').length===22);
 assert.deepEqual(await page.evaluate(()=>calls.map(c=>Number(c.page))),[1,2,3]);
 assert.equal(await page.locator('#native-query').isVisible(),true);
 assert.equal(await page.locator('#native-sort').isVisible(),true);
 assert.equal(await page.locator('#native-grid').isVisible(),false);
 assert.equal(await page.locator('.vui_pagenation').isVisible(),false);
 assert.equal(await page.locator('[role=dialog], #bili-precise-search-host, #launch').count(),0);
 assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(24, 25, 28)');
 assert.equal(await results.locator('.bse-author').first().getAttribute('href'),'https://space.bilibili.com/42');
 assert.equal(await results.locator('.bse-title').nth(1).textContent(),'Python');
 // Hydration removes and replaces the native grid. Existing results must remount, not refetch.
 await page.evaluate(()=>{
  const section=document.querySelector('.search-content');const grid=document.querySelector('#native-grid').cloneNode(true);grid.removeAttribute('data-bse-native-hidden');
  const pager=document.querySelector('.vui_pagenation').cloneNode(true);pager.removeAttribute('data-bse-native-hidden');
  document.querySelector('#native-grid').remove();document.querySelector('#bse-results').remove();document.querySelector('.vui_pagenation').remove();section.append(grid,pager);
 });
 await page.waitForFunction(()=>document.querySelectorAll('#bse-results .bse-card').length===22&&document.querySelector('#native-grid').hasAttribute('data-bse-native-hidden'));
 assert.equal(await page.evaluate(()=>calls.length),3);
 // Approaching the footer automatically appends a new batch without native pagination.
 await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
 await page.waitForFunction(()=>document.querySelectorAll('.bse-card').length===42);
 assert.deepEqual(await page.evaluate(()=>calls.map(c=>Number(c.page))),[1,2,3,4]);
 // Pause while another page is in flight; existing cards stay intact.
 await page.evaluate(()=>window.mode='slow');
 await results.getByRole('button',{name:'加载更多',exact:true}).evaluate(el=>el.click());
 await page.waitForFunction(()=>calls.some(c=>c.page==='5'));
 await results.getByRole('button',{name:'暂停',exact:true}).evaluate(el=>el.click());
 await results.locator('.bse-message').filter({hasText:'已暂停'}).waitFor();
 assert.equal(await results.locator('.bse-card').count(),42);
 await page.evaluate(()=>{window.mode='normal';scrollTo(0,0);});

 // Existing sort/filter control drives the enhancement. Never create a second form.
 await page.locator('#native-sort').click();
 await page.waitForFunction(()=>calls.some(c=>c.order==='pubdate'));
 const last=await page.evaluate(()=>calls.at(-1));assert.equal(last.duration,'2');assert.equal(last.tids,'201');assert.equal(last.pubtime_begin_s,'100');
 assert.equal(await page.locator('form').count(),1);
 // A new native search cancels old work and cannot retain old videos.
 await page.evaluate(()=>window.mode='slow');
 await page.locator('#native-query').fill('旧词');await page.locator('#native-query').press('Enter');
 await page.waitForFunction(()=>calls.some(c=>c.keyword==='旧词'));
 await page.evaluate(()=>window.mode='normal');
 await page.locator('#native-query').fill('新词');await page.locator('#native-query').press('Enter');
 await page.waitForFunction(()=>document.querySelector('.bse-title')?.textContent==='新词');
 assert.equal(await results.locator('.bse-card').count(),1);
 // Dark mode setting remains in the manager, not a new toolbar on the website.
 await page.evaluate(()=>menus['切换深色 / 浅色']());
 assert.equal(await page.locator('html').getAttribute('data-bse-dark'),null);
 assert.equal(await page.evaluate(()=>preferences.dark),false);
 await page.evaluate(()=>menus['切换深色 / 浅色']());
 // API errors stop and retain a retry action, not an empty terminal state.
 await page.evaluate(()=>window.mode='error');
 await page.locator('#native-query').fill('错误测试');await page.locator('#native-query').press('Enter');
 await results.locator('[data-error]').waitFor();assert.match(await results.locator('.bse-message').textContent(),/-412/);
 assert.equal(await results.getByRole('button',{name:'重试',exact:true}).isEnabled(),true);
 await page.evaluate(()=>window.mode='normal');
 await results.getByRole('button',{name:'重试',exact:true}).evaluate(el=>el.click());
 await page.waitForFunction(()=>document.querySelector('.bse-title')?.textContent==='错误测试');
 assert.equal(await results.locator('.bse-card').count(),1);
 // An all-unrelated result set stays empty and never restores irrelevant content.
 await page.evaluate(()=>window.mode='empty');
 await page.locator('#native-query').fill('空结果');await page.locator('#native-query').press('Enter');
 await results.locator('.bse-message').filter({hasText:'没有找到'}).waitFor();
 assert.equal(await results.locator('.bse-card').count(),0);
 assert.equal(await results.getByRole('button',{name:'加载更多',exact:true}).isVisible(),false);
 // Navigating to another native category restores the original page.
 await page.evaluate(()=>history.pushState({},'', '/bili_user?keyword=用户'));
 await page.waitForFunction(()=>!document.querySelector('#bse-results'));
 assert.equal(await page.locator('#native-grid').isVisible(),true);
 assert.equal(await page.locator('.vui_pagenation').isVisible(),true);
 // Late mounting: start with no video list and inject it after the route change.
 await page.evaluate(()=>{document.querySelector('#native-grid').remove();window.mode='normal';history.pushState({},'', '/video?keyword=延迟加载');});
 await page.waitForTimeout(300);
 assert.equal(await results.count(),0);
 await page.evaluate(()=>{const grid=document.createElement('div');grid.className='video-list';grid.id='native-grid';document.querySelector('.search-content').append(grid);});
 await page.waitForFunction(()=>document.querySelector('.bse-title')?.textContent==='延迟加载');
 assert.equal(await results.locator('.bse-card').count(),1);
 // Menu escape hatch restores the site immediately.
 await page.evaluate(()=>menus['恢复原始搜索 / 重新启用过滤']());
 assert.equal(await results.count(),0);assert.equal(await page.locator('#native-grid').getAttribute('data-bse-native-hidden'),null);
 assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});
