// 不初·发货管家 云端版 server.js
// 双模式：有 SUPABASE_URL + SUPABASE_ANON_KEY 走云端；否则走本地 ./data/*.json（可双击测试）
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

/* ---------- 读 .env.local（让本地启动也能连云端） ---------- */
function loadEnvLocal(){
  try{
    const p = path.join(ROOT,'.env.local');
    if(!fs.existsSync(p)) return;
    fs.readFileSync(p,'utf8').split(/\r?\n/).forEach(l=>{
      const m=l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if(m && process.env[m[1]]===undefined) process.env[m[1]]=m[2];
    });
  }catch(e){}
}
loadEnvLocal();

/* ---------- Supabase（可选） ---------- */
let sb=null;
if(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY){
  try{ const {createClient}=require('@supabase/supabase-js');
    sb=createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global:{fetch:(u,o)=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),30000);
        return fetch(u,{...o,signal:c.signal}).finally(()=>clearTimeout(t));}}
    });
  }catch(e){ console.error('supabase load fail', e.message); }
}
const USE_SUPABASE=!!sb;
console.log('[模式]', USE_SUPABASE?'Supabase云端':'本地文件 ./data');

const SHIP_ORDERS='ship_orders', SHIP_PRODUCTS='ship_products',
      SHIP_LOGS='ship_stock_logs', SHIP_SETTINGS='ship_settings',
      MALL_ORDERS='orders', MALL_PRODUCTS='products';
/* 本地双击测试 / 演示模式：没配 Supabase 时，启用 LOCAL_MALL=1 可让商城数据也从 ./data 读取（方便端到端测拉单） */
const LOCAL_MALL=!USE_SUPABASE && process.env.LOCAL_MALL==='1';

/* ---------- KV：3 秒 TTL + 在途去重 ---------- */
const kvCache=new Map();
async function loadKV(key, fallback){
  if(USE_SUPABASE){
    const c=kvCache.get(key);
    if(c && c.promise) return c.promise;
    if(c && Date.now()-c.ts<3000 && !c.failed) return c.value;
    const p=(async()=>{
      try{
        const {data,error}=await sb.from('shop_data').select('value').eq('key',key).maybeSingle();
        if(error) throw new Error(error.message);
        const v=data?data.value:fallback;
        kvCache.set(key,{ts:Date.now(),value:v,promise:null,failed:false});
        return v;
      }catch(e){ console.error('[loadKV]',key,e.message);
        kvCache.set(key,{ts:0,value:fallback,promise:null,failed:true});
        throw e;
      }
    })();
    kvCache.set(key,{ts:0,value:fallback,promise:p,failed:false});
    return p;
  }
  const f=path.join(ROOT,'data',key+'.json');
  try{ return JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){ return fallback; }
}
async function saveKV(key, value){
  if(USE_SUPABASE){
    const {error}=await sb.from('shop_data').upsert({key,value,updated_at:new Date().toISOString()});
    if(error) throw new Error(error.message);
    kvCache.set(key,{ts:Date.now(),value,promise:null,failed:false});
    return;
  }
  const f=path.join(ROOT,'data',key+'.json');
  const tmp=f+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value,null,2));
  fs.renameSync(tmp,f);
}

/* 商城订单：clearance-shop 现在以 per-row key=`order:<id>` 为准（下单/状态变更均落到单行，并发安全），
   旧 `key='orders'` 大数组仅作整批备份残留、不再实时同步。这里以 per-row 为准，回退到旧数组。 */
let _mallCache={ts:0,value:null};
async function loadMallOrders(){
  if(USE_SUPABASE){
    if(_mallCache.value && Date.now()-_mallCache.ts<3000) return _mallCache.value;
    try{
      const {data,error}=await sb.from('shop_data').select('value').like('key','order:%');
      if(!error && data && data.length){
        const arr=data.map(r=>r.value).filter(Boolean);
        _mallCache={ts:Date.now(),value:arr};
        return arr;
      }
    }catch(e){ console.error('[loadMallOrders]',e.message); }
  }
  return await loadKV(MALL_ORDERS,[]);
}

/* ---------- 商城订单：候选清单 / 确认入库 ---------- */
/* 候选：商城里"待发货且尚未入库的订单"，不含明细整结构（前端直接展示勾选） */
async function pullMallCandidates(){
  const mallOrders=await loadMallOrders();
  const ship=await loadKV(SHIP_ORDERS,[]);
  const prods=await loadKV(MALL_PRODUCTS,[]);
  const pmap={}; (prods||[]).forEach(p=>pmap[p.id]=p.name);
  const have=new Set((ship||[]).map(o=>o.srcId).filter(Boolean));
  const candidates=[];
  (mallOrders||[]).forEach(o=>{
    if(o.tracking) return;             // 已发货跳过
    if(have.has(o.id)) return;         // 已拉过跳过
    if(!o.allowPull) return;           // 商家后台未勾选「允许采集」则跳过（柒木手动把关）
    const items=(o.items||[]).map(it=>({p:pmap[it.id]||it.id, q:it.qty}));
    candidates.push({
      srcId:o.id,
      no:o.id,
      name:o.name||'',
      phone:o.phone||'',
      address:o.address||'',
      date:(o.createdAt||o.ts||'').toString().slice(0,10)||new Date().toISOString().slice(0,10),
      items
    });
  });
  return {count:candidates.length, candidates};
}

/* 确认：把勾选的 srcIds 写入发货系统（前端已确认） */
async function pullMallConfirm(ids){
  if(!Array.isArray(ids)||!ids.length) return {added:0};
  const idset=new Set(ids);
  const mallOrders=await loadMallOrders();
  let ship=await loadKV(SHIP_ORDERS,[]);
  const prods=await loadKV(MALL_PRODUCTS,[]);
  const pmap={}; (prods||[]).forEach(p=>pmap[p.id]=p.name);
  const have=new Set((ship||[]).map(o=>o.srcId).filter(Boolean));
  let added=0;
  (mallOrders||[]).forEach(o=>{
    if(!idset.has(o.id)) return;        // 只导勾选的
    if(o.tracking) return;              // 已发货跳过
    if(have.has(o.id)) return;          // 已拉过跳过
    if(!o.allowPull) return;            // 再次校验（候选清单返回后可能被取消勾选）
    const items=(o.items||[]).map(it=>({p:pmap[it.id]||it.id, q:it.qty}));
    // 日期规范化：商城 createdAt 是 ms 时间戳（如 1787967970123），要切成 YYYY-MM-DD
    // 才能让 ②配货单 按日期过滤生效。先尝试按 ms 解析，否则用「今日」兜底。
    let dateNorm=new Date().toISOString().slice(0,10);
    const ca=Number(o.createdAt);
    if(Number.isFinite(ca) && ca>0){
      const dt=new Date(ca<1e12?ca*1000:ca); // 兼容秒或毫秒
      if(!isNaN(dt.getTime())) dateNorm=dt.toISOString().slice(0,10);
    }
    ship.push({id:'s_'+o.id+'_'+Date.now().toString(36),
      date:dateNorm,
      no:o.id, name:o.name||'', phone:o.phone||'', address:o.address||'', items,
      tracking:'', srcId:o.id, fromMall:true});
    have.add(o.id);
    added++;
  });
  await saveKV(SHIP_ORDERS,ship);
  return {added};
}

async function writebackTracking(srcId, tracking){
  const mallOrders=await loadMallOrders();
  const o=(mallOrders||[]).find(x=>x.id===srcId);
  if(o){ o.tracking=tracking; o.status='已发货'; if(USE_SUPABASE){ await sb.from('shop_data').upsert({key:'order:'+srcId, value:o}); } else await saveKV(MALL_ORDERS,mallOrders); }
  return !!o;
}

// 「今日可发导出」流程写回：订单在商家后台权威存储 per-row `order:<id>`，
// 不走 MALL_ORDERS（那是「从商城拉取」流程的仓库），故直接按 id 更新该订单行
async function writebackMallExportTracking(srcId, tracking){
  if(!USE_SUPABASE) return false;
  try{
    const {data,error}=await sb.from('shop_data').select('value').eq('key','order:'+srcId).maybeSingle();
    if(error) throw new Error(error.message);
    if(!data) return false;
    const o=data.value||{};
    o.tracking=tracking; o.status='已发货'; o.shippedAt=Date.now();
    const {error:uerr}=await sb.from('shop_data').upsert({key:'order:'+srcId, value:o});
    if(uerr) throw new Error(uerr.message);
    return true;
  }catch(e){ console.error('[writebackMallExport]',e.message); return false; }
}

/* 多次汇总模型：商家后台每次「全部导出」形成一个 mall session；店主在发货管家录入手工单后
   点「完毕」形成一个 manual session。一天可多次。pending：录单暂存（不入 manual_sessions）。 */
const MALL_SESSIONS='mall_sessions';
const MANUAL_SESSIONS='manual_sessions';
const MANUAL_PENDING='manual_pending';
const PENDING_TRACKING='pending_tracking';
async function loadMallSessions(){ const v=await loadKV(MALL_SESSIONS, []); return Array.isArray(v)?v:[]; }
async function appendMallSession(s){ const a=await loadMallSessions(); a.push(s); await saveKV(MALL_SESSIONS, a); return a; }
async function updateMallSession(sid, fn){
  const a=await loadMallSessions(); const i=a.findIndex(s=>s.sessionId===sid);
  if(i<0) return false; const r=fn(a[i]); if(r!==false) await saveKV(MALL_SESSIONS, a); return true;
}
async function loadManualSessions(){ const v=await loadKV(MANUAL_SESSIONS, []); return Array.isArray(v)?v:[]; }
async function appendManualSession(s){ const a=await loadManualSessions(); a.push(s); await saveKV(MANUAL_SESSIONS, a); return a; }
async function updateManualSession(sid, fn){
  const a=await loadManualSessions(); const i=a.findIndex(s=>s.sessionId===sid);
  if(i<0) return false; const r=fn(a[i]); if(r!==false) await saveKV(MANUAL_SESSIONS, a); return true;
}
async function loadManualPending(){ const v=await loadKV(MANUAL_PENDING, []); return Array.isArray(v)?v:[]; }
async function saveManualPending(a){ await saveKV(MANUAL_PENDING, a); }
async function loadPendingTracking(){ return await loadKV(PENDING_TRACKING, []); }
async function savePendingTracking(arr){ await saveKV(PENDING_TRACKING, arr); }

/* ---------- 手工订单汇总区（manual_pool）：发货员回传的带单号手工订单合集，
   只做汇总存档（后续结账/库存统计用），不参与回填、不写商家后台 ---------- */
const MANUAL_POOL='manual_pool';
async function loadManualPool(){ const v=await loadKV(MANUAL_POOL, []); return Array.isArray(v)?v:[]; }

/* ---------- 手工单原始文本池（manual_raw）：店主在①录单页粘贴的原始多单文本块+日期。
   不做结构化解析；仅在⑥统计/③结账处点「并入总账」时，按时间段取出做结构化解析，
   解析结果合并进 ship_orders 总账，统计/库存/结账才能算到手工单。 ---------- */
const MANUAL_RAW='manual_raw';
async function loadManualRaw(){ const v=await loadKV(MANUAL_RAW, []); return Array.isArray(v)?v:[]; }
async function saveManualRaw(a){ await saveKV(MANUAL_RAW, a); }
/* 手工单原始多单文本 → 结构化订单数组（与前端 parsePaste 模板C同规则：3行头+产品行）。
   供「并入总账」使用。 */
function parseOrderText(text, date){
  const lines=String(text||'').split(/\n/).map(l=>l.trim()).filter(Boolean);
  const isProductL=(l)=>/^\S+\s+\d+\s*[瓶盒包片支对扎袋件套\/／（(]/.test(l) || /^\S+\s+[×xX*]\s*\d+/.test(l);
  const orders=[]; let cur=null;
  lines.forEach(l=>{
    if(isProductL(l)){
      if(!cur) cur={headLines:[],productLines:[]};
      cur.productLines.push(l);
    }else{
      if(cur && cur.productLines.length>0){ orders.push(cur); cur=null; }
      if(!cur) cur={headLines:[],productLines:[]};
      if(cur.headLines.length<3) cur.headLines.push(l);
    }
  });
  if(cur) orders.push(cur);
  const out=[];
  orders.forEach(o=>{
    if(!o.headLines.length||!o.productLines.length) return;
    let name='',phone='',addr=''; const items=[];
    name=o.headLines[0];
    const second=o.headLines[1], third=o.headLines[2];
    if(/^[\d\-\s]{7,}$/.test(second||'')) phone=second;
    else if(/^[\d\-\s]{7,}$/.test(third||'')) phone=third;
    else addr=second||'';
    if(third && !/^[\d\-\s]{7,}$/.test(third)) addr=addr?addr+third:third;
    o.productLines.forEach(l=>{
      const m=l.match(/^(.+?)\s+(\d+)\s*([瓶盒包片支对扎袋件套])?(?:[\/／]([瓶盒包片支对扎袋件套]))?(?:[\s（(]([^)）]+)[)）])?\s*$/);
      if(m){const p=m[1].trim(),q=parseInt(m[2]);if(p&&q>0)items.push({p,q,shipDetail:p+'\n× '+q});return;}
      const m2=l.match(/^(.+?)\s+(\d+)\s*$/);
      if(m2){const p=m2[1].trim(),q=parseInt(m2[2]);if(p&&q>0)items.push({p,q,shipDetail:p+'\n× '+q});}
    });
    if(items.length) out.push({id:'mo_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),
      no:'', name, phone, address:addr, items, date:date||new Date().toISOString().slice(0,10), ts:Date.now()});
  });
  return out;
}
// 与前端 normalizeTracking 同规则：剥快递公司名前缀 + 保留 DPK/SF 等字母前缀 + 去连字符
function normalizeTrackingSrv(raw){
  raw=String(raw||'').trim();
  if(!raw) return '';
  let s=raw.replace(/^[一-龥]{1,8}\s*[-－:：]?\s*/,'');
  const m=s.match(/(?:[A-Za-z]{1,4}[-]?)?\d{6,}/);
  let t=m?m[0]:s.replace(/[^A-Za-z0-9]/g,'');
  return t.replace(/-/g,'');
}

/* ---------- HTTP ---------- */
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json'};
function send(res,code,body,type){ res.writeHead(code,{'Content-Type':type||'application/json; charset=utf-8'}); res.end(typeof body==='string'?body:JSON.stringify(body)); }
function readBody(req){ return new Promise(r=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{r(JSON.parse(d||'{}'))}catch(e){r({})} }); }); }

// 内部分发函数：抽成命名导出，便于商城 server.js 直接 require 复用（不重新 listen 端口）
async function shipCloudHandler(req,res){
  try{
    const u=new URL(req.url,'http://x');
    const p=u.pathname;
    // 静态首页
    if(p==='/' || p==='/index.html'){ res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store, no-cache, must-revalidate, max-age=0','Pragma':'no-cache','Expires':'0'}); res.end(fs.readFileSync(path.join(ROOT,'public','index.html'))); return; }
    /* /shipper 发货员视图已移除（2026-08-31）：全部在店主端 index.html 完成 */
    // 公共静态文件（如 SheetJS xlsx.full.min.js）— 只允许 public/ 目录内的白名单文件名，防目录遍历
    const SAFE_STATIC=new Set(['xlsx.full.min.js']);
    if(SAFE_STATIC.has(path.basename(p))){
      const sf=path.join(ROOT,'public',path.basename(p));
      if(fs.existsSync(sf)){ res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'}); res.end(fs.readFileSync(sf)); return; }
    }
    if(p==='/api/orders'){
      if(req.method==='GET'){ return send(res,200,await loadKV(SHIP_ORDERS,[])); }
      if(req.method==='POST'){ const b=await readBody(req); await saveKV(SHIP_ORDERS,b.orders||[]); return send(res,200,{ok:true}); }
    }
    if(p==='/api/products'){
      if(req.method==='GET'){ return send(res,200,await loadKV(SHIP_PRODUCTS,[])); }
      if(req.method==='POST'){ const b=await readBody(req); await saveKV(SHIP_PRODUCTS,b.products||[]); return send(res,200,{ok:true}); }
    }
    if(p==='/api/stock'){
      if(req.method==='GET'){ return send(res,200,{logs:await loadKV(SHIP_LOGS,[]), products:await loadKV(SHIP_PRODUCTS,[])}); }
      if(req.method==='POST'){ const b=await readBody(req); await saveKV(SHIP_LOGS,b.logs||[]); if(b.products) await saveKV(SHIP_PRODUCTS,b.products); return send(res,200,{ok:true}); }
    }
    if(p==='/api/settings'){
      if(req.method==='GET'){ return send(res,200,await loadKV(SHIP_SETTINGS,{rate:0.1})); }
      if(req.method==='POST'){ const b=await readBody(req); await saveKV(SHIP_SETTINGS,b.settings||{rate:0.1}); return send(res,200,{ok:true}); }
    }
    if(p==='/api/pull-mall' && req.method==='POST'){
      if(!USE_SUPABASE && !LOCAL_MALL) return send(res,400,{ok:false,message:'本地模式无商城数据，配置 Supabase 或启 LOCAL_MALL=1 后可用'});
      const r=await pullMallCandidates(); return send(res,200,{ok:true,candidates:r.candidates,count:r.count});
    }
    if(p==='/api/pull-mall-confirm' && req.method==='POST'){
      if(!USE_SUPABASE && !LOCAL_MALL) return send(res,400,{ok:false,message:'本地模式无商城数据'});
      const b=await readBody(req);
      const r=await pullMallConfirm(b.ids||[]);
      return send(res,200,{ok:true,added:r.added});
    }
    if(p==='/api/tracking' && req.method==='POST'){
      const b=await readBody(req);
      if(!b.id || !b.tracking) return send(res,400,{ok:false,message:'缺 id 或单号'});
      const ship=await loadKV(SHIP_ORDERS,[]);
      const o=(ship||[]).find(x=>x.id===b.id);
      if(!o) return send(res,404,{ok:false,message:'订单不存在'});
      o.tracking=b.tracking; await saveKV(SHIP_ORDERS,ship);
      let wb=false; if(o.srcId && USE_SUPABASE){ wb=await writebackTracking(o.srcId,b.tracking); }
      return send(res,200,{ok:true,writeback:wb});
    }
    if(p==='/api/mall-products' && req.method==='GET'){
      return send(res,200,await loadKV(MALL_PRODUCTS,[]));
    }
    /* /api/shipper/tables 已移除（2026-08-31 发货员视图下线，店主端 index.html 直接读 /api/pick-list） */
    // 发货员上传 Excel → 按手机号匹配商城 session 中的订单 → 暂存待店主确认
    // （2026-09-04 改版：手工订单的回传不再走这里，统一进「手工订单汇总区」manual_pool）
    if(p==='/api/shipper/upload-tracking' && req.method==='POST'){
      const b=await readBody(req);
      const rows=Array.isArray(b.rows)?b.rows:[];
      if(!rows.length) return send(res,400,{ok:false,message:'没有数据'});
      const flatMall=[]; (await loadMallSessions()).forEach(s=>(s.orders||[]).forEach(o=>flatMall.push({sessionId:s.sessionId, ts:s.ts, o})));
      const matched=[], unmatched=[];
      for(const r of rows){
        const phone=String(r.phone||'').replace(/\D/g,'').slice(-11);
        const tracking=String(r.tracking||'').trim();
        if(!phone||!tracking){ unmatched.push(r); continue; }
        // 2026-09-09 修复：合并客户（同电话）一次回传单号要全笔生效。
        // 原代码用 .find() 只匹配第一笔，后续笔永远落不到 matched，导致「三笔合并只第一笔发货、另两笔还在等待回传区」。
        // 改用 .filter() 取所有未发货的同电话订单，逐笔写入 matched。
        const ms = flatMall.filter(x=>String(x.o.phone||'').replace(/\D/g,'').slice(-11)===phone && !x.o.tracking);
        if(ms.length){
          for(const m of ms){
            matched.push({kind:'mall', sessionId:m.sessionId, srcId:m.o.id, orderId:null, no:m.o.id, name:m.o.name||r.name, phone, tracking, address:m.o.address||''});
          }
          continue;
        }
        unmatched.push(r);
      }
      await savePendingTracking(matched);
      return send(res,200,{ok:true, matched:matched.length, unmatched:unmatched.length, pending:matched});
    }
    if(p==='/api/pending-tracking' && req.method==='GET'){
      return send(res,200,{ok:true, pending:await loadPendingTracking()});
    }
    // 店主点「确认一键采集」：暂存的单号真正回填（商城单写回商家后台 order:<id>，手工单标记到 manual_session）
    if(p==='/api/confirm-tracking' && req.method==='POST'){
      const pending=await loadPendingTracking();
      if(!pending.length) return send(res,400,{ok:false,message:'没有待确认的回传'});
      let ok=0, wb=0;
      for(const m of pending){
        try{
          if(m.kind==='mall' && m.srcId){
            if(await writebackMallExportTracking(m.srcId, m.tracking)) wb++;
            if(m.sessionId) await updateMallSession(m.sessionId, s=>{ const o=(s.orders||[]).find(x=>x.id===m.srcId); if(o){ o.tracking=m.tracking; o.shippedAt=Date.now(); } });
            ok++;
          } else if(m.kind==='manual' && m.sessionId && m.orderId){
            await updateManualSession(m.sessionId, s=>{ const o=(s.orders||[]).find(x=>x.id===m.orderId); if(o){ o.tracking=m.tracking; o.shippedAt=Date.now(); } });
            ok++;
          }
        }catch(e){ console.error('[confirm]',e.message); }
      }
      await savePendingTracking([]);
      return send(res,200,{ok:true, ok, writeback:wb});
    }

    /* ============ 手工单：录单暂存（不直接入 ship_orders） ============ */
    if(p==='/api/manual-session/save' && req.method==='POST'){
      const b=await readBody(req);
      if(!b.name || !Array.isArray(b.items) || !b.items.length) return send(res,400,{ok:false,message:'缺姓名或明细'});
      const o={id:'mo_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
        no:b.no||'', name:b.name||'', phone:b.phone||'', address:b.address||'',
        items:b.items, date:b.date||new Date().toISOString().slice(0,10), ts:Date.now()};
      const arr=await loadManualPending(); arr.push(o); await saveManualPending(arr);
      return send(res,200,{ok:true, order:o, pendingCount:arr.length});
    }
    if(p==='/api/manual-session/pending' && req.method==='GET'){
      return send(res,200,{ok:true, pending:await loadManualPending()});
    }
    if(p==='/api/manual-session/del' && req.method==='POST'){
      const b=await readBody(req); const id=b.id;
      let arr=await loadManualPending(); arr=arr.filter(x=>x.id!==id); await saveManualPending(arr);
      return send(res,200,{ok:true, pending:arr});
    }
    // 「完毕」：把 manual_pending 中某日期的订单汇总成一个 session 入库，清空该日 pending
    if(p==='/api/manual-session/finalize' && req.method==='POST'){
      const b=await readBody(req);
      const date=b.date || new Date().toISOString().slice(0,10);
      const arr=await loadManualPending();
      const todays=arr.filter(x=>x.date===date);
      if(!todays.length) return send(res,400,{ok:false,message:'没有可汇总的手工单'});
      const baseN=(await loadManualSessions()).filter(x=>x.date===date).length;
      todays.forEach((o,i)=>{ if(!o.no) o.no=date.replace(/-/g,'')+'-'+String(baseN+i+1).padStart(3,'0'); });
      const session={sessionId:'MS'+Date.now().toString(36)+Math.random().toString(36).slice(2,4),
        ts:Date.now(), date, orders:todays};
      await appendManualSession(session);
      const left=arr.filter(x=>x.date!==date);
      await saveManualPending(left);
      return send(res,200,{ok:true, sessionId:session.sessionId, count:todays.length});
    }
    // 配货单 tab 数据：商城 + 手工 session 列表（近 7 天）+ manual pending
    if(p==='/api/pick-list' && req.method==='GET'){
      const today=new Date().toISOString().slice(0,10);
      const todayMs=new Date(today).getTime();
      const recent=ts=>{ const d=new Date(ts); return !isNaN(d) && Math.abs(d.getTime()-todayMs) < 7*86400e3; };
      const mallSessions=(await loadMallSessions()).filter(s=>recent(s.ts)).sort((a,b)=>a.ts-b.ts);
      const manualSessions=(await loadManualSessions()).filter(s=>recent(s.ts)).sort((a,b)=>a.ts-b.ts);
      const manualPending=await loadManualPending();
      return send(res,200,{ok:true, date:today, mallSessions, manualSessions, manualPending});
    }

    /* ============ 手工订单汇总区（manual_pool） ============ */
    if(p==='/api/manual-pool' && req.method==='GET'){
      return send(res,200,{ok:true, pool:await loadManualPool()});
    }
    if(p==='/api/manual-pool/add' && req.method==='POST'){
      const b=await readBody(req);
      const entries=Array.isArray(b.entries)?b.entries:[];
      const defDate=b.date||new Date().toISOString().slice(0,10);
      const pool=await loadManualPool();
      const have=new Set(pool.map(e=>String(e.tracking||'')));
      let added=0;
      entries.forEach(e=>{
        const tracking=normalizeTrackingSrv(e&&e.tracking);
        if(!tracking || have.has(tracking)) return;   // 无单号或重复 → 跳过
        have.add(tracking);
        pool.push({id:'mp_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          date:e.date||defDate,
          name:String(e.name||'').trim(),
          phone:String(e.phone||'').replace(/\D/g,'').slice(-11),
          address:String(e.address||'').trim(),
          tracking, ts:Date.now()});
        added++;
      });
      await saveKV(MANUAL_POOL,pool);
      return send(res,200,{ok:true, added, pool});
    }
    if(p==='/api/manual-pool/del' && req.method==='POST'){
      const b=await readBody(req);
      let pool=await loadManualPool();
      pool=pool.filter(x=>x.id!==b.id);
      await saveKV(MANUAL_POOL,pool);
      return send(res,200,{ok:true, pool});
    }
    if(p==='/api/manual-pool/clear' && req.method==='POST'){
      await saveKV(MANUAL_POOL,[]);
      return send(res,200,{ok:true, pool:[]});
    }

    /* ============ 手工单原始文本池（manual_raw）：①录单页粘贴生成Word时存档 ============ */
    if(p==='/api/manual-raw' && req.method==='GET'){
      return send(res,200,{ok:true, raw:await loadManualRaw()});
    }
    if(p==='/api/manual-raw/save' && req.method==='POST'){
      const b=await readBody(req);
      const text=String(b.text||'').trim();
      if(!text) return send(res,400,{ok:false,message:'没有文本'});
      const date=b.date||new Date().toISOString().slice(0,10);
      const arr=await loadManualRaw();
      // 同日期同文本去重
      if(!arr.some(x=>x.date===date && x.text===text)){
        arr.push({id:'mraw_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,6),
          date, text, ts:Date.now()});
        await saveManualRaw(arr);
      }
      return send(res,200,{ok:true, raw:arr});
    }
    if(p==='/api/manual-raw/del' && req.method==='POST'){
      const b=await readBody(req);
      let arr=await loadManualRaw(); arr=arr.filter(x=>x.id!==b.id);
      await saveManualRaw(arr);
      return send(res,200,{ok:true, raw:arr});
    }
    // 并入总账：按时间段，把该时间内的手工单原始文本做结构化解析，合并进 ship_orders
    if(p==='/api/manual-raw/merge' && req.method==='POST'){
      const b=await readBody(req);
      const from=b.from||'', to=b.to||'';
      const all=await loadManualRaw();
      const inRange=all.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to));
      const orders=await loadKV(SHIP_ORDERS,[]);
      const usedMraw=new Set((orders||[]).map(o=>o.mrawId).filter(Boolean));
      const parsed=[];
      const dupMraw=[];
      inRange.forEach(r=>{
        if(usedMraw.has(r.id)){ dupMraw.push(r.id); return; }  // 已并入过 → 跳过
        const arr=parseOrderText(r.text, r.date);
        let added=0;
        arr.forEach(o=>{ o.mrawId=r.id; o.source='manual'; parsed.push(o); added++; });
        if(added>0){ usedMraw.add(r.id); }
      });
      if(parsed.length){ await saveKV(SHIP_ORDERS, (orders||[]).concat(parsed)); }
      return send(res,200,{ok:true, merged:parsed.length, skippedDup:dupMraw.length,
        total:(orders||[]).length+parsed.length, orders:(orders||[]).concat(parsed), parsed});
    }
    // 撤销并入：从总账移除 source==='manual' 且 mrawId 在给定集合内的订单
    if(p==='/api/manual-raw/unmerge' && req.method==='POST'){
      const b=await readBody(req);
      const ids=Array.isArray(b.ids)?b.ids:[];
      let orders=await loadKV(SHIP_ORDERS,[]);
      const removed=orders.filter(o=>ids.includes(o.mrawId));
      orders=orders.filter(o=>!ids.includes(o.mrawId));
      await saveKV(SHIP_ORDERS, orders);
      return send(res,200,{ok:true, removed:removed.length, orders});
    }
    send(res,404,{ok:false,message:'not found'});
  }catch(e){ console.error(e); send(res,500,{ok:false,message:e.message}); }
}

const server=http.createServer(shipCloudHandler);

const PORT=process.env.PORT||4100;

// 本地启动
if(require.main===module){
  server.listen(PORT,'0.0.0.0',()=>console.log('[listen] http://localhost:'+PORT));
}

/* ---------- 腾讯云 CloudBase SCF 云函数适配（免 Docker 部署用） ---------- */
// SCF HTTP 触发器入参：event = { httpMethod, path, headers, queryString, body, ... }
// 出参：   { statusCode, headers, body, isBase64Encoded }
function scfHandler(event){
  return new Promise((resolve)=>{
    const method=(event.httpMethod||event.method||'GET').toUpperCase();
    const qs=event.queryString && Object.keys(event.queryString).length
      ? '?'+new URLSearchParams(event.queryString).toString()
      : (event.queryStringParameters ? '?'+new URLSearchParams(event.queryStringParameters).toString() : '');
    const rawPath=event.path||event.url||'/';
    const path=rawPath.split('?')[0];
    const url=path+qs;
    const headers=Object.assign({}, event.headers||{});
    // SCF 的 body 可能是 base64 或 字符串
    let bodyStr='';
    if(event.body!==undefined && event.body!==null){
      if(event.isBase64Encoded){
        try{ bodyStr=Buffer.from(event.body,'base64').toString('utf8'); }catch(e){ bodyStr=''; }
      } else { bodyStr=String(event.body); }
    }
    // 构造 fake req/res，让既有的 http.createServer 回调直接复用
    const req={
      method, url, headers,
      _dataCb:null, _endCb:null,
      on(ev,cb){
        if(ev==='data') this._dataCb=cb;
        else if(ev==='end') this._endCb=cb;
      }
    };
    const chunks=[];
    const resHeaders={};
    const res={
      statusCode:200, headersSent:false,
      setHeader(k,v){ resHeaders[String(k).toLowerCase()]=v; },
      getHeader(k){ return resHeaders[String(k).toLowerCase()]; },
      getHeaders(){ return resHeaders; },
      removeHeader(k){ delete resHeaders[String(k).toLowerCase()]; },
      writeHead(code, h){
        this.statusCode=code; this.headersSent=true;
        if(h){
          if(typeof h==='string'){ resHeaders['content-type']=h; }
          else { Object.entries(h).forEach(([k,v])=>{ resHeaders[String(k).toLowerCase()]=v; }); }
        }
        return this;
      },
      write(chunk){ chunks.push(Buffer.from(chunk||'')); return true; },
      end(chunk){
        if(chunk) chunks.push(Buffer.from(chunk));
        const isBin=chunks.length && (chunks.some(c=>c.length && (c[0]<32 && c[0]!==10 && c[0]!==13 && c[0]!==9)));
        // 文本统一用 utf8
        const out=Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode:this.statusCode, headers:resHeaders, body:out, isBase64Encoded:false });
      }
    };
    // 触发 server 的 request 监听（createServer 内部就是 emit('request', req, res)）
    try{
      server.emit('request', req, res);
    }catch(e){
      resolve({ statusCode:500, headers:{'content-type':'application/json'}, body:JSON.stringify({ok:false,message:e.message}) });
    }
    // 把 body 推给 req（异步）
    setImmediate(()=>{
      if(bodyStr && req._dataCb) req._dataCb(bodyStr);
      if(req._endCb) req._endCb();
    });
  });
}
// SCF 入口导出（云函数识别）
exports.main=scfHandler;
// 商城嵌入导出：让商城 server.js 直接转发请求到本 handler，不必另起端口
exports.handler=shipCloudHandler;
module.exports=module.exports; // 兼容 require() 场景
