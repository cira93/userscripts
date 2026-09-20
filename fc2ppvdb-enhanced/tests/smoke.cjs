const {chromium}=require('playwright');
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage(); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/*',r=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:`<html><body><main><div id="bookmark"><div class="tooltip"><button id="unheart-button">Favorite</button></div></div><div class="grid"><div class="card card-sm"><figure><a href="/articles/1234567"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a></figure><h2 class="card-title"><a href="/articles/1234567">Fixture</a></h2></div></div></main></body></html>`}):r.abort());
  await page.goto('https://fc2cmadb.com/actresses/fixture');
  await page.evaluate(()=>{
   const storage=new Map([["settings_v1", {enableMagnets:false}]]);
   window.GM_info={script:{version:'2.1.10'}};
   window.GM_getValue=(k,d)=>storage.has(k)?storage.get(k):d;
   window.GM_setValue=(k,v)=>storage.set(k,v);
   window.GM_deleteValue=k=>storage.delete(k);
   window.GM_addValueChangeListener=()=>1;
   window.GM_removeValueChangeListener=()=>{};
   window.GM_registerMenuCommand=()=>1;
   window.GM_unregisterMenuCommand=()=>{};
   window.GM_addStyle=css=>{const el=document.createElement('style');el.textContent=css;document.head.append(el);return el;};
   window.portalRequests = [];
   window.GM_xmlhttpRequest=opts=>{
     const site = opts.url.includes('supjav.com') ? 'supjav' : opts.url.includes('missav.ws') ? 'missav' : null;
     if (site) window.portalRequests.push(site);
     const timer = setTimeout(()=>site ? opts.onload({status:200, finalUrl:opts.url, responseText:site==='supjav'
       ? '<div class="posts"><div class="post"><h3><a href="https://supjav.com/123.html">FC2-PPV-1234567</a></h3></div></div>'
       : '<h1>FC2-PPV-1234567</h1><video></video>'}) : opts.onerror?.({status:0}),0);
     return{abort(){clearTimeout(timer);opts.onabort?.();}};
   };
   window.GM_notification=()=>{};
   window.unsafeWindow=window;
  });
  await page.addScriptTag({path:process.env.DEXIE_PATH || require.resolve('dexie')});
  const source = fs.readFileSync(path.join(__dirname, '../fc2ppvdb-enhanced.user.js'), 'utf8');
  // Expose only the existing state for integration assertions; no implementation stub.
  await page.addScriptTag({content: source.replace('})(Dexie);', `window.testState = State;
    PortalBrowserTransport.prototype.query = async function(site) {
      window.portalRequests.push(site); return {result:'found'};
    }; })(Dexie);`)});
  await page.locator('.processed-card').waitFor({timeout:12000});
  if(!await page.locator('#unheart-button').isVisible()) throw Error('Native bookmark hidden');
  if(!await page.locator('#fc2-modern-ui-host').count()) throw Error('UI not initialized');
  await page.locator('.btn-site-supjav').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelectorAll('.fc2-portal-found').length===2, null, {timeout:10000});
  const successColor = await page.evaluate(()=>{ const el=document.createElement('span');el.style.color='var(--fc2-success)';document.body.append(el);const color=getComputedStyle(el).color;el.remove();return color; });
  await page.waitForFunction(color=>getComputedStyle(document.querySelector('.btn-site-supjav')).color===color,successColor,{timeout:3000});
  assert.equal(await page.locator('.btn-site-supjav').evaluate(el=>getComputedStyle(el).color), successColor);
  assert.equal(await page.locator('.btn-site-missav').evaluate(el=>getComputedStyle(el).color), successColor);
  assert.equal(await page.evaluate(()=>window.portalRequests.length), 2);
  await page.evaluate(()=>{window.testState.proxy.enableExternalLinks=false;});
  assert.equal(await page.locator('.btn-site-supjav').isVisible(),false);
  assert.equal(await page.locator('.btn-site-missav').isVisible(),false);
  await page.evaluate(()=>{window.testState.proxy.enableExternalLinks=true;window.testState.proxy.portalCheckMode='off';});
  assert.equal(await page.locator('.btn-site-supjav').isVisible(),true);
  assert.equal(await page.locator('.fc2-portal-found').count(),0);
  await page.evaluate(()=>{window.testState.proxy.portalCheckMode='visible';window.testState.proxy.enabledPortals=['supjav'];});
  assert.equal(await page.locator('.btn-site-missav').isVisible(),false);
  assert.equal(await page.locator('.btn-site-supjav.fc2-portal-found').count(),1);
  assert.equal(await page.evaluate(()=>window.portalRequests.length), 2);
  await page.route('https://missav.ws/**', route=>route.fulfill({contentType:'text/html',body:'<html><body><h1>FC2 PPV 4974973</h1></body></html>'}));
  await page.goto('https://missav.ws/dm13/en/fc2-ppv-4974973');
  await page.evaluate(()=>{
    const storage=new Map();
    window.GM_info={script:{version:'2.1.10'}};
    window.GM_getValue=(key,fallback)=>storage.get(key) ?? fallback;
    window.GM_setValue=(key,value)=>storage.set(key,value);
    window.GM_addValueChangeListener=()=>1;
  });
  await page.addScriptTag({path:process.env.DEXIE_PATH || require.resolve('dexie')});
  await page.addScriptTag({content:source});
  await page.waitForFunction(()=>GM_getValue('portal_availability_v4_missav',{}).entries?.['fc2:4974973']?.status==='found');
  assert.equal(await page.locator('#fc2-modern-ui-host').count(),0,'native site must not start the FC2 UI');
  assert.deepEqual(errors, []);
  console.log('Full userscript PASS; bookmark visible; two results highlighted; settings, cache and native-page result reporting verified; errors:',JSON.stringify(errors));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
