const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../fc2ppvdb-enhanced.user.js'), 'utf8');
const code = source.slice(source.indexOf('  const PORTAL_CHECK_POLICY ='), source.indexOf("  AppContainer.register('portal-availability'"));
const harness = `
const Storage = { get: (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') || fallback, set: (key, value) => localStorage.setItem(key, JSON.stringify(value)) };
const State = { proxy: { portalCheckMode: 'visible', enableExternalLinks: true, enabledPortals: ['supjav','missav'] }, on: () => () => {} };
const Logger = { warn() {} };
const CoreEvents = { on: () => () => {} };
const AppEvents = { CARD_READY: 'ready' };
const t = key => key;
${code}
Object.assign(window, { PortalAvailabilityService, classifyPortalResponse, portalBlockReason, portalRetryAfter, State, Storage, policy: PORTAL_CHECK_POLICY });
PortalBrowserTransport.prototype.query = async function(site, id, url) {
  window.calls++;
  await new Promise(resolve => setTimeout(resolve, window.delay));
  return { result: classifyPortalResponse(site, id, window.response, url), retryAfter: portalRetryAfter(window.response.responseHeaders, Date.now()) };
};
window.calls = 0;
window.delay = 0;
window.response = { status:200, responseText:'<div class="posts"><div class="post"><h3><a href="https://supjav.com/1.html">FC2-PPV-1234567</a></h3></div></div>' };
window.GM_xmlhttpRequest = options => {
  window.calls++;
  window.lastOptions = options;
  const timer = setTimeout(() => options.onload(window.response), window.delay);
  return { abort() { clearTimeout(timer); options.onabort?.(); } };
};
window.makeButton = (id='1234567', site='supjav') => {
  const button = document.createElement('button'); button.textContent = site;
  Object.assign(button.dataset, {portalSite:site, portalKey:'fc2:'+id, portalId:id, portalLabel:site,
    portalUrl:site==='supjav'?'https://supjav.com/zh/?s='+id:'https://missav.ws/cn/fc2-ppv-'+id});
  document.body.append(button); return button;
};
`;
(async () => {
 const browser = await chromium.launch({headless:true});
 try {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
  const page = await context.newPage();
  await page.goto('https://fc2cmadb.com/'); await page.addScriptTag({content:harness});
  const results = await page.evaluate(async () => {
   const check = (ok,msg) => { if(!ok) throw Error(msg); };
   const url = 'https://supjav.com/zh/?s=1234567';
   const classify = (html,status=200) => classifyPortalResponse('supjav','1234567',{status,responseText:html},url);
   check(classify(window.response.responseText)==='found','exact result should match');
   check(classify(window.response.responseText.replace('1234567','12345678'))==='missing','longer IDs must not match');
   check(classify('<h1>1234567</h1><div class="posts"></div>')==='unknown','search heading is not a result');
   check(classify('<h1>1234567</h1>')==='unknown','unrecognized HTML is unknown');
   check(classify('<title>Just a moment...</title>')==='blocked','200 challenge must pause');
   check(classify('',429)==='blocked','429 must pause');
   check(classify('',403)==='blocked','403 must pause');
   check(portalBlockReason({status:429})==='rate-limited','429 is distinguished from verification');
   check(portalBlockReason({status:403,responseText:'<title>Just a moment...</title>'})==='site-verification','challenge reason survives a 403');
   check(portalBlockReason({status:403,responseText:'Forbidden'})==='access-denied','plain 403 is access denial');
   check(portalBlockReason({status:503})==='site-unavailable','503 is service unavailable');

   const missavUrl='https://missav.ws/cn/fc2-ppv-1234567';
   const missav = response => classifyPortalResponse('missav','1234567',response,missavUrl);
   check(missav({status:200,responseText:'<h1>FC2-PPV-1234567</h1><div x-data="player()"></div>'})==='found','detail heading plus player must match');
   check(missav({status:200,responseText:'<h1>Other</h1><a>1234567</a><video></video>'})==='unknown','recommendation must not match');
   check(missav({status:200,finalUrl:'https://missav.ws/login',responseText:'<h1>1234567</h1><video></video>'})==='unknown','redirect to other page must not match');
   check(missav({status:404,responseText:''})==='missing','404 is negative');
   check(missav({status:200,finalUrl:'https://missav.ws/dm13/en/fc2-ppv-1234567',responseText:'<h1>FC2 PPV 1234567</h1>'})==='found','locale/prefix redirects and client-rendered players are supported');
   check(classify('<div class="post"><h2><a href="https://supjav.com/123.html">FC2 PPV 1234567</a></h2></div>')==='found','alternate search headings are supported');

   check(portalRetryAfter('Retry-After: 3600',Date.now())===3600000,'Retry-After seconds');
   check(portalRetryAfter('Retry-After: Wed, 01 Jan 2031 00:00:00 GMT',Date.parse('2030-12-31T23:00:00Z'))===3600000,'Retry-After date');

   const svc=new PortalAvailabilityService(); const button=makeButton();
   svc.buttons.set(button, {visibleSince: Date.now()-2000, interestedUntil:0});
   await svc.check(button);
   check(calls===1 && button.classList.contains('fc2-portal-found'),'positive result highlights');

   await svc.check(button); check(calls===1,'cached result avoids network');
   const other=makeButton('2345678'); await svc.check(other);
   check(calls===2,'next ID runs immediately without fixed interval');
   State.proxy.portalCheckMode='off'; svc.paint(button);
   check(!button.classList.contains('fc2-portal-found'),'off removes highlight');
   await svc.check(other); check(calls===2,'off makes no requests');
   State.proxy.portalCheckMode='visible';
   State.proxy.enableExternalLinks=false; await svc.check(other);
   check(calls===2,'disabled external links make no requests');
   State.proxy.enableExternalLinks=true;
   const key=svc.key('supjav');
   const budget={entries:{}, nextAt:0, pausedUntil:0, requests:Array(30).fill(Date.now())};
   svc.results.clear(); Storage.set(key,budget); await svc.check(other); check(calls===3,'legacy hourly budget is ignored');
   budget.requests=Array(120).fill(Date.now()-7200000); svc.results.clear(); Storage.set(key,budget);
   await svc.check(other); check(calls===4,'legacy daily budget is ignored');
   svc.results.clear(); Storage.set(key,{entries:{},requests:[]});
   window.response={status:429,responseText:'',responseHeaders:'Retry-After: 86400'};
   await svc.check(other); check(calls===5,'one request to discover limit');
   check(svc.read('supjav').pausedUntil>Date.now()+86000000,'server cooldown respected');
   await svc.check(makeButton('3456789')); check(calls===5,'no retries after limit');
   check(!other.classList.contains('fc2-portal-found'),'blocked remains neutral');
   svc.results.clear(); Storage.set(key,{entries:{},requests:[]});
   window.delay=200;
   const cancelled=svc.check(makeButton('4567890'));
   await new Promise(resolve=>setTimeout(resolve,20));
   svc.onCleanup(); await cancelled;

   localStorage.clear(); window.calls=0; window.delay=100;
   const lockDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
   Object.defineProperty(navigator, 'locks', {value:undefined,configurable:true});
   const fallbackService=new PortalAvailabilityService();
   await Promise.all([fallbackService.check(makeButton()),fallbackService.check(makeButton('9876543'))]);
   check(calls===1,'without Web Locks requests still run with per-tab concurrency one');
   if (lockDescriptor) Object.defineProperty(navigator,'locks',lockDescriptor); else delete navigator.locks;
   localStorage.clear(); window.delay=0; window.calls=0;
   const hoverService=new PortalAvailabilityService();
   const hoverButton=makeButton();
   hoverService.buttons.set(hoverButton,{visibleSince:Date.now()-2000,interestedUntil:0});
   State.proxy.portalCheckMode='hover';
   hoverService.tick();
   await new Promise(resolve=>setTimeout(resolve,20));
   check(calls===0,'hover mode does not check merely visible cards');
   hoverService.buttons.get(hoverButton).interestedUntil=Date.now()+10000;
   hoverService.tick();
   await new Promise(resolve=>setTimeout(resolve,20));
   check(calls===1,'hover interest schedules a check');
   hoverService.onCleanup();
   State.proxy.portalCheckMode='visible';
   localStorage.clear();
   // All mounted cards must run without intersection events or scrolling.
   document.body.replaceChildren(); window.calls=0; window.delay=10;
   window.response={status:200,responseText:'<div class="no-results">No results</div>'};
   const pageService=new PortalAvailabilityService();
   const first=makeButton('4974973'); first.classList.add('btn-site-jump');
   const offscreen=makeButton('4974974'); offscreen.classList.add('btn-site-jump');
   offscreen.style.marginTop='5000px';
   const duplicate=makeButton('4974974'); duplicate.classList.add('btn-site-jump');
   pageService.onInit();
   const until=async test=>{const end=Date.now()+3000;while(!test()){if(Date.now()>end)throw Error('queue timeout');await new Promise(r=>setTimeout(r,20));}};
   await until(()=>pageService.progressSnapshot().done===2);
   check(calls===2,'legacy visible preference now checks all cards and deduplicates');
   check(scrollY===0,'no scrolling was required');
   check(pageService.progressSnapshot().total===2,'progress counts unique site/ID pairs');
   pageService.renderProgress();
   check(pageService.progressUI.bar.value===2 && pageService.progressUI.bar.max===2,'completed progress bar');
   State.proxy.portalCheckMode='page';
   const later=makeButton('4974975'); later.classList.add('btn-site-jump'); later.hidden=true;
   pageService.register(document);
   await until(()=>pageService.progressSnapshot().done===3);
   check(calls===3,'new and hidden mounted cards automatically join the queue');
   window.response={status:200,responseText:'unrecognized HTML'};
   const uncertain=makeButton('4974976'); uncertain.classList.add('btn-site-jump');
   pageService.register(document);
   await until(()=>pageService.progressSnapshot().done===4);
   check(pageService.progressSnapshot().sites.supjav.unknown===1,'unconfirmed is not counted as no result');
   // Expiring an unknown cache must not restart completed page tasks forever.
   Storage.set(pageService.key('supjav'),{entries:{},pausedUntil:0});
   pageService.tick();
   await new Promise(r=>setTimeout(r,30));
   check(calls===4,'completed page attempts survive shared-cache expiry');
   Storage.set(pageService.key('supjav'),{entries:{},pausedUntil:Date.now()+60000,lastReason:'rate-limited'});
   pageService.renderProgress();
   check(pageService.progressUI.retry.disabled,'retry is disabled during server cooldown');
   pageService.retryUnconfirmed();
   await new Promise(r=>setTimeout(r,20));
   check(calls===4,'retry does not bypass server cooldown');
   Storage.set(pageService.key('supjav'),{entries:{},pausedUntil:0});
   window.response={status:200,responseText:'<div class="no-results">No results</div>'};
   pageService.retryUnconfirmed();
   await until(()=>calls===5 && pageService.progressSnapshot().done===4);
   check(pageService.progressSnapshot().sites.supjav.unknown===0,'retry replaces only the unconfirmed attempt');
   check(pageService.progressSnapshot().sites.supjav.missing===4,'confirmed previous results are retained');
   const resumed=makeButton('4974977'); resumed.classList.add('btn-site-jump');
   pageService.register(document);
   clearTimeout(pageService.timer); pageService.timer=setTimeout(()=>{},3600000);
   window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
   await until(()=>calls===6 && pageService.progressSnapshot().done===5);
   check(calls===6,'pageshow resets a throttled pre-suspension scheduler timer');
   resumed.remove();

   offscreen.remove(); duplicate.remove();
   pageService.tick();
   check(pageService.progressSnapshot().total===3,'removed cards leave progress');
   State.proxy.portalCheckMode='off'; pageService.tick();
   check(pageService.progressHost.hidden,'disabled checks hide progress');
   pageService.onCleanup();
   check(!document.querySelector('#fc2-portal-progress'),'cleanup removes progress panel');
   State.proxy.portalCheckMode='page';
   // Hold Supjav open: MissAV must start and advance independently.
   localStorage.clear(); document.body.replaceChildren();
   const parallelService=new PortalAvailabilityService();
   const started=[]; const pending=[];
   parallelService.browserTransport.query=(site,id)=>new Promise(resolve=>{
     started.push(site+':'+id); pending.push({site,resolve});
   });
   for(const site of ['supjav','missav']) for(const id of ['4974973','4974974']) {
     const b=makeButton(id,site); b.classList.add('btn-site-jump');
   }
   parallelService.onInit();
   await until(()=>started.length===2);
   check(started.includes('supjav:4974973') && started.includes('missav:4974973'),'both sites start before either completes');
   pending.find(job=>job.site==='missav').resolve({result:'missing'});
   await until(()=>started.length===3);
   check(started[2]==='missav:4974974','MissAV advances while Supjav is still pending');
   check(started.filter(key=>key.startsWith('supjav:')).length===1,'same site remains single concurrency');
   parallelService.onCleanup();
   pending.forEach(job=>job.resolve({aborted:true}));
   return ['two-site parallel dispatch and independent progress while Supjav is held pending', 'exact-ID parsing and conservative misses' ,'challenge / 403 / 429 / Retry-After handling',
     'positive highlight, cached reuse, neutral unknown','external switch and off mode',
     'no fixed interval or hourly / daily budgets','hover mode, whole-page queue without scrolling, deduplication, dynamic cards and progress'];
  });
  // Two tabs share the actual browser Web Lock and persistent per-site budget.
  const second = await context.newPage();
  await second.goto('https://fc2cmadb.com/'); await second.addScriptTag({content:harness});
  await page.evaluate(()=>{localStorage.clear();window.delay=200;window.calls=0;});
  const firstRequest=page.evaluate(async()=>{const svc=new PortalAvailabilityService(); await svc.check(makeButton());});
  await page.waitForFunction(()=>window.calls===1);
  await second.evaluate(async()=>{const svc=new PortalAvailabilityService();await svc.check(makeButton());});
  assert.equal(await second.evaluate(()=>window.calls),0);
  await firstRequest;
  results.push('cross-tab Web Lock prevents duplicate concurrent requests');
  for(const result of results)console.log('PASS '+result);
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
