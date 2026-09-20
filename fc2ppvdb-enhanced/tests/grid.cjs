const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const read = version => fs.readFileSync(path.join(__dirname, version === "2.1.9" ? "fixtures/fc2ppvdb-enhanced-2.1.9.user.js" : "../fc2ppvdb-enhanced.user.js"), 'utf8');
const gridCode = source => `const Config={CLASSES:{cardRebuilt:'card-rebuilt'}};\n${source.slice(source.indexOf('  const ENH_GRID_CONTAINER_ATTR ='), source.indexOf('  class GridService {'))}\nObject.assign(window,{markGridContainer,buildGridCss});`;
const fixture = `<style>
:root{--fc2-space-md:16px;--fc2-space-sm:8px;--fc2-btn-pad-xs:4px;--fc2-layout-grid-card-min-width:220px}
body{margin:0}main{width:1160px;max-width:100%;margin:auto}.flex{display:flex}.flex-wrap{flex-wrap:wrap}
.result-heading{width:410px;max-width:100%;height:30px}.card-rebuilt{container-type:inline-size;width:25%;min-width:0;height:180px;box-sizing:border-box}.processed-card{width:100%}
</style><main><form style="width:260px">Search</form><div class="flex flex-wrap justify-start px-4" id="outer"><div class="bg-base-100 mb-4 pb-2 shadow-md" id="section"><div class="result-heading">Results</div><div class="flex flex-wrap bg-base-100 p-2" id="results">${Array.from({length:8},()=>'<div class="card-rebuilt"><div class="processed-card">Card</div></div>').join('')}</div></div></div></main>`;
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1181,height:900}});
  await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:fixture}));
  const measure=()=>page.evaluate(()=>({section:document.querySelector('#section').getBoundingClientRect().width, outer:document.querySelector('#outer').getBoundingClientRect().width, columns:getComputedStyle(document.querySelector('#results')).gridTemplateColumns.split(' ').length, form:document.querySelector('form').getBoundingClientRect().width}));
  const apply=async(version,pathname='/search?keyword=fixture')=>{
   await page.goto('https://fc2cmadb.com'+pathname); await page.addScriptTag({content:gridCode(read(version))});
   await page.evaluate(()=>{
    markGridContainer(document.querySelector('#results'));
    const style=document.createElement('style');style.textContent=buildGridCss(location.hostname,location.pathname,4);document.head.append(style);
   });
  };
  await apply('2.1.9'); const before=await measure();
  assert.equal(before.columns,1,'fixture reproduces the old shrink-to-one-column bug');
  await apply('2.1.10'); const after=await measure();
  assert.equal(after.section,after.outer,'search result section fills the available width');
  assert.ok(after.columns>=3,'desktop results occupy multiple columns');
  assert.equal(after.form,260,'search form layout remains unchanged');
  await page.setViewportSize({width:390,height:844}); const mobile=await measure();
  assert.equal(mobile.columns,1,'narrow phone viewport remains a single responsive column');
  assert.ok(mobile.section<=390,'results do not overflow the phone viewport');
  await apply('2.1.10','/writers/fixture');
  assert.equal(await page.locator('[data-enh-grid-section]').count(),0,'other pages are not given search-section overrides');
  assert.equal(await page.evaluate(()=>buildGridCss('fc2cmadb.com','/search',0)),'','native grid preference remains unchanged');
  console.log('PASS search-layout reproduction and fix',JSON.stringify({before,after,mobile}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
