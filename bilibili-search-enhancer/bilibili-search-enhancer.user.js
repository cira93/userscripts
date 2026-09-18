// ==UserScript==
// @name         B站精准搜索 · 自动补页
// @namespace    local.bilibili.search.enhancer
// @version      0.2.0
// @description  融入原搜索页，默认深色；严格匹配、自动补页、连续加载。Firefox 兼容。
// @match        https://search.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.bilibili.com
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';
    // No remote dependencies. GM requests use the browser's existing Bilibili session.
    function md5(text) {
        const bytes = new TextEncoder().encode(text);
        const size = Math.ceil((bytes.length + 9) / 64) * 64;
        const buf = new Uint8Array(size); buf.set(bytes); buf[bytes.length] = 128;
        const view = new DataView(buf.buffer);
        view.setUint32(size - 8, (bytes.length * 8) >>> 0, true);
        view.setUint32(size - 4, Math.floor(bytes.length / 536870912), true);
        const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
        const constants = Array.from({length:64}, (_,i) => Math.floor(Math.abs(Math.sin(i+1))*4294967296) | 0);
        let a0=0x67452301, b0=0xefcdab89|0, c0=0x98badcfe|0, d0=0x10325476;
        for (let offset=0; offset<size; offset+=64) {
            let a=a0,b=b0,c=c0,d=d0;
            for (let i=0;i<64;i++) {
                let f,g;
                if(i<16){f=(b&c)|(~b&d);g=i;}
                else if(i<32){f=(d&b)|(~d&c);g=(5*i+1)%16;}
                else if(i<48){f=b^c^d;g=(3*i+5)%16;}
                else{f=c^(b|~d);g=(7*i)%16;}
                const x=(a+f+constants[i]+view.getInt32(offset+g*4,true))|0;
                const s=shifts[Math.floor(i/16)*4+i%4];
                a=d;d=c;c=b;b=(b+((x<<s)|(x>>>(32-s))))|0;
            }
            a0=(a0+a)|0;b0=(b0+b)|0;c0=(c0+c)|0;d0=(d0+d)|0;
        }
        return [a0,b0,c0,d0].map(n=>[0,8,16,24].map(s=>((n>>>s)&255).toString(16).padStart(2,'0')).join('')).join('');
    }
    const permutation=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
    function sign(params, rawKey, timestamp=Math.floor(Date.now()/1000)) {
        const key=permutation.map(i=>rawKey[i]).join('').slice(0,32);
        const p={...params,wts:timestamp};
        const query=Object.keys(p).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(String(p[k]).replace(/[!'()*]/g,''))).join('&');
        return query+'&w_rid='+md5(query+key);
    }
    function normalize(s) { return String(s ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim(); }
    function terms(s) { return [...new Set(normalize(s).split(/\s+/).filter(Boolean))]; }
    function clean(s) {
        const el=document.createElement('textarea');
        el.innerHTML=String(s ?? '').replace(/<[^>]*>/g,'');
        return el.value;
    }
    function matches(video, required, excluded, scope) {
        const fields=scope==='title' ? [video.title] : [video.title,video.description,video.tags];
        const texts=fields.map(normalize);
        return required.every(t=>texts.some(f=>f.includes(t))) && !excluded.some(t=>texts.some(f=>f.includes(t)));
    }
    function normalizeVideo(v) {
        if(!/^BV[a-zA-Z0-9]{10}$/.test(v.bvid || '') || v.is_ad_loc || v.is_promoted || v.type==='ad') return null;
        const tags=Array.isArray(v.tag) ? v.tag.join(' ') : (v.tag || v.tags || '');
        return {bvid:v.bvid,title:clean(v.title),description:clean(v.description),tags:clean(tags),author:clean(v.author),mid:String(v.mid||''),danmaku:v.video_review,pic:String(v.pic||''),play:v.play,duration:v.duration,pubdate:v.pubdate};
    }
    // Expose only pure helpers to Node's isolated test VM; never defined by this userscript in a browser.
    if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
        module.exports={md5,sign,normalize,terms,matches,readConfig}; return;
    }


    let state=null, keys=null, keyTime=0;
    function request(url, signal) {
        return new Promise((resolve,reject)=>{
            if(signal.aborted) return reject(new DOMException('Aborted','AbortError'));
            let settled=false, handle;
            const finish=(fn,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);fn(value);};
            const abort=()=>{handle?.abort();finish(reject,new DOMException('Aborted','AbortError'));};
            handle=GM_xmlhttpRequest({method:'GET',url,timeout:20000,anonymous:false,
                onload:r=>{try{if(r.status!==200)throw new Error('HTTP '+r.status+'：请求被拦截或服务暂不可用。');finish(resolve,JSON.parse(r.responseText));}catch(e){finish(reject,e);}},
                onerror:()=>finish(reject,new Error('网络请求失败，请检查网络以及篡改猴对 api.bilibili.com 的访问权限。')),
                ontimeout:()=>finish(reject,new Error('请求超时，请稍后继续。')),
                onabort:()=>finish(reject,new DOMException('Aborted','AbortError'))});
            signal.addEventListener('abort',abort,{once:true});
        });
    }
    function delay(ms,signal) {
        return new Promise((resolve,reject)=>{
            if(signal.aborted)return reject(new DOMException('Aborted','AbortError'));
            const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};
            const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
            signal.addEventListener('abort',abort,{once:true});
        });
    }
    async function getKeys(signal) {
        if(keys && Date.now()-keyTime<3600000)return keys;
        const r=await request('https://api.bilibili.com/x/web-interface/nav',signal);
        const w=r.data?.wbi_img;
        const extract=u=>String(u||'').match(/\/([a-f\d]{32})\./i)?.[1];
        const a=extract(w?.img_url),b=extract(w?.sub_url);
        if(!a||!b)throw new Error('无法获取搜索签名。请先正常打开一次 B站首页，再回来重试。');
        keys=a+b;keyTime=Date.now();return keys;
    }
    async function fetchPage(s,signal) {
        const rawKey=await getKeys(signal);
        const query=sign({...s.config.params,search_type:'video',page:s.page,page_size:20},rawKey);
        const r=await request('https://api.bilibili.com/x/web-interface/wbi/search/type?'+query,signal);
        if(r.code!==0 || r.data?.v_voucher){keys=null;throw new Error(`B站接口 ${r.code}：${r.data?.v_voucher?'需要验证':r.message||'请求失败'}。请在原网页完成验证或稍后重试；已找到的结果会保留。`);}
        if(!r.data || !Array.isArray(r.data.result))throw new Error('接口未返回预期的视频列表，已停止，避免把错误当成没有结果。');
        return r.data;
    }
    // Read the existing site's URL instead of adding another search form.
    function readConfig(href) {
        const url=new URL(href);
        const pathname=url.pathname.replace(/\/$/,'')||'/';
        const keyword=(url.searchParams.get('keyword')||'').trim();
        if(!['/','/all','/video'].includes(pathname)||!keyword)return null;
        const params={keyword,order:'totalrank',duration:'0',tids:'0'};
        for(const key of ['order','duration','tids','tids_1','tids_2','pubtime_begin_s','pubtime_end_s','video_type','order_sort']) {
            const value=url.searchParams.get(key);if(value!==null)params[key]=value;
        }
        // Some versions of the native page use the second-level category as tids.
        if(!url.searchParams.has('tids'))params.tids=params.tids_2&&params.tids_2!=='0'?params.tids_2:(params.tids_1||'0');
        const page=Math.max(1,Math.min(1000,parseInt(url.searchParams.get('page'),10)||1));
        return {params,page,key:JSON.stringify([pathname,params,page])};
    }
    const setting=(key,fallback)=>typeof GM_getValue==='function'?GM_getValue(key,fallback):fallback;
    let dark=setting('dark',true), scope=setting('scope','all');
    let bypass=false, scheduled=false, disposed=false;
    let lastSearchRequest=0;
    const style=document.createElement('style');style.id='bse-style';
    style.textContent=`
    html[data-bse-dark],html[data-bse-dark] body{color-scheme:dark;background:#18191c!important;color:#e3e5e7!important}
    html[data-bse-dark]{--bg1:#18191c!important;--bg2:#232529!important;--bg3:#2b2d31!important;--bg1_float:#232529!important;--bg2_float:#2b2d31!important;--text1:#e3e5e7!important;--text2:#b2b5ba!important;--text3:#8c9098!important;--text4:#676b73!important;--line_light:#303238!important;--line_regular:#3a3c43!important;--graph_bg_thin:#232529!important;--graph_bg_regular:#2b2d31!important;--graph_weak:#3a3c43!important;--Ga0:#18191c!important;--Ga1:#232529!important;--Ga2:#303238!important;--Ga7:#b2b5ba!important;--Ga10:#e3e5e7!important}
    html[data-bse-dark] :is(.bili-header__bar,.search-header,.search-wrap,.search-container,.search-content,.search-all-list,.search-page,.search-panel,.search-input-wrap,.vui_popover__content){background-color:#18191c!important;color:#e3e5e7}
    html[data-bse-dark] :is(.nav-search-content,.nav-search-input,.search-input-el){background-color:transparent!important;color:#e3e5e7!important}
    html[data-bse-dark] :is(.nav-search,.nav-searchform,.search-input){background-color:#282a2f!important;border-color:#393c43!important}
    html[data-bse-dark] :is(.bili-video-card__info--tit,.bili-video-card__info--author,.vui_button){color:var(--text1)!important}
    html[data-bse-dark] :is(.vui_button,.vui_pagenation--btn){background-color:#232529!important;border-color:#393c43!important}
    [data-bse-native-hidden]{display:none!important}
    #bse-results{width:100%;color:var(--text1,#18191c);font-family:inherit;box-sizing:border-box}
    #bse-results *{box-sizing:border-box}
    #bse-results .bse-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:28px 16px}
    #bse-results .bse-card{min-width:0;background:transparent}
    #bse-results a{text-decoration:none;color:inherit}
    #bse-results .bse-cover{display:block;position:relative;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:var(--bg2,#f1f2f3)}
    #bse-results .bse-cover img{display:block;width:100%;height:100%;object-fit:cover;transition:transform .2s}
    #bse-results .bse-cover:hover img{transform:scale(1.025)}
    #bse-results .bse-stats{position:absolute;inset:auto 0 0;padding:20px 8px 6px;display:flex;gap:12px;align-items:center;background:linear-gradient(transparent,#0009);color:#fff;font-size:12px;line-height:18px;pointer-events:none}
    #bse-results .bse-duration{margin-left:auto}
    #bse-results .bse-title{font-size:15px;font-weight:500;line-height:22px;height:44px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:10px 0 4px;overflow-wrap:anywhere}
    #bse-results .bse-title a:hover,#bse-results .bse-author:hover{color:#00aeec}
    #bse-results em{font-style:normal;color:#f25d8e}
    #bse-results .bse-meta{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text3,#9499a0);line-height:20px}
    #bse-results .bse-author{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#bse-results .bse-date{white-space:nowrap}
    #bse-results .bse-footer{padding:30px 8px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;min-height:86px;font-size:13px;color:var(--text3,#9499a0)}
    #bse-results .bse-message:empty{display:none}#bse-results .bse-message[data-error]{color:#f08080}
    #bse-results button{font:inherit;padding:7px 16px;border:1px solid var(--line_regular,#e3e5e7);border-radius:6px;background:var(--bg1,#fff);color:var(--text2,#61666d);cursor:pointer}
    #bse-results button:hover{color:#00aeec;border-color:#00aeec}#bse-results button:disabled{opacity:.6;cursor:default}
    #bse-results [hidden]{display:none!important}
    @media(min-width:1700px){#bse-results .bse-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}
    @media(max-width:1200px){#bse-results .bse-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
    @media(max-width:900px){#bse-results .bse-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:600px){#bse-results .bse-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 10px}#bse-results .bse-title{font-size:14px}}
    `;
    function applyTheme() {document.documentElement?.toggleAttribute('data-bse-dark',dark);}
    function element(tag,cls,text) {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
    function restoreNative() {document.querySelectorAll('[data-bse-native-hidden]').forEach(e=>e.removeAttribute('data-bse-native-hidden'));}
    function current(s) {return state===s&&!disposed&&!bypass&&readConfig(location.href)?.key===s.config.key;}
    function setStatus(s,message,error=false) {
        if(!current(s))return;
        s.message.textContent=message;s.message.toggleAttribute('data-error',error);
        s.footer.title=`已扫描 ${s.scannedPages} 页 / ${s.scanned} 条，去重后 ${s.seen.size} 条，匹配 ${s.count} 条`;
    }
    function buttons(s) {
        if(!current(s))return;
        s.more.disabled=s.busy;s.more.hidden=s.done;
        s.more.textContent=s.busy?'正在加载…':s.error?'重试':'加载更多';
        s.stop.hidden=!s.busy;s.original.hidden=!s.error;
    }
    function formatCount(value) {const n=Number(value);return Number.isFinite(n)?n>=10000?(n/10000).toFixed(1)+'万':String(n):'—';}
    function highlight(node,text,required) {
        // Highlight literal matches without inserting API-provided HTML into the page.
        const escaped=required.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).sort((a,b)=>b.length-a.length);
        if(!escaped.length){node.textContent=text;return;}
        const regex=new RegExp(escaped.join('|'),'giu');let from=0;
        for(const m of text.matchAll(regex)){node.append(document.createTextNode(text.slice(from,m.index)),element('em','',m[0]));from=m.index+m[0].length;}
        node.append(document.createTextNode(text.slice(from)));
    }
    function addCard(v,s) {
        const card=element('article','bse-card');card.dataset.bvid=v.bvid;
        const link='https://www.bilibili.com/video/'+v.bvid;
        const cover=element('a','bse-cover');cover.href=link;cover.target='_blank';cover.rel='noopener noreferrer';cover.setAttribute('aria-label',v.title);
        try {const url=new URL(v.pic.startsWith('//')?'https:'+v.pic:v.pic);if(url.protocol==='https:'&&/(^|\.)hdslb\.com$/.test(url.hostname)){const img=element('img');img.src=url.href;img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer';cover.append(img);}}catch{}
        const stats=element('div','bse-stats');
        stats.append(element('span','',`▷ ${formatCount(v.play)}`),element('span','',`弹 ${formatCount(v.danmaku)}`),element('span','bse-duration',String(v.duration||'')));cover.append(stats);
        const title=element('h3','bse-title');const a=element('a');a.href=link;a.target='_blank';a.rel='noopener noreferrer';a.title=v.title;highlight(a,v.title,s.required);title.append(a);
        const meta=element('div','bse-meta');const author=element(/^\d+$/.test(v.mid)?'a':'span','bse-author',`UP ${v.author}`);
        if(author.tagName==='A'){author.href='https://space.bilibili.com/'+v.mid;author.target='_blank';author.rel='noopener noreferrer';}
        meta.append(author);
        if(Number(v.pubdate)>0){const d=new Date(v.pubdate*1000);meta.append(element('span','bse-date',`· ${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`));}
        card.append(cover,title,meta);s.grid.append(card);
    }
    async function fill(s) {
        if(!current(s)||s.busy||s.done)return;
        s.busy=true;s.error=false;s.auto=false;s.controller=new AbortController();
        const signal=s.controller.signal;buttons(s);
        const target=s.count+20;let rounds=0;
        try {
            while(s.count<target&&rounds<10&&!s.done) {
                setStatus(s,s.count?'':'正在查找相关视频…');
                await delay(Math.max(0,1200-(Date.now()-lastSearchRequest)),signal);
                lastSearchRequest=Date.now();
                const data=await fetchPage(s,signal);
                if(signal.aborted||!current(s))return;
                rounds++;s.scannedPages++;s.scanned+=data.result.length;
                let newVideos=0;
                for(const raw of data.result){const v=normalizeVideo(raw);if(!v||s.seen.has(v.bvid))continue;s.seen.add(v.bvid);newVideos++;if(matches(v,s.required,[],scope)){addCard(v,s);s.count++;}}
                s.page++;
                const totalPages=Number(data.numPages);
                s.done=data.result.length===0||(Number.isFinite(totalPages)&&totalPages>0&&s.page>totalPages);
                s.repeated=newVideos===0&&data.result.length>0?s.repeated+1:0;
                if(s.repeated>=3&&!s.done){setStatus(s,'后续结果重复，可继续查找。');return;}
            }
            s.auto=!s.done&&s.count>=target;
            setStatus(s,s.done?(s.count?'没有更多相关视频了':'没有找到符合全部关键词的视频。试试用空格分开关键词。'):s.count>=target?'':'本轮匹配较少，可继续查找。');
        } catch(e) {
            if(e.name==='AbortError')setStatus(s,'已暂停');
            else {s.error=true;setStatus(s,e.message,true);}
        } finally {s.busy=false;buttons(s);}
    }
    function disposeState() {
        if(!state)return;
        state.controller?.abort();state.observer?.disconnect();state.root.remove();state=null;restoreNative();
    }
    function createState(config) {
        const s={config,required:terms(config.params.keyword),page:config.page,scannedPages:0,scanned:0,count:0,seen:new Set(),busy:false,done:false,error:false,auto:false,repeated:0,started:false};
        s.root=element('section');s.root.id='bse-results';s.root.setAttribute('aria-label','视频搜索结果');
        s.grid=element('div','bse-grid');s.footer=element('div','bse-footer');
        s.message=element('span','bse-message');s.message.setAttribute('role','status');s.message.setAttribute('aria-live','polite');
        s.more=element('button','','加载更多');s.more.type='button';s.more.onclick=()=>fill(s);
        s.stop=element('button','','暂停');s.stop.type='button';s.stop.hidden=true;s.stop.onclick=()=>{s.auto=false;s.controller?.abort();};
        s.original=element('button','','查看原始结果');s.original.type='button';s.original.hidden=true;s.original.onclick=()=>{bypass=true;disposeState();};
        s.footer.append(s.message,s.more,s.stop,s.original);s.root.append(s.grid,s.footer);
        s.observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&s.auto)fill(s);},{rootMargin:'0px 0px 250px 0px'});
        s.observer.observe(s.footer);
        return s;
    }
    function nativeList() {
        // Restrict to video lists. User, live and bangumi modules are left to Bilibili.
        const lists=[...document.querySelectorAll('.video-list, .search-video-list')].filter(e=>!e.closest('#bse-results'));
        const list=lists.find(e=>e.querySelector('.bili-video-card, a[href*="/video/BV"]'))||lists[0];
        if(list)return list;
        const card=document.querySelector('.bili-video-card:not(#bse-results *)');
        return card?.closest('.video-list-item, [class*="col_"]')?.parentElement||null;
    }
    function hideNativePagination(native) {
        const area=native.closest('.search-content, .search-page, .search-all-list')||native.parentElement;
        area?.querySelectorAll('.vui_pagenation, .vui_pagination, .pagination, .pagination-container, .paging-box').forEach(e=>{
            if(!e.contains(state.root)&&!e.closest('#bse-results'))e.setAttribute('data-bse-native-hidden','');
        });
    }
    function reconcile() {
        scheduled=false;if(disposed)return;
        if(!document.documentElement)return;
        if(!style.isConnected)document.documentElement.append(style);
        applyTheme();
        const config=readConfig(location.href);
        if(!config){disposeState();return;}
        if(state&&state.config.key!==config.key)disposeState();
        if(bypass)return;
        const native=nativeList();if(!native||!native.parentElement)return;
        if(!state)state=createState(config);
        const s=state;
        if(s.native!==native){if(s.native)s.native.removeAttribute('data-bse-native-hidden');s.native=native;}
        if(s.root.parentElement!==native.parentElement||s.root.nextElementSibling!==native)native.before(s.root);
        native.setAttribute('data-bse-native-hidden','');hideNativePagination(native);
        if(!s.started){s.started=true;fill(s);}
    }
    function schedule() {if(scheduled||disposed)return;scheduled=true;setTimeout(reconcile,50);}
    const domObserver=new MutationObserver(records=>{
        // Ignore our own cards/status text, so adding results doesn't trigger a scan loop.
        if(records.some(r=>r.target!==style&&!r.target.closest?.('#bse-results')&&[...r.addedNodes,...r.removedNodes].some(n=>n!==state?.root&&n!==style)))schedule();
    });
    function init() {if(!document.documentElement){setTimeout(init,10);return;}applyTheme();domObserver.observe(document.documentElement,{childList:true,subtree:true});reconcile();}
    let previousKey=readConfig(location.href)?.key;
    const timer=setInterval(()=>{const key=readConfig(location.href)?.key;if(key!==previousKey){previousKey=key;bypass=false;disposeState();schedule();}},200);
    let scrollPending=false;
    addEventListener('scroll',()=>{if(scrollPending)return;scrollPending=true;requestAnimationFrame(()=>{scrollPending=false;const s=state;if(s?.auto&&s.footer.isConnected&&s.footer.getBoundingClientRect().top<innerHeight+250)fill(s);});},{passive:true});
    if(typeof GM_registerMenuCommand==='function') {
        GM_registerMenuCommand('切换深色 / 浅色',()=>{dark=!dark;if(typeof GM_setValue==='function')GM_setValue('dark',dark);applyTheme();});
        GM_registerMenuCommand('切换匹配范围：标题 / 标题+简介+标签',()=>{scope=scope==='title'?'all':'title';if(typeof GM_setValue==='function')GM_setValue('scope',scope);disposeState();bypass=false;schedule();});
        GM_registerMenuCommand('恢复原始搜索 / 重新启用过滤',()=>{bypass=!bypass;disposeState();schedule();});
    }
    addEventListener('pagehide',event=>{if(event.persisted){state?.controller?.abort();if(state)state.auto=false;return;}disposed=true;clearInterval(timer);domObserver.disconnect();disposeState();});
    init();
})();
