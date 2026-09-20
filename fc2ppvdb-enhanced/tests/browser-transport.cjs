const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname,'../fc2ppvdb-enhanced.user.js'),'utf8');
const workerCode = source.slice(source.indexOf('  const PORTAL_CHECK_POLICY ='),source.indexOf('  class PortalAvailabilityService {'));
const code = `const Storage={get:(k,d)=>GM_getValue(k,d),set:(k,v)=>GM_setValue(k,v),delete:k=>GM_deleteValue(k)};\n${workerCode}\nObject.assign(window,{PortalBrowserTransport,startPortalBrowserWorker});`;
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const context=await browser.newContext();
  const values={}; const helpers=new Map(); const requests=[]; let opened=0; const pending=new Set();
  await context.exposeBinding('bridgeSet', async({page},key,value)=>{
    const old=values[key]; if(value===null)delete values[key];else values[key]=value;
    await Promise.all(context.pages().map(p=>p.evaluate(({key,value,old,remote})=>{
      if(value===null)delete window.gmValues[key];else window.gmValues[key]=value;
      if(!window.suppressGMNotifications) for(const listener of window.gmListeners.values())if(listener.key===key)listener.fn(key,old,value,remote);
    },{key,value,old,remote:p!==page}).catch(()=>{})));
  });
  const gmScript = snapshot => `
    window.gmValues=${JSON.stringify(snapshot)};window.gmListeners=new Map();let listenerId=0;
    window.GM_getValue=(key,fallback)=>window.gmValues[key]??fallback;
    window.GM_setValue=(key,value)=>{window.gmValues[key]=value;void window.bridgeSet(key,value);};
    window.GM_deleteValue=key=>{delete window.gmValues[key];void window.bridgeSet(key,null);};
    window.GM_addValueChangeListener=(key,fn)=>{const id=++listenerId;gmListeners.set(id,{key,fn});return id;};
    window.GM_removeValueChangeListener=id=>gmListeners.delete(id);
    window.GM_openInTab=(url,options)=>{const id=crypto.randomUUID();void window.bridgeOpen(id,url,options);return{closed:false,close(){this.closed=true;void window.bridgeClose(id);}};};
  `;
  await context.exposeBinding('bridgeOpen',async(_source,id,url,options)=>{
    assert.equal(options.active,false,'helpers must not take focus');
    opened++;
    const helper=await context.newPage(); helpers.set(id,helper);
    await helper.addInitScript({content:gmScript(values)});
    await helper.goto(url);
    await helper.addScriptTag({content:code});
    assert.equal(await helper.evaluate(()=>startPortalBrowserWorker()),true);
  });
  await context.exposeBinding('bridgeClose',async(_source,id)=>{
    const helper=helpers.get(id);if(helper){helpers.delete(id);await helper.close();}
  });
  await context.route('**/*',async route=>{
    const request=route.request(); const url=new URL(request.url());
    if(url.hostname==='fc2cmadb.com')return route.fulfill({contentType:'text/html',body:'<html><body>List</body></html>'});
    const id=url.searchParams.get('s')||url.pathname.match(/fc2-ppv-(\d+)/)?.[1];
    requests.push({host:url.hostname,id,navigation:request.isNavigationRequest(),type:request.resourceType()});
    let body, status=200;
    if(id==='1111111'){status=429;body='<title>Rate limited</title>';}
    else if(id==='0000000')body='<div class="no-results">No results</div>';
    else if(url.hostname==='supjav.com')body=`<div class="posts"><article class="post"><h3><a href="/${id}.html">FC2 PPV ${id}</a></h3></article></div>`;
    else body=`<script>history.replaceState(null,'',location.pathname+location.search)</script><h1>FC2 PPV ${id}</h1>`;
    await route.fulfill({status,contentType:'text/html',body,headers:status===429?{'Retry-After':'120'}:{}});
  });
  const page=await context.newPage();await page.addInitScript({content:gmScript(values)});
  await page.goto('https://fc2cmadb.com/');await page.addScriptTag({content:code});
  await page.evaluate(()=>window.transport=new PortalBrowserTransport());
  const query=(site,id)=>page.evaluate(({site,id})=>transport.query(site,id,site==='supjav'?`https://supjav.com/zh/?s=${id}`:`https://missav.ws/cn/fc2-ppv-${id}`),{site,id});
  assert.equal((await query('supjav','4974973')).result,'found');
  assert.equal((await query('supjav','4977133')).result,'found');
  assert.equal(opened,1,'second work must reuse existing helper');
  assert.equal(requests.filter(r=>r.id==='4977133'&&!r.navigation&&r.type==='fetch').length,1,'second work uses real same-origin browser fetch');
  assert.equal((await query('supjav','0000000')).result,'missing');
  const blocked=await query('supjav','1111111');
  assert.equal(blocked.result,'blocked');assert.equal(blocked.retryAfter,120000);assert.equal(blocked.reason,'rate-limited');
  assert.equal((await query('missav','4974973')).result,'found');
  assert.equal(opened,2,'at most one helper is created per site');
  await page.evaluate(()=>window.suppressGMNotifications=true);
  assert.equal((await query('supjav','4977001')).result,'found','saved reply is read even if GM reply notification is lost');
  await page.evaluate(()=>window.suppressGMNotifications=false);
  for(const helper of helpers.values()) await helper.evaluate(()=>window.suppressGMNotifications=true);
  assert.equal((await query('supjav','4977002')).result,'found','helper reads pending work when GM job notification is lost');
  for(const helper of helpers.values()) await helper.evaluate(()=>{
    window.suppressGMNotifications=false;
    window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  });
  assert.equal((await query('supjav','4977003')).result,'found','helper resumes its listeners after a persisted pagehide/pageshow');

  const manual=await context.newPage();
  await manual.goto("https://supjav.com/zh/?s=4974973");
  await page.evaluate(()=>transport.closeAll());
  for(let i=0;i<100&&helpers.size;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(helpers.size,0,'owned helper tabs are closed');
  assert.equal(manual.isClosed(),false,'manually opened site tabs remain open');
  console.log('PASS automatic helper navigation, real first-party fetch, reuse, two-site bound, result delivery, Retry-After and cleanup; missed notifications and page restoration');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
