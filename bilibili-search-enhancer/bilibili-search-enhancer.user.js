// ==UserScript==
// @name         B站精准搜索 · 自动补页
// @namespace    local.bilibili.search.enhancer
// @version      0.3.0
// @description  原生卡片、原站主题；严格匹配、自动补页，显示加载进度。Firefox 兼容。
// @match        https://search.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
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
    let scope=setting('scope','all');
    let bypass=false, scheduled=false, disposed=false, lastSearchRequest=0;
    const pageWindow=typeof unsafeWindow==='undefined'?window:unsafeWindow;
    const unwrap=o=>o?.wrappedJSObject||o;
    const pageClone=value=>pageWindow.JSON.parse(JSON.stringify(value));
    const fingerprint=rows=>Array.from(rows||[],v=>String(v?.bvid||'')).join(',');
    const safeGet=(o,key)=>{try{return o?.[key];}catch{return undefined;}};
    const style=document.createElement('style');style.id='bse-style';
    style.textContent=`
    [data-bse-pager-hidden]{display:none!important}
    #bse-footer{padding:24px 8px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;min-height:76px;font:13px/1.6 inherit;color:var(--text3,#9499a0)}
    #bse-footer .bse-message:empty{display:none}#bse-footer .bse-message[data-error]{color:var(--stress_red,#f25d8e)}
    #bse-footer button{font:inherit;padding:7px 14px;border:1px solid var(--line_regular,#e3e5e7);border-radius:6px;background:var(--bg1,#fff);color:var(--text2,#61666d);cursor:pointer}
    #bse-footer button:hover{color:var(--brand_blue,#00aeec);border-color:var(--brand_blue,#00aeec)}
    #bse-footer button:disabled{opacity:.6;cursor:default}#bse-footer [hidden]{display:none!important}
    `;
    function element(tag,cls,text) {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
    function nativeList() {
        return document.querySelector('.video-list, .search-video-list')||document.querySelector('.bili-video-card')?.closest('.video-list-item, [class*="col_"]')?.parentElement||null;
    }
    function visibleIDs(native) {
        return new Set([...native.querySelectorAll('a[href*="/video/BV"]')].map(a=>a.href.match(/BV[a-zA-Z0-9]{10}/)?.[0]).filter(Boolean));
    }
    function findComponents(native) {
        const components=[],seen=new Set();
        const add=c=>{if(c&&!seen.has(c)){seen.add(c);components.push(c);}};
        // Development builds expose the nearest component; production builds keep
        // the renderer's root vnode even when Vue devtools are disabled.
        let node=unwrap(native);
        for(let i=0;node&&i<12;i++,node=node.parentElement){let c=safeGet(node,'__vueParentComponent');for(let n=0;c&&n<15;n++,c=c.parent)add(c);}
        const roots=[];
        for(const el of document.querySelectorAll('#i_cecream, #app, #__nuxt, [data-v-app]')) {
            const e=unwrap(el),app=safeGet(e,'__vue_app__');
            roots.push(safeGet(e,'_vnode'),safeGet(app?._container,'_vnode'));
        }
        const stack=roots.filter(Boolean),visited=new Set();let budget=3500;
        while(stack.length&&budget-->0){
            const vnode=stack.pop();if(!vnode||typeof vnode!=='object'||visited.has(vnode))continue;visited.add(vnode);
            const el=safeGet(vnode,'el');
            if(el?.nodeType===1&&el!==native&&!el.contains(native)&&!native.contains(el))continue;
            const c=safeGet(vnode,'component');if(c){add(c);stack.push(c.subTree);}
            if(Array.isArray(vnode.children))stack.push(...vnode.children);
            if(vnode.suspense?.activeBranch)stack.push(vnode.suspense.activeBranch);
        }
        return components;
    }
    function findAdapter(native) {
        const ids=visibleIDs(native);if(!ids.size)return null;
        const candidates=[];
        for(const component of findComponents(native)) {
            const visited=new Set();let budget=450;
            function walk(obj,depth,get,set) {
                if(!obj||typeof obj!=='object'||depth>5||budget--<=0||visited.has(obj))return;visited.add(obj);
                if(Array.isArray(obj)) {
                    if(obj.length>0&&obj.length<=2000) {
                        const videos=Array.from(obj).filter(v=>v&&/^BV[a-zA-Z0-9]{10}$/.test(v.bvid||'')&&typeof v.title==='string');
                        const overlap=videos.filter(v=>ids.has(v.bvid)).length;
                        // Require the API-shaped list actually represented by this DOM.
                        // Avoid video-card props, recommendation arrays, or transformed models.
                        const rawShape=videos.filter(v=>'duration' in v&&('tag' in v||'description' in v||'play' in v)).length;
                        const reactive=safeGet(obj,'__v_isReactive')===true&&!safeGet(obj,'__v_isReadonly');
                        if(overlap>=Math.min(2,ids.size)&&videos.length===obj.length&&rawShape===videos.length&&(reactive||set)) {
                            candidates.push({get,set,reactive,component,score:overlap*100+(reactive?10:0),original:Array.from(obj)});
                        }
                    }
                    // Search response category blocks, but never recurse through videos.
                    for(let i=0;i<Math.min(obj.length,12);i++){const v=obj[i];if(!v?.bvid)walk(v,depth+1,()=>obj[i],null);}
                    return;
                }
                if(obj.nodeType||obj instanceof Date||safeGet(obj,'__v_isVNode'))return;
                if(safeGet(obj,'__v_isRef')) {
                    walk(obj.value,depth+1,()=>obj.value,obj.__v_isReadonly?null:v=>{obj.value=v;});return;
                }
                let names;try{names=Object.keys(obj);}catch{return;}
                for(const key of names.slice(0,100)) {
                    if(key.startsWith('$')||key.startsWith('_')||['parent','root','vnode','subTree','appContext'].includes(key))continue;
                    const value=safeGet(obj,key);
                    const writable=!safeGet(obj,'__v_isReadonly');
                    walk(value,depth+1,()=>obj[key],writable?v=>{obj[key]=v;}:null);
                }
            }
            for(const root of [component.setupState,component.data,component.props])walk(root,0,()=>root,null);
        }
        candidates.sort((a,b)=>b.score-a.score);
        return candidates[0]||null;
    }
    function writeAdapter(adapter,rows) {
        const values=pageClone(rows),array=adapter.get();
        if(!Array.isArray(array))throw new Error('原生列表的数据结构已变化。');
        if(adapter.reactive)array.splice(0,array.length,...values);
        else if(adapter.set)adapter.set(values);
        else throw new Error('原生列表无法更新。');
        const actual=adapter.get();
        if(fingerprint(actual)!==fingerprint(rows))throw new Error('原生列表拒绝更新，已保留原结果。');
        adapter.last=fingerprint(rows);adapter.lastArray=actual;
    }
    function restoreAdapter(adapter) {
        if(!adapter)return;
        // Do not overwrite a newer search response supplied by Bilibili.
        try{if(adapter.get()===adapter.lastArray&&fingerprint(adapter.get())===adapter.last)writeAdapter(adapter,adapter.original);}catch{}
    }
    function restorePagination() {document.querySelectorAll('[data-bse-pager-hidden]').forEach(e=>e.removeAttribute('data-bse-pager-hidden'));}
    function current(s) {return state===s&&!disposed&&!bypass&&readConfig(location.href)?.key===s.config.key;}
    function setStatus(s,message,error=false) {
        if(!current(s))return;s.message.textContent=message;s.message.toggleAttribute('data-error',error);
        s.footer.title=`已扫描 ${s.scannedPages} 页 / ${s.scanned} 条，去重后 ${s.seen.size} 条，匹配 ${s.records.length} 条`;
    }
    function progress(s) {
        if(!s.busy||!current(s))return;
        const elapsed=Math.floor((Date.now()-s.roundStart)/1000);
        setStatus(s,`正在查找：本轮已检查 ${s.roundPages}/10 页，新增 ${s.records.length-s.roundBase}/${s.roundGoal} 条 · ${elapsed}秒`);
    }
    function buttons(s) {
        if(!current(s))return;
        s.more.disabled=s.busy||!s.adapter;s.more.hidden=s.done||!s.adapter;
        s.more.textContent=s.busy?'正在加载…':s.error?'重试':s.auto?'加载更多':'继续查找';
        s.stop.hidden=!s.busy;s.original.hidden=!s.error;
    }
    function nativeFailure(s,error) {
        s.controller?.abort();s.auto=false;s.error=true;s.failed=true;
        restoreAdapter(s.adapter);s.adapter=null;restorePagination();
        setStatus(s,`未能接入原生卡片，已保留原结果。${error?.message||'当前页面的列表结构暂不支持。'}`,true);buttons(s);
    }
    async function renderNative(s) {
        if(!current(s)||!s.adapter)return;
        try {
            const adapter=s.adapter;
            writeAdapter(adapter,s.records);
            const written=adapter.lastArray,writtenFingerprint=adapter.last;
            // Let Vue render its own components; this script never builds video cards.
            await delay(80,s.controller?.signal||new AbortController().signal);
            if(!current(s))return;
            // A native request can replace the list during this render tick. Rebind
            // it instead of treating that ordinary race as an incompatible component.
            if(s.adapter!==adapter||adapter.get()!==written||fingerprint(adapter.get())!==writtenFingerprint){schedule();return;}
            const native=nativeList();
            const rendered=native?visibleIDs(native):new Set();
            const sample=[...s.records.slice(0,3),...s.records.slice(-3)];
            const expected=new Set(s.records.map(v=>v.bvid));
            if(sample.some(v=>!rendered.has(v.bvid))||[...rendered].some(id=>!expected.has(id)))throw new Error('列表数据已更新，但原生组件未渲染预期的视频。');
        } catch(e) {if(e.name!=='AbortError'){nativeFailure(s,e);throw e;}}
    }
    async function fill(s) {
        if(!current(s)||s.busy||s.done||!s.adapter)return;
        s.busy=true;s.error=false;s.auto=false;s.controller=new AbortController();
        const signal=s.controller.signal;
        s.roundBase=s.records.length;s.roundStart=Date.now();s.roundPages=0;
        const target=s.firstRound?Math.max(20,s.records.length):s.records.length+20;s.firstRound=false;s.roundGoal=target-s.roundBase;
        buttons(s);progress(s);const tick=setInterval(()=>progress(s),500);
        try {
            while(s.records.length<target&&s.roundPages<10&&!s.done) {
                await delay(Math.max(0,1200-(Date.now()-lastSearchRequest)),signal);lastSearchRequest=Date.now();
                const data=await fetchPage(s,signal);
                if(signal.aborted||!current(s))return;
                s.roundPages++;s.scannedPages++;s.scanned+=data.result.length;
                let fresh=0,added=0;
                for(const raw of data.result){const v=normalizeVideo(raw);if(!v||s.seen.has(v.bvid))continue;s.seen.add(v.bvid);fresh++;if(matches(v,s.required,[],scope)){s.records.push(raw);added++;}}
                if(added)await renderNative(s);
                if(signal.aborted||!current(s))return;
                s.page++;
                const total=Number(data.numPages);s.done=data.result.length===0||(Number.isFinite(total)&&total>0&&s.page>total);
                s.repeated=fresh===0&&data.result.length>0?s.repeated+1:0;
                if(s.repeated>=3&&!s.done){setStatus(s,'已暂停：连续3页没有新视频。点“继续查找”可再往后找。');return;}
            }
            s.auto=!s.done&&s.records.length>=target;
            setStatus(s,s.done?(s.records.length?'没有更多相关视频了':'没有找到符合全部关键词的视频。可尝试用空格分开关键词。'):s.auto?'向下滚动自动加载更多':`已暂停：本轮检查了10页，新增 ${s.records.length-s.roundBase} 条。点“继续查找”可再往后找。`);
        } catch(e) {
            if(s.failed)return;
            if(e.name==='AbortError')setStatus(s,'已暂停：你暂停了本轮查找。');
            else {s.error=true;setStatus(s,`已暂停：${e.message}`,true);}
        } finally {clearInterval(tick);s.busy=false;buttons(s);}
    }
    function disposeState() {
        if(!state)return;const s=state;state=null;s.controller?.abort();s.observer?.disconnect();s.footer.remove();restoreAdapter(s.adapter);restorePagination();
    }
    function createState(config,native) {
        const s={config,native,required:terms(config.params.keyword),page:config.page,scannedPages:0,scanned:0,records:[],seen:new Set(),busy:false,done:false,error:false,auto:false,repeated:0,firstRound:true,created:Date.now()};
        s.footer=element('div');s.footer.id='bse-footer';
        s.message=element('span','bse-message','正在连接原生视频列表…');s.message.setAttribute('role','status');s.message.setAttribute('aria-live','polite');
        s.more=element('button','','继续查找');s.more.type='button';s.more.hidden=true;s.more.onclick=()=>fill(s);
        s.stop=element('button','','暂停');s.stop.type='button';s.stop.hidden=true;s.stop.onclick=()=>{s.auto=false;s.controller?.abort();};
        s.original=element('button','','查看原始结果');s.original.type='button';s.original.hidden=true;s.original.onclick=()=>{bypass=true;disposeState();};
        s.footer.append(s.message,s.more,s.stop,s.original);
        s.observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&s.auto)fill(s);},{rootMargin:'0px 0px 250px 0px'});s.observer.observe(s.footer);
        return s;
    }
    function hidePagination(native) {
        const area=native.closest('.search-content, .search-page, .search-all-list')||native.parentElement;
        area?.querySelectorAll('.vui_pagenation, .vui_pagination, .pagination, .pagination-container, .paging-box').forEach(e=>{
            if(!e.contains(state.footer))e.setAttribute('data-bse-pager-hidden','');
        });
    }
    async function attachAdapter(s,adapter) {
        s.adapter=adapter;
        // Show matching native first-page cards immediately, while checking later pages.
        for(const raw of adapter.original){const v=normalizeVideo(raw);if(v&&!s.seen.has(v.bvid)){s.seen.add(v.bvid);if(matches(v,s.required,[],scope))s.records.push(raw);}}
        try {await renderNative(s);if(current(s)&&s.adapter){hidePagination(s.native);fill(s);}}catch{}
    }
    function reconcile() {
        scheduled=false;if(disposed||!document.documentElement)return;
        if(!style.isConnected)document.documentElement.append(style);
        const config=readConfig(location.href);if(!config){disposeState();return;}
        if(state&&state.config.key!==config.key)disposeState();if(bypass)return;
        const native=nativeList();if(!native||!native.parentElement)return;
        if(!state)state=createState(config,native);
        const s=state;s.native=native;
        if(s.footer.parentElement!==native.parentElement||native.nextElementSibling!==s.footer)native.after(s.footer);
        if(s.failed)return;
        if(!s.adapter) {
            const adapter=findAdapter(native);
            if(adapter){attachAdapter(s,adapter);return;}
            if(Date.now()-s.created>8000)nativeFailure(s);
        } else {
            try {
                if(s.adapter.get()!==s.adapter.lastArray||fingerprint(s.adapter.get())!==s.adapter.last) {
                    // Native sorting/hydration replaced the source: bind only a verified live list.
                    const adapter=findAdapter(native);
                    if(adapter){s.adapter=adapter;renderNative(s).catch(()=>{});}
                }
                hidePagination(native);
            } catch(e) {nativeFailure(s,e);}
        }
    }
    function schedule() {if(scheduled||disposed)return;scheduled=true;setTimeout(reconcile,100);}
    const domObserver=new MutationObserver(records=>{
        if(records.some(r=>r.target!==style&&!r.target.closest?.('#bse-footer')&&[...r.addedNodes,...r.removedNodes].some(n=>n!==state?.footer&&n!==style)))schedule();
    });
    function init() {if(!document.documentElement){setTimeout(init,10);return;}domObserver.observe(document.documentElement,{childList:true,subtree:true});reconcile();}
    let previousKey=readConfig(location.href)?.key,beats=0;
    const timer=setInterval(()=>{
        const key=readConfig(location.href)?.key;
        if(key!==previousKey){previousKey=key;bypass=false;disposeState();schedule();}
        else if(++beats%5===0&&state&&!state.adapter&&!state.failed)schedule();
    },200);
    let scrollPending=false;
    addEventListener('scroll',()=>{if(scrollPending)return;scrollPending=true;requestAnimationFrame(()=>{scrollPending=false;const s=state;if(s?.auto&&s.footer.isConnected&&s.footer.getBoundingClientRect().top<innerHeight+250)fill(s);});},{passive:true});
    if(typeof GM_registerMenuCommand==='function') {
        GM_registerMenuCommand('切换匹配范围：标题 / 标题+简介+标签',()=>{scope=scope==='title'?'all':'title';if(typeof GM_setValue==='function')GM_setValue('scope',scope);disposeState();bypass=false;schedule();});
        GM_registerMenuCommand('恢复原始搜索 / 重新启用过滤',()=>{bypass=!bypass;disposeState();schedule();});
    }
    addEventListener('pagehide',event=>{if(event.persisted){state?.controller?.abort();if(state)state.auto=false;return;}disposed=true;clearInterval(timer);domObserver.disconnect();disposeState();});
    init();
})();
