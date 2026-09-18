const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../bilibili-search-enhancer.user.js'), 'utf8');
const context = { module: { exports: {} }, TextEncoder, URL };
vm.runInNewContext(script, context);
const {md5,sign,matches,terms,readConfig,toNativeRecord}=context.module.exports;
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
const vuePath=process.env.VUE_TEST_RUNTIME;
const fixture='<!doctype html><html><head><meta charset="utf-8"><style>body{background:rgb(245,246,247);margin:20px;font:14px system-ui}.video-list{display:grid;grid-template-columns:repeat(5,1fr);gap:16px}.bili-video-card{height:180px;border:1px solid #ddd}.search-content{min-height:400px}</style></head><body><div id="app"></div></body></html>';

test('Firefox production Vue: original component identity and events survive refill, route changes and retry',{skip:!firefox||!vuePath,timeout:60000},async()=>{
 const browser=await firefox.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1400,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://search.bilibili.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
 await page.goto('https://search.bilibili.com/all?keyword=Python%20异步');
 await page.addScriptTag({path:vuePath});
 await page.evaluate(()=>{
  const {createApp,h,ref,reactive}=Vue;
  window.calls=[];window.mode='normal';window.menus={};window.preferences={};window.saved=[];window.previews=[];
  window.make=(n,title)=>({bvid:'BV'+String(n).padStart(10,'0'),title,description:'异步',tag:'编程',author:'测试UP',mid:42,pic:'',duration:'10:00',play:123});
  window.seed=()=>[make(1,'Python'),make(2,'不相关')];
  window.GM_getValue=(key,fallback)=>preferences[key]??fallback;
  window.GM_setValue=(key,value)=>preferences[key]=value;
  window.GM_registerMenuCommand=(label,callback)=>menus[label]=callback;
  window.unsafeWindow=window;
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
     let list;
     if(mode==='empty')list=Array.from({length:20},(_,i)=>make(p*100+i,'完全无关'));
     else if(q!=='Python 异步')list=[make(999,q)];
     else if(p===1)list=seed();
     else if(p===2)list=[make(1,'Python'),make(3,'Python')];
     else list=Array.from({length:20},(_,i)=>make(p*100+i,'Python'));
     data={code:0,data:{result:list,numPages:mode==='empty'?2:q!=='Python 异步'?1:6}};
    }
    opts.onload({status:200,responseText:JSON.stringify(data)});
   },mode==='slow'?800:5);
   return {abort(){cancelled=true;clearTimeout(timer);opts.onabort?.();}};
  };
  const NativeCard={props:['video'],setup(props){const clicks=ref(0);return()=>h('article',{class:'bili-video-card','data-bvid':props.video.bvid,onMouseenter:()=>previews.push(props.video.bvid)},[
   h('a',{href:'https://www.bilibili.com/video/'+props.video.bvid},props.video.title),
   h('button',{class:'watch-later',onClick:()=>{clicks.value++;saved.push(props.video.bvid);}},'稍后再看 '+clicks.value)
  ]);}};
  // The card component's interactive implementation is owned by the site fixture,
  // never imported or rebuilt by the userscript.
  const App={setup(){return {results:reactive({result:seed()}),query:ref('Python 异步')};},render(){return h('main',{class:'search-content'},[
   h('form',{id:'native-form',onSubmit:e=>{e.preventDefault();history.pushState({},'','/all?keyword='+encodeURIComponent(this.query));this.results.result=seed();}},[
    h('input',{id:'native-query',value:this.query,onInput:e=>this.query=e.target.value}),h('button','搜索')]),
   h('button',{id:'native-sort',onClick:()=>{const u=new URL(location.href);u.searchParams.set('order','pubdate');u.searchParams.set('duration','2');u.searchParams.set('tids','201');history.pushState({},'',u);this.results.result=seed();}},'最新发布'),
   h('div',{id:'native-grid',class:'video-list'},this.results.result.map(v=>h(NativeCard,{key:v.bvid,video:v}))),
   h('div',{class:'vui_pagenation'},'原始下一页')]);}};
  window.app=createApp(App);window.app.mount('#app');
  window.firstNativeCard=document.querySelector('.bili-video-card');
 });
 // Production Vue has no devtools DOM backlink; the adapter must use root vnode.
 assert.equal(await page.evaluate(()=>!!document.querySelector('.bili-video-card').__vueParentComponent),false);
 await page.addScriptTag({content:script});
 await page.waitForFunction(()=>document.querySelectorAll('.bili-video-card').length===22);
 assert.deepEqual(await page.evaluate(()=>calls.map(c=>Number(c.page))),[1,2,3]);
 assert.equal(await page.evaluate(()=>document.querySelector('.bili-video-card')===firstNativeCard),true);
 assert.equal(await page.locator('#native-grid').isVisible(),true);
 assert.equal(await page.locator('.vui_pagenation').isVisible(),false);
 assert.equal(await page.locator('.bse-card,#bse-results,[role=dialog]').count(),0);
 assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(245, 246, 247)');
 assert.equal(await page.locator('[data-bse-dark]').count(),0);
 await page.locator('.bili-video-card').first().hover();
 await page.locator('.watch-later').first().click();
 assert.deepEqual(await page.evaluate(()=>saved),['BV0000000001']);
 assert.equal(await page.locator('.watch-later').first().textContent(),'稍后再看 1');
 // Real native events must also work for cards added from later pages.
 await page.locator('.bili-video-card').nth(2).hover();
 await page.locator('.watch-later').nth(2).click();
 assert.equal(await page.evaluate(()=>saved.at(-1)),'BV0000000300');
 assert.equal(await page.evaluate(()=>previews.includes('BV0000000300')),true);
 await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
 await page.waitForFunction(()=>document.querySelectorAll('.bili-video-card').length===42);
 assert.equal(await page.locator('.watch-later').first().textContent(),'稍后再看 1');
 // Pause a live request. Progress distinguishes waiting from a deliberate pause.
 await page.evaluate(()=>window.mode='slow');
 await page.locator('#bse-footer').getByRole('button',{name:'加载更多',exact:true}).evaluate(el=>el.click());
 await page.waitForFunction(()=>calls.some(c=>c.page==='5'));
 assert.match(await page.locator('.bse-message').textContent(),/本轮已检查.*新增.*秒/);
 await page.locator('#bse-footer').getByRole('button',{name:'暂停',exact:true}).evaluate(el=>el.click());
 await page.locator('.bse-message').filter({hasText:'你暂停了'}).waitFor();
 assert.equal(await page.locator('.bili-video-card').count(),42);
 await page.evaluate(()=>{window.mode='normal';scrollTo(0,0);});
 // URL filters are retained while the page renders its original components.
 await page.locator('#native-sort').click();
 await page.waitForFunction(()=>calls.some(c=>c.order==='pubdate'));
 assert.equal(await page.evaluate(()=>calls.at(-1).tids),'201');
 assert.equal(await page.evaluate(()=>calls.at(-1).duration),'2');
 // Cancel a search with an in-flight request and replace it via the native form.
 await page.evaluate(()=>window.mode='slow');
 await page.locator('#native-query').fill('旧词');await page.locator('#native-query').press('Enter');
 await page.waitForFunction(()=>calls.some(c=>c.keyword==='旧词'));
 await page.evaluate(()=>window.mode='normal');
 await page.locator('#native-query').fill('新词');await page.locator('#native-query').press('Enter');
 await page.waitForFunction(()=>document.querySelector('.bili-video-card a')?.textContent==='新词');
 assert.equal(await page.locator('.bili-video-card').count(),1);
 // A site-owned array replacement (hydration/refetch) must render our current rows again.
 await page.evaluate(()=>app._container._vnode.component.setupState.results.result=seed());
 await page.waitForFunction(()=>document.querySelector('.bili-video-card a')?.textContent==='新词');
 // Errors are recoverable without falsely reporting that the source is exhausted.
 await page.evaluate(()=>window.mode='error');
 await page.locator('#native-query').fill('错误测试');await page.locator('#native-query').press('Enter');
 await page.locator('.bse-message[data-error]').waitFor();assert.match(await page.locator('.bse-message').textContent(),/-412/);
 await page.evaluate(()=>window.mode='normal');
 await page.locator('#bse-footer').getByRole('button',{name:'重试',exact:true}).evaluate(el=>el.click());
 await page.waitForFunction(()=>document.querySelector('.bili-video-card a')?.textContent==='错误测试');
 // Unrelated pages are not reintroduced as padding.
 await page.evaluate(()=>window.mode='empty');
 await page.locator('#native-query').fill('空结果');await page.locator('#native-query').press('Enter');
 await page.locator('.bse-message').filter({hasText:'没有找到'}).waitFor();
 assert.equal(await page.locator('.bili-video-card').count(),0);
 // Restoring the site returns its original list and functioning components.
 await page.evaluate(()=>menus['恢复原始搜索 / 重新启用过滤']());
 await page.waitForFunction(()=>document.querySelectorAll('.bili-video-card').length===2);
 assert.equal(await page.locator('#bse-footer').count(),0);
 assert.equal(await page.locator('.vui_pagenation').isVisible(),true);
 assert.deepEqual(errors,[]);
 } finally {await browser.close();}
});

test('Firefox: unsupported native renderer remains untouched and does not run API scans',{skip:!firefox,timeout:20000},async()=>{
 const browser=await firefox.launch({headless:true});try{
 const page=await browser.newPage();await page.route('https://search.bilibili.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<html><body><div class="search-content"><div class="video-list"><a href="https://www.bilibili.com/video/BV0000000001">原视频</a></div><div class="vui_pagenation">下一页</div></div></body></html>'}));
 await page.goto('https://search.bilibili.com/all?keyword=Python');
 await page.evaluate(()=>{window.GM_xmlhttpRequest=()=>{throw new Error('Should not request');};});
 await page.addScriptTag({content:script});
 await page.locator('.bse-message').filter({hasText:'未能接入原生卡片'}).waitFor({timeout:12000});
 assert.equal(await page.locator('.video-list').isVisible(),true);assert.equal(await page.locator('.vui_pagenation').isVisible(),true);
 assert.equal(await page.locator('.video-list a').textContent(),'原视频');
 }finally{await browser.close();}
});

test('Firefox: ignore matching caches, notify shallowRef ancestors, and wait for delayed native rendering',{skip:!firefox||!vuePath,timeout:25000},async()=>{
 const browser=await firefox.launch({headless:true});try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://search.bilibili.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
 await page.goto('https://search.bilibili.com/all?keyword=Python');await page.addScriptTag({path:vuePath});
 await page.evaluate(()=>{
  const {createApp,h,shallowRef,reactive,ref,watch}=Vue;
  const rows=()=>[{bvid:'BV0000000001',title:'Python',description:'',tag:'',duration:'1:00',play:1},{bvid:'BV0000000002',title:'无关',description:'',tag:'',duration:'1:00',play:1}];
  window.menus={};window.copied='';window.calls=0;window.unsafeWindow=window;
  window.GM_registerMenuCommand=(name,callback)=>menus[name]=callback;
  window.GM_setClipboard=text=>window.copied=text;
  window.GM_xmlhttpRequest=opts=>{window.calls++;const timer=setTimeout(()=>opts.onload({status:200,responseText:JSON.stringify(opts.url.includes('/nav')?{code:0,data:{wbi_img:{img_url:'https://x/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://x/4932caff0ff746eab6f01bf08b70ac45.png'}}}:{code:0,data:{result:rows(),numPages:1}})}),5);return{abort(){clearTimeout(timer);opts.onabort?.();}};};
  window.app=createApp({setup(){
   // Both arrays contain exactly the current videos, but cache never drives the UI.
   const cache=reactive({result:rows()});const response=shallowRef({data:{result:rows()}});
   const displayed=ref(rows());let timer;
   // Only replacing the shallowRef ancestor triggers this reference-only watcher.
   watch(response,value=>{clearTimeout(timer);timer=setTimeout(()=>displayed.value=value.data.result,350);});
   // Keep display state in render closure: adapter must modify the actual source,
   // not bypass the native processing pipeline by assigning a display-only list.
   window.nativeDisplayed=displayed;
   return {cache,response,renderCards:()=>displayed.value.map(v=>h('article',{class:'bili-video-card',key:v.bvid},h('a',{href:'https://www.bilibili.com/video/'+v.bvid},v.title)))};
  },render(){return h('div',{class:'search-content'},[h('div',{class:'video-list'},this.renderCards()),h('div',{class:'vui_pagenation'},'原分页')]);}});app.mount('#app');
 });
 await page.addScriptTag({content:script});
 await page.waitForFunction(()=>document.querySelector('.bse-message')?.textContent==='没有更多相关视频了',null,{timeout:18000});
 assert.equal(await page.locator('.bili-video-card').count(),1);
 assert.equal(await page.locator('.bili-video-card a').textContent(),'Python');
 assert.equal(await page.evaluate(()=>app._container._vnode.component.setupState.cache.result.length),2);
 await page.evaluate(()=>menus['复制原生卡片适配诊断']());
 const report=JSON.parse(await page.evaluate(()=>copied));
 assert.ok(report.attempts.some(a=>a.path.includes('cache')&&a.result==='render-mismatch'));
 assert.ok(report.attempts.some(a=>a.path.includes('response')&&a.result==='ok'&&a.waitMs>80));
 assert.equal(JSON.stringify(report).includes('keyword'),false);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('API rows become native display records without borrowing another video metadata',()=>{
 const source={bvid:'BV0000000040',aid:40,mid:88,title:'Python',author:'新作者',pic:'//i0.hdslb.com/new.jpg',description:'新简介',video_review:12,tag:'Python,异步',duration:'2:00',is_pay:1};
 const example={bvid:'BV0000000001',id:'BV0000000001',uid:'11',uname:'旧作者',url:'https://www.bilibili.com/video/BV0000000001',cover:'//i0.hdslb.com/old.jpg',desc:'旧简介',danmaku:3,tags:[],is_pay:0};
 const actual=toNativeRecord(source,example);
 assert.equal(actual.url,'https://www.bilibili.com/video/BV0000000040');assert.equal(actual.cover,source.pic);
 assert.equal(actual.uid,'88');assert.equal(actual.uname,'新作者');assert.equal(actual.desc,'新简介');assert.equal(actual.danmaku,12);
 assert.equal(actual.id,source.bvid);assert.deepEqual(Array.from(actual.tags),['Python','异步']);assert.equal(actual.is_pay,1);
 assert.equal(source.url,undefined);assert.equal(toNativeRecord(source,{}).id,undefined);
 assert.equal(toNativeRecord({...source,url:'https://www.bilibili.com/video/BV0000000040',danmaku:0},example).danmaku,0);
});

test('Firefox VideoList.props.info: 39 native rows plus 6 API rows render all 45 with working native actions',{skip:!firefox||!vuePath,timeout:20000},async()=>{
 const browser=await firefox.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1400,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://search.bilibili.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:fixture}));
 await page.goto('https://search.bilibili.com/all?keyword=Python');await page.addScriptTag({path:vuePath});
 await page.evaluate(()=>{
  const {createApp,h,reactive}=Vue;
  const raw=i=>({bvid:'BV'+String(i).padStart(10,'0'),aid:i,id:i,mid:100+i,title:'Python '+i,author:'作者 '+i,description:'简介 '+i,pic:'//i0.hdslb.com/'+i+'.jpg',play:i,video_review:i,tag:'Python,编程',type:'video',duration:'1:00'});
  const display=i=>{const v=raw(i);return {...v,cover:v.pic,url:'https://www.bilibili.com/video/'+v.bvid,uid:v.mid,uname:v.author,desc:v.description,danmaku:v.video_review,tags:v.tag};};
  window.saved=[];window.requests=0;window.menus={};window.unsafeWindow=window;
  window.GM_registerMenuCommand=(name,callback)=>menus[name]=callback;
  window.GM_xmlhttpRequest=opts=>{
   const isNav=opts.url.includes('/nav');if(!isNav)requests++;
   const timer=setTimeout(()=>opts.onload({status:200,responseText:JSON.stringify(isNav?{code:0,data:{wbi_img:{img_url:'https://x/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://x/4932caff0ff746eab6f01bf08b70ac45.png'}}}:{code:0,data:{result:Array.from({length:6},(_,i)=>raw(40+i)),numPages:1}})}),5);
   return{abort(){clearTimeout(timer);opts.onabort?.();}};
  };
  const VideoList={name:'VideoList',props:['info'],setup(props){return()=>h('div',{class:'video-list'},props.info.map(v=>h('article',{class:'bili-video-card',key:v.bvid},[
   // Match the distinction seen in the user diagnostic: raw API fields alone
   // do not supply the native component's link, cover, author and stats model.
   h('a',{href:v.url,'data-cover':v.cover},v.title),h('span',{class:'owner'},v.uname),h('span',{class:'danmaku'},String(v.danmaku??'')),
   h('button',{onClick:()=>saved.push({bvid:v.bvid,uid:v.uid,url:v.url})},'稍后再看')
  ])));}};
  // Source lives in a closure; only VideoList.props.info is exposed to the adapter.
  createApp({setup(){const info=reactive(Array.from({length:39},(_,i)=>display(i+1)));return()=>h('main',{class:'search-content'},[h(VideoList,{info}),h('div',{class:'vui_pagenation'},'原分页')]);}}).mount('#app');
  window.originalFirst=document.querySelector('.bili-video-card');
 });
 await page.addScriptTag({content:script});
 await page.locator('.bse-message').filter({hasText:'向下滚动'}).waitFor();
 assert.equal(await page.locator('.bili-video-card').count(),39);
 await page.locator('#bse-footer').getByRole('button',{name:'加载更多',exact:true}).evaluate(el=>el.click());
 await page.locator('.bse-message').filter({hasText:'没有更多相关视频了'}).waitFor();
 assert.equal(await page.locator('.bili-video-card').count(),45);
 assert.equal(await page.locator('.video-list a[href*="/video/BV"]').count(),45);
 assert.equal(await page.locator('.bili-video-card').last().locator('a').getAttribute('data-cover'),'//i0.hdslb.com/45.jpg');
 assert.equal(await page.locator('.owner').last().textContent(),'作者 45');assert.equal(await page.locator('.danmaku').last().textContent(),'45');
 await page.locator('.bili-video-card').last().getByRole('button').click();
 assert.deepEqual(await page.evaluate(()=>saved),[{bvid:'BV0000000045',uid:145,url:'https://www.bilibili.com/video/BV0000000045'}]);
 assert.equal(await page.evaluate(()=>originalFirst===document.querySelector('.bili-video-card')),true);
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

// Replay captured public HTML and the site's own bundled Vue/card components.
// These external assets are opt-in, kept outside the repository, and no account
// or live API is used. All network traffic is blocked in this regression test.
const siteHTML=process.env.BSE_SITE_HTML,siteBundle=process.env.BSE_SITE_BUNDLE;
test('Firefox actual Bilibili bundle: refill schedules native rendering and restores original cards',{
 skip:!firefox||!siteHTML||!siteBundle,timeout:20000
},async()=>{
 const browser=await firefox.launch({headless:true});try{
  const page=await browser.newPage({viewport:{width:1400,height:800}});
  const html=fs.readFileSync(siteHTML,'utf8')
   .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g,(whole,attrs,body)=>body.includes('window.__pinia=')||body.includes('window.abtest =')?whole:'')
   .replace(/<link[^>]*>/g,'');
  await page.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html; charset=utf-8',body:html}):r.abort());
  await page.goto('https://search.bilibili.com/all?keyword=Python');
  await page.addScriptTag({content:fs.readFileSync(siteBundle,'utf8'),type:'module'});
  await page.addStyleTag({content:'.to_hide_xs,.to_hide_md,.to_hide_xl{display:none!important}'});
  await page.waitForFunction(()=>!!document.querySelector('#app')?._vnode?.component);
  await page.evaluate(()=>{
   const queue=[document.querySelector('#app')._vnode],seen=new Set();let list;
   while(queue.length){const v=queue.pop();if(!v||seen.has(v))continue;seen.add(v);if(v.component){if(v.component.type.__name==='VideoList')list=v.component;queue.push(v.component.subTree);}if(Array.isArray(v.children))queue.push(...v.children);}
   if(!list)throw new Error('Captured bundle no longer exposes VideoList');
   window.nativeListComponent=list;window.originalRows=Array.from(list.props.info);
   window.originalCard=document.querySelector('.video-list .bili-video-card');
   window.originalCount=document.querySelectorAll('.video-list .bili-video-card').length;
   window.menus={};window.unsafeWindow=window;window.copied='';
   window.GM_registerMenuCommand=(name,fn)=>menus[name]=fn;window.GM_setClipboard=text=>copied=text;
   window.GM_xmlhttpRequest=opts=>{
    const result=Array.from({length:5},(_,i)=>({...originalRows.find(v=>v.type==='video'),id:9000000+i,aid:9000000+i,bvid:'BV999999999'+i,title:'Python regression '+i,description:'Python',type:'video',url:undefined,arcurl:undefined}));
    const data=opts.url.includes('/nav')?{code:0,data:{wbi_img:{img_url:'https://x/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://x/4932caff0ff746eab6f01bf08b70ac45.png'}}}:{code:0,data:{result,numPages:1}};
    const timer=setTimeout(()=>opts.onload({status:200,responseText:JSON.stringify(data)}),5);
    return{abort(){clearTimeout(timer);opts.onabort?.();}};
   };
  });
  await page.addScriptTag({content:script});
  await page.waitForFunction(()=>document.querySelector('.bse-message')?.textContent.includes('向下滚动'),null,{timeout:4000}).catch(async e=>{throw new Error('Initial status: '+await page.locator('#bse-footer').textContent());});
  const initial=await page.locator('.video-list .bili-video-card').count();
  await page.locator('#bse-footer').getByRole('button',{name:'加载更多',exact:true}).evaluate(el=>el.click());
  await page.waitForFunction(()=>document.querySelector('.bse-message')?.textContent==='没有更多相关视频了',null,{timeout:4000}).catch(async e=>{await page.evaluate(()=>menus['复制原生卡片适配诊断']());throw new Error('Refill: '+await page.locator('#bse-footer').textContent()+' '+await page.evaluate(()=>copied));});
  assert.equal(await page.locator('.video-list .bili-video-card').count(),initial+5);
  for(let i=0;i<5;i++)assert.ok(await page.locator('.video-list a[href*="BV999999999'+i+'"]').count()>0);
  assert.equal(await page.locator('.video-list .bili-video-card').last().isVisible(),true);
  await page.evaluate(()=>menus['复制原生卡片适配诊断']());
  const diagnostic=JSON.parse(await page.evaluate(()=>copied));
  assert.ok(diagnostic.attempts.every(a=>a.result==='ok'&&a.updateRequested));
  assert.equal(await page.evaluate(()=>originalCard===document.querySelector('.video-list .bili-video-card')),true);
  await page.evaluate(()=>menus['恢复原始搜索 / 重新启用过滤']());
  await page.waitForFunction(()=>document.querySelectorAll('.video-list .bili-video-card').length===originalCount);
  assert.equal(await page.locator('.video-list a[href*="BV999999999"]').count(),0);
  assert.equal(await page.locator('[data-bse-expanded]').count(),0);
 }finally{await browser.close();}
});
