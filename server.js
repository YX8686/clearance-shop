// 清仓商城 · 单文件服务端（支持「本地文件 / Supabase 云端」双模式）
// 本地双击图标零依赖即可跑；配置 SUPABASE_URL + SUPABASE_ANON_KEY 后自动切云端，数据持久化不丢。
// Render 云端启动：先 listen 端口再异步 boot，避免健康检查超时。
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let _sanitizeHtml;
try { _sanitizeHtml = require('sanitize-html'); } catch(e){ _sanitizeHtml = null; }

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const VIEWS = path.join(ROOT, 'views');
const GALLERY = path.join(PUBLIC, 'assets', 'gallery');
const PORT = process.env.PORT || 4100;
// 商家后台自检版本：任何 /admin 响应会注入 var my=这个常量到 HTML；
// 客户端加载后会 fetch /api/admin-build 比对，不一致就 location.replace 强制刷新，
// 这样柒木的桌面快捷方式再也不会被浏览器旧缓存坑（缓存了多久都能自动治）。
// fix45（2026-09-21）：版本号必须随「前端 admin.html 的任何修复」一起升位——
// 自检只比对版本字符串，若前端改了但这里不动，用户已经打开的旧标签页永远不会重载，
// 会一直跑旧 JS（症状：保存成功但重开还是旧值）。
// fix46（2026-09-21）：点「编辑」时不再只信页面内存 PRODUCTS，先向 GET /api/products/:id
// 拉一次该产品的云端真值再填弹窗 —— 从根上消除「数据已存好、打开却显示旧值」，
// 手机端（走 onrender 云端后台）和任何旧标签页都同样生效。
// fix47（2026-09-21）：图片上传加固 —— Supabase Storage 抖动时重试 3 次；
// 仍失败则返回空串让前端明确报错，绝不再静默回退成本地 '/assets/...' 相对路径
// （那种路径云端 Render 取不到，会导致买家端产品主图裂图，真实故障：十全大补/精雕眼霜）。
// fix48（2026-09-21）：本地后台「打开要 90~100 秒」「改库存保存显示成功但没变」的真根因 =
// 本机直连 Supabase 极慢（实测单次 10s+；server.log 刷满 loadProducts timeout / saveProductRow
// TypeError: fetch failed），而 decideNetwork 只用 3.5s 的 HEAD 探测就误判「直连可用」→
// 全站读库/写库大面积超时（订单/产品读取 7s、boot 串行 4 次调用 ≈ 96s、保存失败）。
// 现改为：代理端口可用就优先走本机代理（实测 ~3s），并把单次超时放宽到 20s。
// fix49（2026-09-21）：根治「显示保存成功但其实没落库」——
//  ① 保存后**回读校验**（updatedAt 不一致就报失败，绝不假成功）；
//  ② 一次调用失败就**切换网络路径**（直连 ⇄ 本机代理）再试，不在同一条坏路上反复重试；
//  ③ `flushDirtyProducts` 在 ops 模式**读不到云端基准时改成跳过**（原来会拿整份本地旧对象覆盖云端，
//     把后台刚保存的名称/描述/SKU/图片冲掉）。
// fix50（2026-09-22）：后台自检改为**每 10 秒轮询**（原来只在页面打开时查一次）——
// 这样「开了很久没关的旧标签页」也会在版本变化后自动刷新，不再永远跑旧 JS、
// 不再出现「旧页面弹了保存成功其实根本没发请求」。
// fix51（2026-09-22）：后台产品主图集体变「暂无图片」——
// 真根因不在商城代码：后台卡片是浏览器**直连 supabase.co**（买家端早就改走同源 /img/ 代理了，唯独后台漏了），
// 而本机到境外的链路时通时不通（Clash 节点挂掉时 GitHub/Supabase/Render 全 000），图片请求全灭 → 前端回退占位图。
// 两道加固：① admin.html 主图统一走同源 /img/ 代理（拉不到再退回浏览器直连，两条路总有一条通）；
//          ② /img/ 增加**磁盘缓存**，只要成功拉到过一次就落盘，之后重启进程/断外网都还能出图。
// fix53（2026-09-23）：「商 城发货单」两个故障——
// ① 点「下载发货单」下不动：旧代码把「下载发货单」和「导出到发货管家」绑成一个动作，
//    而且顺序是**先导出后下载**。导出要先读写云库 mall_sessions，本机网络/代理一抖动就整段失败
//    （server.log 实证：[loadKV:mall_sessions] 云端第1/2次调用失败: timeout），下载被一起拖死 → 一张单子都拿不到。
//    改为**先本地生成并下载发货单**（纯前端、零网络依赖），再尝试导出；导出失败只提示，不影响已下载的单子，也不动订单。
// ② 图片版/Word 版发货单的编号对不上：合并单把组内所有编号拼成「A54/E43」，
//    而后台卡片显示的是组内第一笔的编号「A54」，柒木对着看以为编号错了。
//    改为主编号 = first.shipCode（与卡片严格一致），逐笔明细行里仍各自标注编号，信息不丢。
const ADMIN_BUILD = 'fix56-2026-09-23-today-save-tracking-and-ship';
// fix50（2026-09-22）：自检从「只在打开时查一次」升级为「每 10 秒查一次」。
// 根因：只查一次的写法对「开了很久没关的旧标签页」完全无效 —— 那页永远跑旧 JS，
// 旧 JS 在请求没发出去/失败时也会弹「保存成功」，于是「保存成功但没保存」反复出现。
// 现在任何打开着的后台页，只要版本一变就会自动重载；正在编辑弹窗时不打断（避免丢输入）。
const ADMIN_SELF_CHECK = '<script>(function(){var my="' + ADMIN_BUILD + '";'
  + 'function editing(){try{var m=document.getElementById("prodModal");return !!(m&&m.classList.contains("show"));}catch(e){return false;}}'
  + 'function chk(){if(editing())return;fetch("/api/admin-build",{cache:"no-store"}).then(r=>r.json()).then(j=>{if(j&&j.v&&j.v!==my){try{location.replace(location.pathname+"?v="+j.v+"&t="+Date.now());}catch(e){location.reload(true);}}}).catch(function(){});}'
  + 'chk();setInterval(chk,10000);})();</script>';

// 读取 .env.local（本地双击图标时无需手动设置环境变量）
function loadEnvLocal(){
  try {
    const envPath = path.join(ROOT, '.env.local');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    text.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2];
      }
    });
  } catch(e){}
}
loadEnvLocal();

// ---------- Supabase 客户端（仅在配置了环境变量时启用；本地模式零依赖也能跑） ----------
// supabase fetch 加超时（默认 fetch 不带超时，Supabase 免费层冷启动慢/抖动时会无限挂起，
// 商家后台"确认收款"会卡到 30s+）。30s 已足够覆盖冷启动，但够短能让前端尽快感知失败。
let sb = null;
// 单次云端调用超时（fix48：12s → 20s）。本机直连 Supabase 实测 10s+，12s 会频繁误判超时。
const SB_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 20000;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const fetchWithTimeout = (url, opts) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), SB_TIMEOUT_MS);
      return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
    };
    sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { global: { fetch: fetchWithTimeout } });
  } catch (e) {
    console.error('[Warn] 未能加载 @supabase/supabase-js，已回退本地文件模式：', e.message);
  }
}
const USE_SUPABASE = !!sb;

// ---------- 网络路径自适应（2026-09-13 修复「本地后台点应用/保存一直卡住或失败」） ----------
// 根因：柒木本机开着 Clash。TUN(虚拟网卡) 模式会把 DNS 劫持成 fake-ip，Node 直连 Supabase 直接失败；
// 而 Node 默认也不读系统的"系统代理"，于是本地 4301 所有写库操作（活动排期/保存设置/确认收款）全部超时。
// 方案：启动时先用 node:https 探一次直连（不走 undici，绝不污染后续 fetch 的 dispatcher）：
//   · 直连可用（Clash 关闭 / 只是系统代理）→ 不启用代理，避免"代理端口不在"反而连不上；
//   · 直连不可用（Clash TUN 开着）→ 启用 NODE_USE_ENV_PROXY + HTTP(S)_PROXY 走本机代理。
// 这样柒木无论开不开 Clash，本地后台都能写库，不需要他手动调网络设置。
let NET_MODE = 'direct';
function enableEnvProxy(proxy){
  // Node 22.21+ 支持：设 NODE_USE_ENV_PROXY=1 后，全局 fetch 会读 HTTP_PROXY/HTTPS_PROXY
  process.env.NODE_USE_ENV_PROXY = '1';
  if(!process.env.HTTP_PROXY) process.env.HTTP_PROXY = proxy;
  if(!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = proxy;
  NET_MODE = 'proxy';
}
// fix49：本机「直连」和「本机代理」两条路都时好时坏（实测同一分钟内一条 3s、一条 10s+）。
// 一次调用失败时，就切到另一条路再试，而不是在同一条坏路上反复重试。
function switchNetworkPath(label){
  const proxy = String(process.env.SUPABASE_PROXY || '').trim();
  if(!proxy) return;
  if(NET_MODE === 'proxy'){
    delete process.env.NODE_USE_ENV_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    NET_MODE = 'direct';
  } else {
    process.env.NODE_USE_ENV_PROXY = '1';
    process.env.HTTP_PROXY = proxy;
    process.env.HTTPS_PROXY = proxy;
    NET_MODE = 'proxy';
  }
  console.warn('[Net] ' + (label||'') + ' 失败 → 切换网络路径为 ' + NET_MODE);
}
function probeDirect(baseUrl, timeoutMs){
  return new Promise(resolve=>{
    let done = false;
    const finish = v => { if(!done){ done = true; resolve(v); } };
    let u;
    try { u = new URL(String(baseUrl).replace(/\/+$/, '') + '/rest/v1/'); }
    catch(e){ return finish(false); }
    const mod = u.protocol === 'http:' ? http : https;
    let r;
    try {
      r = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname,
        method: 'HEAD',
        timeout: timeoutMs
      }, res=>{ res.resume(); finish(true); });
    } catch(e){ return finish(false); }
    r.on('timeout', ()=>{ try{ r.destroy(); }catch(e){} finish(false); });
    r.on('error', ()=>{ finish(false); });
    r.end();
  });
}
// TCP 端口探测：本机代理（Clash 等）是否在监听
function probePort(host, port, timeoutMs){
  return new Promise(resolve=>{
    let done = false;
    const finish = v => { if(!done){ done = true; resolve(v); } };
    let s;
    try { s = net.connect({ host, port }); } catch(e){ return finish(false); }
    const t = setTimeout(()=>{ try{ s.destroy(); }catch(e){} finish(false); }, timeoutMs);
    s.on('connect', ()=>{ clearTimeout(t); try{ s.destroy(); }catch(e){} finish(true); });
    s.on('error', ()=>{ clearTimeout(t); finish(false); });
  });
}
// 2026-09-21（fix48）策略反转：本机实测「直连 Supabase 很慢」（单次 10s+，日志刷 timeout / fetch failed），
// 「走本机代理 ~3s」。旧逻辑只用 3.5s 的 HEAD 探测就判「直连可用」→ 结果全站超时（后台打开 90~100s、保存失败）。
// 新逻辑：代理端口在监听 → 优先走代理；代理不可用（Clash 没开）→ 才直连。
async function decideNetwork(){
  if(!USE_SUPABASE) return;
  const proxy = String(process.env.SUPABASE_PROXY || '').trim();
  if(!proxy){ NET_MODE = 'direct'; return; }
  if(process.env.SUPABASE_FORCE_PROXY === '1'){
    enableEnvProxy(proxy);
    console.log('[Net] 已按 SUPABASE_FORCE_PROXY 强制走代理：' + proxy);
    return;
  }
  const m = proxy.match(/^https?:\/\/([^:\/]+):(\d+)/);
  if(m && await probePort(m[1], Number(m[2]), 800)){
    enableEnvProxy(proxy);
    console.log('[Net] 检测到本机代理端口可用，优先走代理：' + proxy);
    return;
  }
  NET_MODE = 'direct';
  console.log('[Net] 本机代理端口不可用，改用直连');
}

function ensureDir(d){ if(!fs.existsSync(d)) fs.mkdirSync(d, {recursive:true}); }
ensureDir(DATA); ensureDir(PUBLIC); ensureDir(VIEWS); ensureDir(GALLERY);

// ---------- 本地文件读写（原子写入 + 写锁，防并发丢数据） ----------
function readJson(file, fallback){
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch(e){ return fallback; }
}
function copyIfExists(src, dst){ try{ if(fs.existsSync(src)) fs.copyFileSync(src, dst); }catch(e){} }

// 串行写锁：把多次写入排队，避免交错覆盖
let writeLock = Promise.resolve();
function withLock(fn){ writeLock = writeLock.then(fn, fn); return writeLock; }

function writeJsonAtomic(file, data){
  const target = path.join(DATA, file);
  const tmp = target + '.tmp';
  if(fs.existsSync(target)) copyIfExists(target, target + '.backup');
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch(e) {
    fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
  }
}

// ---------- 数据层（KV：云端=Supabase 表 shop_data；本地=data/*.json） ----------
// 读取缓存：3 秒 TTL + 并发去重。商家后台一次打开会并发拉 orders/config/products/gallery，
// 有了这层缓存，短时间内的重复请求（如刷新、多接口同时读 orders）只打一次 Supabase，大幅加快后台首屏。
const KV_TTL_MS = 3000;
const kvCache = new Map(); // key -> { ts, value, promise }

// 云端调用重试：覆盖 Supabase 免费层间歇 fetch failed / 冷启动抖动
// 默认 2 次快速重试（失败后立即再试 1 次，间隔 600ms）。
// 以前默认 5 次指数退避（最长 6.4s）导致保存明显变慢，且前端超时重试会造成重复产品。
async function withRetry(fn, label, retries=2, timeoutMs){
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : SB_TIMEOUT_MS;
  let lastErr;
  for(let i=0;i<retries;i++){
    try{
      // 单调用超时（fix48：12s → 20s）：Supabase 免费层偶发 fetch 永久挂起必须强制释放，防止 withLock 死锁；
      // 同时本机直连 Supabase 实测 10s+，12s 会频繁误判超时。
      // fix52：允许调用方传更短的超时（后台点开关这类小操作不该让柒木等 80 秒）。
      return await Promise.race([fn(), new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')), limit))]);
    }
    catch(e){
      lastErr=e;
      // fix52：把 undici 的真实底层原因（ECONNRESET / socket hang up / ENOTFOUND…）一起记进日志，
      // 否则永远只看到 "fetch failed"，分不清是代理挂了还是 Supabase 抖动。
      const cause = (e && e.cause) ? (' | cause=' + (e.cause.code || e.cause.message || String(e.cause))) : '';
      console.error(`[${label}] 云端第${i+1}/${retries}次调用失败:`, (e && e.message) + cause);
      if(i<retries-1){
        switchNetworkPath(label);            // fix49：失败就换另一条路（直连 ⇄ 代理）再试
        await new Promise(r=>setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}

// ---------- 幂等保存：防止前端重试/网络抖动导致同一操作被多次执行 ----------
// 前端每次保存会带一个 clientSaveId，后端记录最近处理过的 ID，重复请求直接返回上次结果
const recentSaveIds = new Map(); // clientSaveId -> { product, ts }
const SAVE_ID_TTL_MS = 60000;
function cleanupRecentSaveIds(){
  const now = Date.now();
  for(const [k,v] of recentSaveIds){
    if(now - v.ts > SAVE_ID_TTL_MS) recentSaveIds.delete(k);
  }
}
function recordSaveId(id, product){
  if(!id) return;
  cleanupRecentSaveIds();
  recentSaveIds.set(id, { product, ts: Date.now() });
}
function getSavedById(id){
  if(!id) return null;
  cleanupRecentSaveIds();
  const hit = recentSaveIds.get(id);
  return hit ? hit.product : null;
}

async function loadKV(key, fallback){
  if(USE_SUPABASE){
    const now = Date.now();
    const hit = kvCache.get(key);
    if(hit){
      if(now - hit.ts < KV_TTL_MS && !hit.failed) return hit.value;   // 缓存新鲜且上一次没失败
      if(hit.promise) return hit.promise;              // 同 key 并发中，共享在途请求
    }
    const promise = (async()=>{
      try{
        const { data, error } = await withRetry(()=>sb.from('shop_data').select('value').eq('key', key).maybeSingle(), 'loadKV:'+key);
        if(error) throw new Error(error.message);
        if(data) return data.value;
        return fallback;
      }catch(e){
        console.error('[loadKV]', key, e.message);
        // 关键修复：失败时不缓存，让下次请求重新尝试（避免一直用陈旧值）
        kvCache.set(key, { ts: 0, value: fallback, promise: null, failed: true });
        // boot 阶段或被调方已 try/catch 的场景下不抛错也能降级；显式调用方需要感知失败请看 promise 状态
        throw e;
      }
    })();
    kvCache.set(key, { ts: now, value: hit ? hit.value : fallback, promise });
    try{
      const value = await promise;
      kvCache.set(key, { ts: Date.now(), value, promise: null });
      return value;
    }catch(e){
      // 让 await loadKV 的调用方能感知到错误（boot 阶段会被 ensureBoot catch 转 503）
      throw e;
    }
  }
  return readJson(key + '.json', fallback);
}
async function saveKV(key, value, retries){
  if(USE_SUPABASE){
    // 关键修复：失败必须抛错给调用方。之前是 console.error 静默吞掉，
    // 导致前端拿到 {ok:true} 但云端没写入，重启服务后状态回退（症状：商家后台点"确认收款"成功但刷新后订单又回"待处理"）。
    // retries 可自定义：config 等低频关键配置保存时传入更大重试次数，降低 Supabase 免费层抖动影响。
    const { error } = await withRetry(()=>sb.from('shop_data').upsert({ key, value }), 'saveKV:'+key, retries);
    if(error) throw new Error('Supabase save error: ' + error.message);
    kvCache.set(key, { ts: Date.now(), value, promise: null }); // 写成功后同步缓存，保证读到自己刚写的数据
    return;
  }
  writeJsonAtomic(key + '.json', value);
}

// ---------- 图片写入（云端=Supabase Storage；本地=PUBLIC/assets） ----------
// storageSub：云端 bucket 内的子路径；本地模式始终写 PUBLIC/assets 根

// Supabase Storage isValidKey 仅允许 S3 安全字符，中文/非 ASCII 会报 Invalid key
function toSafeStorageKey(str, keepExt=false){
  if(!str) return str;
  let ext='', base=str;
  if(keepExt){
    const m=str.match(/(\.[^.]+)$/);
    if(m){ ext=m[1]; base=str.slice(0,-ext.length); }
  }
  if(/^([A-Za-z0-9_]|\/|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)+$/.test(base)) return str;
  return Buffer.from(base,'utf8').toString('base64url') + ext;
}
function toSafeStoragePath(storageSub){
  return String(storageSub||'').split('/').map(s=>toSafeStorageKey(s,true)).join('/');
}

async function saveImage(base64, fileName, storageSub){
  const m = String(base64).match(/^data:(image\/\w+);base64,(.+)$/);
  if(!m) return '';
  const ext = m[1]==='image/png'?'png':(m[1]==='image/jpeg'?'jpg':(m[1]==='image/webp'?'webp':'png'));
  const buf = Buffer.from(m[2], 'base64');
  const file = String(fileName||'img').replace(/[\\/:*?"<>|]/g,'_').replace(/\.[^.]+$/,'') + '.' + ext;
  const relDir = String(storageSub||'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
  const localDir = relDir ? path.join(PUBLIC, 'assets', relDir) : path.join(PUBLIC, 'assets');
  ensureDir(localDir);
  const localFile = path.join(localDir, file);
  const localUrl = relDir ? '/assets/' + relDir + '/' + file : '/assets/' + file;

  // fix47（2026-09-21）：云端存储抖动（fetch failed / timeout）必须重试，且绝不返回本地相对路径。
  // 旧逻辑：storage 上传一次失败 → 静默 catch → 落本地磁盘并返回 '/assets/...' 相对路径。
  //   但云端 Render 上没有这个文件 → 产品主图在买家端直接裂图。
  //   真实故障（2026-09-21）：「3588十全大补」「精雕眼霜15g」两张主图就是这样裂的，
  //   图片只存在于商家电脑 localhost，云端 404。
  // 新逻辑：storage 上传最多重试 3 次（间隔 0.8s / 1.6s）；仍失败则返回空串，
  //   让调用方明确报「上传失败」（图库上传接口已有 if(!url) → 500 分支），
  //   绝不把云端取不到的本地路径写进产品数据。
  // 本地模式（未配 Supabase）保持原样：写 PUBLIC/assets 并返回相对路径，本地能正常显示。
  if(USE_SUPABASE){
    const safeSub = toSafeStoragePath(storageSub);
    const safeFile = toSafeStorageKey(file, true);
    const objectPath = (safeSub ? safeSub + '/' : 'uploads/') + safeFile;
    let lastErr = null;
    for(let attempt=0; attempt<3; attempt++){
      try{
        const { error } = await sb.storage.from('shop').upload(objectPath, buf, { contentType: m[1], upsert: true });
        if(error) throw error;
        const { data:{ publicUrl } } = sb.storage.from('shop').getPublicUrl(objectPath);
        if(!publicUrl) throw new Error('getPublicUrl 返回空');
        return publicUrl;
      }catch(e){
        lastErr = e;
        console.error('[saveImage] storage 第'+(attempt+1)+'/3次失败:', e && e.message);
        if(attempt<2) await new Promise(r=>setTimeout(r, 800*(attempt+1)));
      }
    }
    // 三次都失败：保留一份本地副本便于人工补救，但绝不把它返回给前端
    try{ fs.writeFileSync(localFile, buf); console.error('[saveImage] 已留本地副本（云端不可达，未返回）:', localFile); }catch(_){}
    console.error('[saveImage] 云端存储三次均失败，放弃上传:', lastErr && lastErr.message);
    return '';
  }
  fs.writeFileSync(localFile, buf);
  return localUrl;
}

const DEFAULT_CONFIG = {
  shopName: '不初限时狂欢商城',
  contactName: '夏天老师',
  paymentQr: '/assets/payment-qr.svg',
  paymentWechatQr: '',
  paymentAlipayQr: '',
  bankImage: '',
  bankName: '',
  bankAccount: '',
  bankHolder: '',
  announcement: '',
  shareImage: '',
  hiddenCategories: [],
  activityDeadline: '',
  activityStart: '',
  countdownPhrases: [],
  countdownSegmentHours: 12,
  countdownManualIndex: -1
};

// fix49：启动即用本地缓存垫底（而不是空数组），这样即使云端慢到 boot 超时，
// 后台也能立刻用「上一次的本地数据」打开，不会白屏。boot 完成后会用云端最新数据覆盖。
let products = readJson('products.json', []);
let config = DEFAULT_CONFIG;
let orders = [];   // 订单不预填磁盘缓存（boot 一定从云端覆盖；避免任何"用旧订单当写源"的可能）
let booted = false;
let bootPromise = null;

function ensureBoot(){
  if(booted) return Promise.resolve();
  if(!bootPromise) bootPromise = boot();
  return bootPromise;
}

async function boot(){
  // 必须在任何 Supabase 请求之前决定网络路径（undici 的全局 dispatcher 一旦用过就固定了）
  try { await decideNetwork(); }
  catch(e){ console.error('[boot] 网络探测失败，按直连处理：', e.message); }
  const seedProducts = readJson('products.json', []);
  const seedConfig = readJson('config.json', DEFAULT_CONFIG);
  const seedOrders = readJson('orders.json', []);
  // fix48：products / config / orders 三类数据彼此独立 → 并发加载。
  // 旧写法是串行 3 次云端往返之和（本机单次 4~10s，串行叠加就是后台「打开要 90~100 秒」的主因之一），
  // 而 server 每个请求都要 await ensureBoot()，串行会把首屏整体拖住。并发后 boot ≈ 最慢的那一次。
  // 各自失败仍降级到本地 data/*.json 种子，失败行为与旧版完全一致。
  const [pRes, cRes, oRes] = await Promise.all([
    (async()=>{ try{ return await loadProductsFromRows(seedProducts); }
      catch(e){ console.error('[boot] products 加载失败，使用本地种子：', e.message); return seedProducts; } })(),
    (async()=>{ try{ return await loadKV('config', seedConfig); }
      catch(e){ console.error('[boot] config 加载失败，使用本地种子：', e.message); return seedConfig; } })(),
    // 订单载入：优先从独立行 order:* 聚合（新方案，并发安全）；若无则回退旧 orders 大数组行并拆分迁移
    (async()=>{
      try{
        if(!USE_SUPABASE) return seedOrders;
        const { data, error } = await sb.from('shop_data').select('key,value').like('key','order:%');
        if(!error && data && data.length) return data.map(r=>r.value).filter(Boolean);
        const arr = await loadKV('orders', seedOrders);
        const list = Array.isArray(arr)?arr:[];
        if(list.length){
          await Promise.all(list.map(o=> (o&&o.id) ? sb.from('shop_data').upsert({key:'order:'+o.id, value:o}).catch(e=>console.error('[migrate]',e.message)) : Promise.resolve()));
          console.log('[migrate] 已拆分旧 orders 数组为', list.length, '条独立行');
        }
        return list;
      }catch(e){ console.error('[boot] orders 加载失败，使用本地种子：', e.message); return seedOrders; }
    })()
  ]);
  products = pRes;
  // 合并默认值：后续新增字段（如 hiddenCategories）不会在老配置里缺失
  config = { ...DEFAULT_CONFIG, ...(typeof cRes==='object' && cRes ? cRes : {}) };
  orders = Array.isArray(oRes) ? oRes : [];
  if(config.paymentQr && !config.paymentWechatQr) config.paymentWechatQr = config.paymentQr;
  booted = true;
  console.log('[Data] 模式=' + (USE_SUPABASE ? 'Supabase云端' : '本地文件') +
    '，产品数=' + products.length + '，订单数=' + orders.length);
  // 为历史待发货订单补发编号（异步，不阻塞启动）
  setTimeout(()=>{
    const need = orders.filter(o=>['待发货','今日可发','待回传'].includes(o.status) && !o.shipCode);
    if(need.length){
      need.forEach(o=>{ ensureShipCode(o); saveOrderRow(o); });
      console.log('[shipCode] 已为', need.length, '笔历史待发货订单补编号');
    }
  }, 0);
}

// 本地模式：启动时校验数据目录是否可写（防止沙箱/权限问题导致下单失败）
if(!USE_SUPABASE){
  try {
    const testFile = path.join(DATA, '.write-test.'+Date.now());
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
  } catch(e) {
    console.error('');
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.error('! 警告：数据目录不可写（'+e.message+'）');
    console.error('! 后续提交订单会失败。');
    console.error('! 请关闭本窗口，双击桌面图标「不初限时狂欢商城」重新启动。');
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.error('');
  }
}

// ===== 订单存储加固：每条订单独立存储为 shop_data 的一行（key=order:<id>）=====
// 旧方案：所有订单塞进 shop_data 的单行(key='orders')，靠进程内 withLock 串行覆盖整个数组，
// 200+ 并发时 O(n²) 串行导致集体超时、且 Render 多实例会互相覆盖丢单。
// 新方案：每条订单 upsert 独立行，Postgres 并发 upsert 单行原子、互不干扰，彻底消除上述风险。
// ===== 订单存储加固：每条订单独立存储为 shop_data 的一行（key=order:<id>）=====
// 批量写入队列：200+ 并发下单时，收集订单到队列，每 500ms 或满 50 条批量 upsert 一次，
// 把 200 次单独 HTTP 请求降为 ~4 次批量请求，彻底解决 Node fetch 连接池并发上限（~6/主机）导致的超时。
let _orderWriteQueue = [];
let _orderFlushTimer = null;
function _scheduleOrderFlush(){
  if(_orderFlushTimer) return;
  _orderFlushTimer = setTimeout(_flushOrderQueue, 500);
}
async function _flushOrderQueue(){
  _orderFlushTimer = null;
  const batch = _orderWriteQueue.splice(0, 50); // 取最多 50 条
  if(!batch.length) return;
  if(USE_SUPABASE){
    try {
      const rows = batch.map(o => ({ key:'order:'+o.id, value:o }));
      const { error } = await sb.from('shop_data').upsert(rows);
      if(error) console.error('[orderFlush] batch error:', error.message, '| falling back to individual writes');
      else batch.forEach(o => kvCache.set('order:'+o.id, { ts:Date.now(), value:o, promise:null }));
      // 批量失败时降级为逐条写（保证至少能落盘）
      if(error) {
        for(const o of batch) {
          try { await sb.from('shop_data').upsert({ key:'order:'+o.id, value:o }); } catch(e){}
        }
      }
    } catch(e){ console.error('[orderFlush] exception:', e.message); }
  }
  // 如果队列还有积压，立即排下一批
  if(_orderWriteQueue.length) _scheduleOrderFlush();
}
// 下单用：内存即时同步 + 入队批量写（非阻塞，响应秒回）
function saveOrderRow(order){
  const idx = orders.findIndex(o=>o.id===order.id);
  if(idx>=0) orders[idx]=order; else orders.push(order);
  _orderWriteQueue.push(order);
  if(_orderWriteQueue.length >= 50) _flushOrderQueue(); // 满了立即刷
  else _scheduleOrderFlush(); // 500ms 后批量刷
}
// 状态变更用（低频管理操作）：内存即时同步 + 立即单条 upsert（确保状态即时落盘）
async function saveOrderRowSync(order){
  if(USE_SUPABASE){
    const { error } = await sb.from('shop_data').upsert({ key:'order:'+order.id, value: order });
    if(error) throw new Error('Supabase saveOrderRow error: '+error.message);
    kvCache.set('order:'+order.id, { ts:Date.now(), value:order, promise:null });
  }
  const idx = orders.findIndex(o=>o.id===order.id);
  if(idx>=0) orders[idx]=order; else orders.push(order);
}
// 进程退出前刷盘，防丢单
process.on('beforeExit', ()=>{ _flushOrderQueue(); flushDirtyProducts().catch(()=>{}); });
// 兜底：任何未捕获异常都只记日志，绝不让服务静默死掉（否则商家后台整站打不开）
process.on('uncaughtException', e=>{ console.error('[uncaughtException]', (e && e.stack) || e); });
process.on('unhandledRejection', e=>{ console.error('[unhandledRejection]', (e && e.stack) || e); });
function saveOrders(){ return withLock(()=> saveKV('orders', orders)); } // 仅作整批备份残留，下单/状态变更已改用 saveOrderRow
function saveConfig(){
  clearHtmlCache();
  configDirty = true;
  return withLock(()=> saveKV('config', config, 2))
    .then(r=>{ configReadCache.ts = Date.now(); configDirty = false; return r; })
    .catch(e=>{ configDirty = false; throw e; });
}

// ===== 发货编号：A1-A100, B1-B100, ... 顺序分配，持久化在订单上 =====
const SHIP_CODE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SHIP_CODE_MAX_NUM = 100;
function getUsedShipCodes(){ return new Set(orders.map(o=>o.shipCode).filter(Boolean)); }
function nextShipCode(){
  const used = getUsedShipCodes();
  for(const letter of SHIP_CODE_LETTERS){
    for(let n=1; n<=SHIP_CODE_MAX_NUM; n++){
      const code = letter + n;
      if(!used.has(code)) return code;
    }
  }
  return null; // 2600 个编号用尽
}
function ensureShipCode(order){
  if(!order || order.shipCode) return order && order.shipCode;
  order.shipCode = nextShipCode();
  return order.shipCode;
}

// ===== 产品存储加固：每个产品独立存储为 shop_data 的一行（key=product:<id>）=====
// 旧方案：所有产品塞进 shop_data 的单行(key='products')，产品描述长、数量多后，
// 每次编辑都要 upsert 整个大 JSON，导致保存变慢、Supabase 免费层容易超时/失败。
// 新方案：每个产品 upsert 独立行，单行数据小、写入快，回到秒级保存；排序单独存 product_order。
const dirtyProductIds = new Set();
// 2026-09-20 新增：记录脏行的「改动类型」，决定落库时能不能整行覆盖。
//   'full' = 商家后台保存产品（内容以本地为准，允许整行写）
//   'ops'  = 只改了库存 / 上架状态（下单扣库存、取消恢复、改单、隐藏开关、强制售罄、切波）
//            → 必须以「云端当前行」为基准，只把库存/状态字段盖上去，
//              否则会把商家后台刚保存的名称 / 描述 / SKU 发货明细一起覆盖回旧值。
// 真实故障（2026-09-20）：后台改 SKU 发货明细，提示保存成功，一刷新又变旧、买家端同步不生效。
// 根因：云端 Render 实例 24h 在线，它的内存 products 只在启动时读过一次；
//      顾客下单扣库存时把「整行业旧数据」upsert 回云端，正好盖掉后台刚保存的内容。
const dirtyModes = new Map();
const DIRTY_MODE_RANK = { ops: 1, full: 2 };
function markProductDirty(id, mode){
  if(!id) return;
  dirtyProductIds.add(id);
  const m = mode === 'ops' ? 'ops' : 'full';
  const cur = dirtyModes.get(id);
  if(!cur || DIRTY_MODE_RANK[m] > DIRTY_MODE_RANK[cur]) dirtyModes.set(id, m);
}
// ⚠️ 关键：supabase-js 的查询遇到网络/权限错误**不抛异常**，而是把错误放进返回对象的 error 字段。
// 早期改成分行存储时，新写的 upsert 只套了 withRetry 却没检查 error 字段 —— 一旦 Supabase 免费层
// 抖动（fetch failed）或 RLS 拦截，写入其实没成功，却被当成成功并清掉了 dirtyProductIds，
// 症状正是「后台提示保存成功，一刷新又变回旧数据」。统一封装：解析 error 并抛错，交给重试兜底。
async function sbRun(fn, label, retries, timeoutMs){
  const r = await withRetry(fn, label, retries===undefined?2:retries, timeoutMs);
  if(r && r.error) throw new Error((label||'supabase')+' 失败: '+(r.error.message||JSON.stringify(r.error)));
  return r;
}
// fix52：后台点「上架/隐藏/售罄」这类小操作走这条快速通道——单次 9 秒、试 3 次、失败即换网络路径。
// 为什么：原来沿用 20 秒 × 2 次，加上排序那一次写入，最坏要 80 秒才报错，柒木的感受就是「点不动，过一会儿弹错」。
const OPS_FLUSH_TIMEOUT_MS = 9000;
// fix52：后台点「上架/隐藏/售罄」时把「目标值」记在这里，落库时以它为准。
// 为什么需要：flush 内部要 await 读云端基准、写云端，这期间并发回源可能把内存刷回旧值，
// 直接读内存就会写错。目标值由用户动作确定，不参与任何同步，最可靠。
const opsTargetValue = new Map();
function setOpsTarget(id, patch){
  const cur = opsTargetValue.get(id) || {};
  opsTargetValue.set(id, Object.assign(cur, patch));
}
async function flushDirtyProducts(opts){
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : SB_TIMEOUT_MS;
  const retries = Number(o.retries) > 0 ? Number(o.retries) : 2;
  if(!dirtyProductIds.size) return;
  const ids = Array.from(dirtyProductIds);
  dirtyProductIds.clear();
  clearHtmlCache();
  if(!USE_SUPABASE){
    // 本地模式仍整盘写入 products.json
    await withLock(()=> writeJsonAtomic('products.json', products));
    ids.forEach(id=>dirtyModes.delete(id));
    return;
  }
  // ★ 2026-09-20 关键修复（本文件最重要的一处）★
  // 写库前先取「云端当前行」当基准，按改动类型决定合并范围：
  //   · mode='ops'  → 云端为准，只把库存 / 隐藏 / 强制售罄 盖上去。绝不覆盖名称/描述/SKU发货明细/图片。
  //   · mode='full' → 后台保存产品（内容以本地为准），整行写回。
  // 为什么必须这么做：内存 products 是"写源"，而各实例（尤其 24h 在线的云端 Render 实例）
  // 这份内存只在启动时读过云端。顾客下单扣库存时会整行 upsert，
  // 于是把旧版本的名称/描述/SKU 发货明细一起写回云端 ——
  // 后台刚保存的产品内容被静默覆盖，症状就是「提示保存成功，再点进去还是旧值，买家端也不生效」。
  let cloudRows = new Map();
  try{
    const keys = ids.map(id=>'product:'+id);
    const r = await withRetry(()=>sb.from('shop_data').select('key,value').in('key', keys), 'flushReadBase', 2);
    if(r && r.error) throw new Error(r.error.message || 'read base failed');
    ((r && r.data) || []).forEach(x=>{ if(x && x.key) cloudRows.set(String(x.key).slice('product:'.length), x.value); });
  }catch(e){
    console.error('[flushDirtyProducts] 写前读云端基准失败（本次退化为整行写入）:', e.message);
  }
  // 云端模式：批量 upsert，把 N 次单条网络往返合并为 1 次，显著降低 Supabase 免费层抖动概率
  // fix49：ops 模式但「写前读基准」失败（base 拿不到）时，**绝不能**拿整份本地旧对象覆盖云端
  //（那会把后台刚保存的名称/描述/SKU/图片冲掉）。此时跳过该行、保留为脏行，下次拿到基准再写。
  const opsNoBase = [];
  const rows = ids.map(id=>{
    const local = products.find(x=>x.id===id);
    if(!local) return null;
    let val = local;
    const mode = dirtyModes.get(id) || 'full';
    const base = cloudRows.get(id);
    if(mode === 'ops'){
      if(!(base && typeof base==='object' && !Array.isArray(base))){
        opsNoBase.push(id);
        return null;
      }
      // 以云端最新行为基准，只覆盖本次真正改动的"操作类字段"
      // fix52：优先用「操作时记下的目标值」——await 期间可能有并发回源/同步把内存刷回旧值，
      // 那样写进云端的就不是柒木刚点的那个状态（症状：点了开关，提示成功，但状态没变）。
      const ov = opsTargetValue.get(id) || {};
      val = Object.assign({}, base, {
        stock: (ov.stock !== undefined ? ov.stock : local.stock),
        hidden: (ov.hidden !== undefined ? ov.hidden : local.hidden),
        forceSoldOut: (ov.forceSoldOut !== undefined ? ov.forceSoldOut : local.forceSoldOut),
        updatedAt: Date.now()
      });
      const localSkus = Array.isArray(local.skus) ? local.skus : [];
      const baseSkus  = Array.isArray(base.skus)  ? base.skus  : [];
      // SKU 只同步库存字段，SKU 名称 / 发货明细 / 独立主图 / 副标题 一律保留云端最新
      val.skus = baseSkus.map(bs=>{
        const ls = localSkus.find(x=>String(x.id)===String(bs.id));
        return (ls && ls.stock!==undefined) ? Object.assign({}, bs, { stock: ls.stock }) : bs;
      });
      // 本地有、云端没有的 SKU（极少见）：保留本地，避免丢 SKU
      localSkus.forEach(ls=>{ if(!val.skus.some(bs=>String(bs.id)===String(ls.id))) val.skus.push(ls); });
    }
    // 让内存也跟上云端内容，避免下一次又拿旧内容去写
    try{ if(val !== local) Object.assign(local, val); }catch(_){}
    return { key:'product:'+id, value:val };
  }).filter(Boolean);
  const failed = [];
  opsNoBase.forEach(id=>failed.push(id));   // 未写入的行 → 计入失败：保留脏行 + 让上层能感知
  if(rows.length){
    try {
      await sbRun(()=>sb.from('shop_data').upsert(rows), 'saveProductRows:'+rows.length, retries, timeoutMs);
    } catch(e) {
      console.error('[saveProductRows] 批量失败:', e.message);
      ids.forEach(id=>failed.push(id));
    }
  }
  // 注意：只把「真实产品 id」放回脏集，不要把 'product_order' 这个哨兵值塞进去
  //（旧写法会污染脏集，让 getProducts 误判"有未落库脏行"而一直返回内存旧副本）
  failed.forEach(id=>dirtyProductIds.add(id));
  // ★ fix52 关键解耦 ★ 排序是「显示顺序」，跟产品本身的存没存上是两件事。
  // 以前排序写失败会把整个操作判为失败 —— 柒木看到「保存失败」，可产品其实早写进去了，
  // 于是反复点、反复报错（"点上架点不动，过一会儿弹错"就是这么来的）。
  // 现在：只记日志 + 留待下次自然重试，绝不影响产品保存结果、绝不给用户报假失败。
  let orderSaveFailed = false;
  try {
    await saveProductOrder(false, timeoutMs, retries);
  } catch(e) {
    orderSaveFailed = true;
    console.warn('[saveProductOrder] 排序暂未保存（不影响产品本身，下次自动重试）:', e.message);
  }
  // 关键修复：云端写入失败必须让前端知道。同时把当前内存整盘写一份本地 products.json 作为备份，
  // 避免"前端显示成功但重启后数据丢失"。
  if(failed.length){
    await withLock(()=> writeJsonAtomic('products.json', products)).catch(err=>console.error('[local backup] 失败:', err.message));
    throw new Error('云端保存失败（' + failed.join(', ') + '），已写本地备份，请检查网络后重试');
  }
  ids.forEach(id=>dirtyModes.delete(id));   // 只有全部写成功才清掉改动类型
  ids.forEach(id=>opsTargetValue.delete(id));   // 目标值已落库，清掉
  if(orderSaveFailed) console.warn('[flush] 产品已保存，仅显示顺序未同步');
  // ⚠️ 写入成功后必须让 productReadCache 立即看到最新内存，否则切波/保存后买家端可能还在用旧隐藏状态。
  productReadCache = { ts: Date.now(), value: products.slice(), promise: null, failed: false };
}
// 排序行写入：fix52 两处加固
//  ① 只在顺序真的变了才写（点「上架/隐藏」跟顺序无关，不该每次都多发一次网络往返，那是失败面最大的一环）；
//  ② 以云端现有 order 为基准合并，本地内存不全（如启动时云端没读到、只有 37 条）时不会把排序写成短的。
let lastOrderFingerprint = '';
async function saveProductOrder(force, timeoutMs, retries){
  if(!USE_SUPABASE) return;
  const order = products.map(p=>p.id).filter(Boolean);
  const fp = order.join(',');
  if(!force && fp && fp === lastOrderFingerprint) return;
  let merged = order;
  try {
    const { data } = await sb.from('shop_data').select('value').eq('key','product_order').maybeSingle();
    const cloud = (data && Array.isArray(data.value)) ? data.value : [];
    const extra = cloud.filter(id=>!order.includes(id));
    if(extra.length) merged = order.concat(extra);
  } catch(_){}
  // 关键修复：必须检查 error 字段，否则排序写入失败会被静默吞掉（supabase-js 不抛异常）
  await sbRun(()=>sb.from('shop_data').upsert({ key:'product_order', value:merged }), 'saveProductOrder', retries, timeoutMs);
  lastOrderFingerprint = merged.join(',');
}
async function loadProductsFromRows(fallback=[]){
  if(!USE_SUPABASE) return readJson('products.json', fallback);
  // 1) 读取所有 product:* 独立行
  const { data, error } = await sb.from('shop_data').select('key,value').like('key','product:%');
  if(error) throw error;
  let rows = [];
  if(data) rows = data.map(r=>r.value).filter(Boolean);
  // 2) 尚无独立行：迁移旧 products 大数组
  if(!rows.length){
    const old = await loadKV('products', fallback);
    const arr = Array.isArray(old) ? old : fallback;
    if(arr.length){
      console.log('[migrate] 拆分旧 products 大数组为', arr.length, '条独立行');
      for(const p of arr){
        if(!p || !p.id) continue;
        // 关键修复：迁移旧大数组时也检查 error 字段
        await sbRun(()=>sb.from('shop_data').upsert({ key:'product:'+p.id, value:p }), 'migrateProduct:'+p.id);
      }
      rows = arr.slice();
      await saveProductOrder();
    }
  }
  // 3) 读取排序
  let order = [];
  try {
    const { data: orderData, error: orderErr } = await sb.from('shop_data').select('value').eq('key','product_order').maybeSingle();
    if(!orderErr && orderData && Array.isArray(orderData.value)) order = orderData.value;
  } catch(e){ console.error('[loadProductsFromRows] 读排序失败', e.message); }
  // 4) 按 order 排序，不在 order 中的排后面
  const map = new Map(rows.map(p=>[p.id, p]));
  const result = [];
  order.forEach(id=>{ if(map.has(id)){ result.push(map.get(id)); map.delete(id); } });
  map.forEach(p=>result.push(p));
  return result;
}
async function deleteProductRow(id){
  if(!USE_SUPABASE){ await withLock(()=> writeJsonAtomic('products', products)); return; }
  await withRetry(()=>sb.from('shop_data').delete().eq('key','product:'+id), 'deleteProductRow:'+id).catch(e=>console.error('[deleteProductRow]', id, e.message));
  await saveProductOrder().catch(e=>console.error('[saveProductOrder:delete]', e.message));
}
// 兼容旧 saveProducts：本地模式整盘写；云端模式 flush 所有脏行
function saveProducts(){ clearHtmlCache(); return withLock(async()=>{ products.forEach(p=>markProductDirty(p.id)); return flushDirtyProducts(); }); }
// 防抖产品保存：把多个库存扣减合并到一个 500ms 窗口，再批量逐行落盘
let _prodSaveTimer = null;
function saveProductsDebounced(){
  if(_prodSaveTimer) return;
  _prodSaveTimer = setTimeout(async()=>{
    _prodSaveTimer = null;
    await flushDirtyProducts().catch(e=>console.error('[saveProductsDebounced]', e.message));
  }, 500);
}
// 产品读取：内存即权威，但保留云端回源能力（顾客端 Render 副本来之，需看到后台改动）
// 关键修复：若存在"尚未落云的脏编辑"（dirtyProductIds 非空），直接返回内存版本，
// 绝不用云端旧值覆盖，避免"保存成功但刷新后变回旧数据"的假象（Supabase 抖动导致单行 flush 偶败时尤甚）。
// 无脏行时回源云端读取（含 product_order 排序），保证顾客端最多延迟一次轮询即可看到最新。
// 性能修复：为产品读集合加 3 秒 TTL + 并发去重缓存。以前每个商品详情页/首页/列表都全量回源一次
// Supabase，Render 免费实例冷启动/回源慢时页面白屏 3-4 秒。加上缓存后，同一 3 秒窗口内的多次读
// 只回源一次，其余走内存快照秒开；后台保存产品会经 flushDirtyProducts->clearHtmlCache 一并失效。
const PRODUCT_READ_TTL_MS = 3000;
let productReadCache = { ts: 0, value: products, promise: null, failed: false };
async function getProducts(){
  if(!USE_SUPABASE) return products;
  if(dirtyProductIds.size) return products;
  const now = Date.now();
  if(productReadCache.promise) return productReadCache.promise;   // 同窗口并发的回源共享在途请求
  if(productReadCache.ts > 0 && productReadCache.value && now - productReadCache.ts < PRODUCT_READ_TTL_MS && !productReadCache.failed) return productReadCache.value;
  const promise = (async()=>{
    try{
      const list = await withRetry(()=>loadProductsFromRows(products), 'loadProducts', 2);
      // ★ 2026-09-20 修复：把云端最新内容同步进「写源」内存 products（就地合并，保留对象引用）。
      // 以前这里只更新 productReadCache（读缓存），从不更新 products，而 flushDirtyProducts 是拿
      // products 里的对象整行 upsert —— 于是一个内存长期不刷新的实例（尤其 24h 在线的云端实例）
      // 在顾客下单扣库存时会把"旧版本整行"写回云端，静默覆盖商家后台刚保存的产品内容。
      // 症状：后台提示保存成功，再点进去还是旧值，买家端同步不生效。
      if(!dirtyProductIds.size) applyFreshProductList(list);
      productReadCache = { ts: Date.now(), value: products.slice(), promise: null, failed: false };
      return productReadCache.value;
    }catch(e){
      console.error('[getProducts] 读云端失败，使用内存副本：', e.message);
      productReadCache = { ts: Date.now(), value: products, promise: null, failed: true };
      return products;
    }
  })();
  productReadCache.promise = promise;
  const result = await promise;
  productReadCache.promise = null;
  return result;
}
// 把云端最新产品内容合并进内存写源。就地 Object.assign 保留原有对象引用，
// 避免打断正在进行中的库存扣减（那些地方是同步 mutate products 里的对象）。
function applyFreshProductList(list){
  if(!Array.isArray(list) || !list.length) return;
  const byId = new Map(products.map(p=>[p.id, p]));
  const next = [];
  for(const f of list){
    if(!f || !f.id) continue;
    const cur = byId.get(f.id);
    if(cur){ Object.assign(cur, f); next.push(cur); }
    else next.push(f);
  }
  if(!next.length) return;
  if(next.length !== products.length || next.some((p,i)=>p!==products[i])){
    products.length = 0;
    for(const p of next) products.push(p);
  }
}
// ===== 配置回源（与 getProducts 同策略）=====
// 云端买家端(Render)与本机商家后台(4301)共用同一 Supabase。config 若只在启动时读一次，
// 本机后台切波/改公告后云端永远读的是旧值 —— 症状正是「后台点了应用，买家端毫无变化」。
// 这里每 3 秒回源一次；原地 Object.assign 保持 config 引用不变，避免打断正在进行的写入。
let configReadCache = { ts: 0, promise: null };
let configDirty = false;   // 正在写 config（切波/保存设置）时置 true，防止后台回源把内存改动冲掉
const CONFIG_READ_TTL_MS = 3000;
function cfgSafe(c){ return (c && typeof c==='object' && !Array.isArray(c)) ? c : {}; }
async function getConfig(){
  if(!USE_SUPABASE) return config;
  if(configDirty) return config;   // 有未落库的本地改动（正在切波/保存设置）→ 绝不回源覆盖
  if(configReadCache.promise) return configReadCache.promise;
  const now = Date.now();
  if(configReadCache.ts > 0 && now - configReadCache.ts < CONFIG_READ_TTL_MS) return config;
  const p = (async()=>{
    try{
      const fresh = await loadKV('config', config);
      // ⚠️ 回源落地前必须再判一次 configDirty：否则「本机刚切好波次、正在写云端」的这几秒里，
      //    后台快照轮询会把内存 config 覆盖回旧值 → activeWave 丢失（买家端分类栏/倒计时错乱）。
      if(!configDirty && fresh && typeof fresh==='object' && !Array.isArray(fresh)) Object.assign(config, fresh);
    }catch(e){
      console.error('[getConfig] 读云端失败，使用内存副本：', e.message);
    }
    configReadCache.ts = Date.now();
    return config;
  })();
  configReadCache.promise = p;
  const r = await p;
  configReadCache.promise = null;
  return r;
}
// 写操作前把内存产品列表与云端对齐：本机后台（或另一个实例）改了产品后，本实例内存会过期；
// 若直接基于过期内存做"隐藏/切波"，会把旧数据整行写回、覆盖别人的修改（也会造成"无差异→空操作"）。
async function syncProductsFromCloud(){
  if(!USE_SUPABASE) return;
  if(dirtyProductIds.size) return; // 有未落库的本地改动，先不回源，避免丢改动
  try{
    const fresh = await loadProductsFromRows(products);
    if(Array.isArray(fresh) && fresh.length){
      products.length = 0;
      for(const x of fresh) products.push(x);
      productReadCache = { ts: Date.now(), value: products, promise: null, failed: false };
    }
  }catch(e){ console.error('[syncProducts] 回源失败:', e.message); }
}
// 后台重试：Supabase 免费层偶发 fetch failed 时，单行 flush 可能失败；每 5s 把残留脏行再刷一次，
// 确保最终一致，且管理员界面因 getProducts 优先返回内存脏行而不受影响。
setInterval(async ()=>{
  if(USE_SUPABASE && dirtyProductIds.size){
    await flushDirtyProducts().catch(e=>console.error('[bg flush] 残留脏行重试失败：', e.message));
  }
}, 5000);

// 订单读取：内存副本即权威（下单/状态变更实时更新内存，启动已从 order:* 独立行聚合载入），
// 后台即时看到最新订单，无需再读旧 orders 大数组行（已废弃）。
function getOrders(){ return orders; }
// 订单发货明细兜底：历史订单下单时 SKU 未配 bundleItems 会存成空数组，
// 返回给前端时按 产品/SKU 反查当前配置补齐（只补响应，不回写云端存储的原始订单）
function enrichOrderBundles(o){
  if(!o || !Array.isArray(o.items)) return o;
  const items = o.items.map(i=>{
    if(!i || (Array.isArray(i.bundleItems) && i.bundleItems.length)) return i;
    const p = products.find(p=>p.id===i.id);
    if(!p) return i;
    let bi = Array.isArray(p.bundleItems) ? p.bundleItems.slice() : [];
    if(Array.isArray(p.skus) && p.skus.length){
      const sku = (i.skuId && p.skus.find(s=>String(s.id)===String(i.skuId)))
        || p.skus.find(s=>i.skuName && s.name===i.skuName)
        || p.skus.find(s=>i.name && s.name && i.name.includes(s.name))
        || p.skus[0];
      if(sku && Array.isArray(sku.bundleItems) && sku.bundleItems.length) bi = sku.bundleItems.slice();
    }
    return bi.length ? { ...i, bundleItems: bi } : i;
  });
  return { ...o, items };
}
// 后台/管理端想强制从云端复核时调用：重新聚合 order:* 独立行（不阻塞常规读路径）
// ★ 性能加固（2026-09-18 压测）：订单上千时全量聚合要 1.5s+。而「确认收款/改备注/发货」等
//   单笔接口原来每次都全量复核 → 300 单要 6~9 分钟。现改为：
//   ① 全量刷新做节流（SYNC_TTL 内复用，避免连续调用打爆）；
//   ② 单笔操作改用 refreshOrderOne(id) 只读这一行（≈100ms）。
const SYNC_TTL_MS = 1500;
let _ordersSyncAt = 0, _ordersSyncPromise = null;
async function refreshOrdersFromCloud(force){
  if(!USE_SUPABASE) return orders;
  if(!force && _ordersSyncPromise) return _ordersSyncPromise;
  if(!force && _ordersSyncAt && Date.now() - _ordersSyncAt < SYNC_TTL_MS) return orders;
  _ordersSyncPromise = (async()=>{
    try{
      const { data, error } = await sb.from('shop_data').select('key,value').like('key','order:%');
      if(!error && data) orders = data.map(r=>r.value).filter(Boolean);
      _ordersSyncAt = Date.now();
    }catch(e){ console.error('[refreshOrdersFromCloud]', e.message); }
    finally{ _ordersSyncPromise = null; }
    return orders;
  })();
  return _ordersSyncPromise;
}

// 只复核一笔订单（单笔写操作前用，避免全量聚合）
async function refreshOrderOne(id){
  if(!USE_SUPABASE || !id) return null;
  try{
    const { data, error } = await sb.from('shop_data').select('value').eq('key','order:'+id).maybeSingle();
    if(error || !data || !data.value) return null;
    const fresh = data.value;
    const idx = orders.findIndex(o=>o.id===id);
    if(idx>=0) orders[idx] = fresh; else orders.push(fresh);
    kvCache.set('order:'+id, { ts:Date.now(), value:fresh, promise:null });
    return fresh;
  }catch(e){ return null; }
}
// 订单写入前必须先刷新内存副本：手机端在云端下的订单，本地服务内存里可能没有，
// 直接 find 内存会 404 静默失败（症状：后台点"确认收款"提示成功但状态不变）
// ⚠️ 严禁用 loadKV('orders', ...)：那是已废弃的「旧大数组」行，长期不更新——发货管家对
//    order:<id> 单行的改动（已发货+tracking）从不同步回这个大数组，读到的是一份过期快照。
//    若用它刷新再写回，会把「已发货」用旧的「待发货」整单覆盖回去，造成状态回退 bug
//    （订单从已发货自动跳回待发货、tracking 被清空 → 重复发货风险）。必须按 order:* 单行重新聚合。
async function syncOrders(){
  if(!USE_SUPABASE) return orders;
  try { orders = await refreshOrdersFromCloud(); }
  catch(e){ console.error('[syncOrders] 同步云端失败，继续使用内存副本：', e.message); }
  return orders;
}

// 产品写入前同步：下单扣库存必须基于云端最新数据，防止 Render 内存副本过期把库存扣错
async function syncProducts(){
  if(!USE_SUPABASE) return products;
  try { products = await loadProductsFromRows(products); }
  catch(e){ console.error('[syncProducts] 同步云端失败：', e.message); }
  return products;
}

// ---------- 工具 ----------
function htmlEscape(s){ return String(s==null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function jsonForScript(obj){ return JSON.stringify(obj).replace(/</g,'\\u003c'); }
function absUrl(src, base){
  if(!src) return '';
  const s = String(src);
  if(/^https?:\/\//i.test(s)) return s;
  if(s.startsWith('//')) return 'https:' + s;
  return base + (s.startsWith('/') ? s : '/' + s);
}
function inferShareImage(p){
  if(p.shareImage) return p.shareImage;
  const img = p.image || '';
  if(!img) return '';
  if(/\.svg$/i.test(img)) return ''; // svg 在聊天客户端常抓不到，留空更安全
  return img;
}
// 店铺分享图选择：config.shareImage 优先 https -> 第一个产品 HTTPS 公网图 -> 空
function pickShopShareImage(list){
  const cfg = (config.shareImage||'').toString().trim();
  if(/^https:\/\//i.test(cfg)) return cfg;
  for(const p of list||[]){
    const url = (p.image || p.cover || '').toString().trim();
    if(/^https:\/\//i.test(url)) return url;
  }
  return '';
}
function genId(){
  let id;
  do { id = crypto.randomBytes(4).toString('hex').toUpperCase(); }
  while(orders.find(o=>o.id===id));
  return id;
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  '.json':'application/json; charset=utf-8', '.ico':'image/x-icon'
};

function sendFile(res, filePath){
  fs.readFile(filePath, (err, buf)=>{
    if(err){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    // 静态资源加长缓存：减少活动期间 Render 免费实例的重复请求（图片/字体 7 天，js/css 1 天）
    const IMG_EXT = ['.png','.jpg','.jpeg','.webp','.gif','.svg','.ico','.woff','.woff2','.ttf','.otf'];
    const JS_EXT  = ['.js','.css','.mjs'];
    const cc = IMG_EXT.includes(ext) ? 'public, max-age=604800'
             : JS_EXT.includes(ext)  ? 'public, max-age=86400'
             : 'no-store';
    res.writeHead(200, {'Content-Type': MIME[ext]||'application/octet-stream', 'Cache-Control': cc});
    res.end(buf);
  });
}

// 读取请求体。⚠️ 超限必须 reject（旧版只 req.destroy() 不 reject，导致请求永远挂起、前端一直转圈）
const MAX_BODY_BYTES = 20 * 1024 * 1024;   // 20MB（前端图片已压缩，正常几百 KB）
function readBody(req){
  return new Promise((resolve,reject)=>{
    let data='', size=0, done=false;
    req.on('data', c=>{
      if(done) return;
      size += c.length;
      if(size > MAX_BODY_BYTES){
        done = true;
        try{ req.destroy(); }catch(e){}
        reject(new Error('请求体过大（超过 ' + Math.round(MAX_BODY_BYTES/1048576) + 'MB），请压缩图片后重试'));
        return;
      }
      data+=c;
    });
    req.on('end', ()=>{ if(!done){ done=true; resolve(data); } });
    req.on('error', e=>{ if(!done){ done=true; reject(e); } });
  });
}

function renderTemplate(name, vars){
  const tpl = fs.readFileSync(path.join(VIEWS, name), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k)=> (vars[k]!==undefined ? vars[k] : m));
}

// ---------- 页面渲染缓存 ----------
// 让微信/QQ/TIM 等爬虫与真实用户秒开页面：避免「冷启动 + 每次打云端 Supabase」导致首页十几秒、
// 微信爬虫超时直接退化为纯文字链接、抓不到 OG 大图卡片。
// 后台改完产品/配置会主动清缓存（见 saveProducts/saveConfig），兼顾新鲜度与速度。
const htmlCache = new Map();     // key -> { html, ts, fp }
// 页面缓存是「跨请求共享」的，所以 OG 里的站址必须用固定的公网正式域名，
// 不能再用每个请求的 Host（否则会把 A 域名渲染出来的页面发给 B 域名）。
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://buchu-shop.onrender.com').replace(/\/+$/,'');
const htmlInflight = new Map();  // key -> Promise<string>：同一页面同一时刻只允许一次渲染（请求合并）
let htmlGen = 0;                 // 缓存代次：后台改数据后 +1，让"改动前发起的渲染"结果作废
const HTML_REFRESH_MAX = 10 * 60 * 1000;      // 兜底：指纹没变也最多 10 分钟后台刷一次
const HTML_STALE_MAX   = 6 * 60 * 60 * 1000;  // 旧页面最多留 6 小时当兜底，超了就重新渲染
const RENDER_WAIT_MAX  = 5000;                // 数据变了时单个访客最多等渲染多久（超时先给旧页，渲染继续）
const waitMs = ms => new Promise(r => { const t = setTimeout(r, ms); if(t && t.unref) t.unref(); });
const PAGE_MISSING = '\u0001__page_missing__';  // 详情页不存在/已隐藏的哨兵值（也缓存，避免反复查库）

// ★★★ 页面缓存铁律（2026-09-18 踩坑后重写，改这里之前请看完）★★★
// ① 一次「全量渲染」= 读 Supabase + 渲染 230KB 模板，本地 2.9 秒，线上 0.1 核要十几秒
//    → 绝不能让 N 个并发各自渲染一次，必须用 single-flight 合并。
// ② 但**绝不能只靠固定 TTL 判断页面是否该刷新**：
//    本机商家后台(4301) 和云端(Render) 是**两个进程**、共用同一个 Supabase。
//    本机改完产品，云端那个进程根本不知道数据变了 → 买家端会一直看到旧页面。
//    曾经写成「60 秒 TTL + stale-while-revalidate」，而且回写条件写成 `!htmlCache.has(key)`，
//    导致后台刷新出来的新页面被直接丢弃 → **买家端彻底不再更新**（这是 2026-09-18 的真实故障）。
// ③ 正确做法：**缓存是否有效由「数据指纹」决定，而不是时间**；而且指纹必须**纯内存算**
//    · 指纹没变 → 直接命中（零网络等待；最多 10 分钟兜底后台刷一次）
//    · 指纹变了 → 立刻返回旧页面（访客不用等），同时后台只刷新一次，几秒后全站就都是新的
//    · 完全没有旧页面 → 并发请求共享同一份在途渲染
//    ⚠️ 指纹里**绝对不能 await 读 Supabase**：那样每个请求都要多等一次网络往返（本机 1~4 秒），
//       页面缓存就白做了。内存快照由 refreshSnapshotInBackground() 在后台保持新鲜。
function peekHtml(key, maxAge){
  const c = htmlCache.get(key);
  return (c && Date.now() - c.ts < maxAge) ? c.html : null;
}
function getCachedHtml(key){ return peekHtml(key, HTML_REFRESH_MAX); }
function setCachedHtml(key, html){ if(html) htmlCache.set(key, { html, ts: Date.now(), fp: '' }); }
function clearHtmlCache(){
  htmlGen++;
  // 本实例刚改完数据 → **直接删掉缓存**，让下一个访客渲染出最新页面（本机约 3 秒）。
  // ⚠️ 别改成"只把指纹置空、保留旧 HTML"：那样商家点完「应用到买家端」第一眼看到的还是旧页面，
  //    会被当成"改了不生效 / 不稳定"（2026-09-18 真实反馈：切换波次后买家端仍显示全部产品）。
  htmlCache.clear();
  productReadCache = { ts: 0, value: products, promise: null, failed: false };
}

// ★★ 数据指纹：**纯内存计算，绝不允许在这里 await 读网络** ★★
// 为什么强调：这里每个页面请求都会走一次。一旦写成 `await getProducts()`，
// 每个「距上次校验超过节流窗口」的请求都要多等一次 Supabase 往返（本机 1~4 秒），
// 页面缓存等于白做。所以指纹只读**内存快照**：
//   · products 的权威快照 = productReadCache.value（getProducts 每 3 秒回源更新一次）
//   · config 由 getConfig() 原地 Object.assign 更新
// 内存快照靠 refreshSnapshotInBackground() 在后台保持新鲜（不阻塞任何请求）。
function computeFingerprint(){
  let h = 2166136261;
  const mix = s => { s = String(s == null ? '' : s); for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } };
  try{
    const list = (productReadCache.value && productReadCache.value.length) ? productReadCache.value : products;
    mix(JSON.stringify(list));
    mix(JSON.stringify(cfgSafe(config)));
  }catch(e){}
  return (h >>> 0).toString(36);
}

// 后台把内存快照刷新到最新：请求触发 + 3 秒节流 + 单飞，**不阻塞当前请求**。
let snapAt = 0, snapping = null;
const SNAP_TTL_MS = 3000;
function refreshSnapshotInBackground(){
  if(snapping) return;
  if(Date.now() - snapAt < SNAP_TTL_MS) return;
  snapAt = Date.now();
  snapping = (async()=>{
    try{ await getProducts(); await getConfig(); }catch(e){}
    finally{ snapping = null; }
  })();
}
// 没人访问时也让快照保持新鲜（每 2.5 秒一次）——这决定了「后台改完 → 买家端自动变新」的时延：
// 约 2.5 秒（发现变化）+ 一次渲染（本机约 1~3 秒）= 通常 4~6 秒。
if(USE_SUPABASE) setInterval(()=>{ refreshSnapshotInBackground(); }, 2500);

async function renderPageCached(key, build){
  refreshSnapshotInBackground();     // 只让后台去回源，绝不让访客等
  const fp  = computeFingerprint();  // 纯内存，微秒级
  const cur = htmlCache.get(key);
  // ① 数据没变（且未超过 10 分钟兜底窗口）→ 直接命中
  if(cur && cur.fp && cur.fp === fp && Date.now() - cur.ts < HTML_REFRESH_MAX) return cur.html;
  const startRender = ()=>{
    const gen = htmlGen, startedAt = Date.now();
    const p = Promise.resolve()
      .then(build)
      .then(h=>{
        if(!h || gen !== htmlGen) return h;
        const now = htmlCache.get(key);
        // ★ 只有「比本次渲染更早写入」的缓存才允许被覆盖。
        //   旧写法是 `!htmlCache.has(key)` —— 而「先给旧页、后台刷新」时缓存里一直有旧页，
        //   于是新渲染结果永远写不进去，买家端就永远停在旧页面。别再改回去。
        if(!now || !now.fp || now.ts <= startedAt) htmlCache.set(key, { html:h, ts:Date.now(), fp });
        return h;
      })
      .catch(e=>{ console.error('[renderPage]', key, e.message); return null; })
      .finally(()=>{ if(htmlInflight.get(key) === p) htmlInflight.delete(key); });
    htmlInflight.set(key, p);
    return p;
  };
  const inflight = htmlInflight.get(key);
  // ② 数据变了 / 没有缓存 → 渲染（并发合并成一份）。渲染期间最多等 RENDER_WAIT_MAX，
  //    等不到就先给旧页面（渲染继续在后台跑，下一个访客就能拿到新页面）。
  //    ⚠️ 这里**不能直接返回旧页面**：商家点完「应用到买家端」马上刷新时，
  //       第一眼必须是新的 —— 否则就会被当成"改了不生效 / 不稳定"（2026-09-18 真实反馈）。
  const p = inflight || startRender();
  if(!cur) return p;                                   // 完全没有旧页面：必须等渲染
  const done = await Promise.race([ p, waitMs(RENDER_WAIT_MAX).then(()=>null) ]);
  return done || cur.html;
}

// 首页渲染（供缓存与开机预热共用）
async function buildHomeHtml(){
  const list = await getProducts();
  const ogImage = pickShopShareImage(list);
  const safeConfig = { ...DEFAULT_CONFIG, ...cfgSafe(await getConfig()) };
  const html = renderTemplate('home.html', {
    SHOP_NAME: htmlEscape(safeConfig.shopName),
    OG_TITLE: htmlEscape(safeConfig.shopName),
    OG_DESC: htmlEscape(safeConfig.announcement || '不初限时狂欢商城 · 全场超低价回馈老客户'),
    OG_IMAGE: htmlEscape(absUrl(ogImage, PUBLIC_BASE)),
    OG_URL: htmlEscape(PUBLIC_BASE + '/'),
    PRODUCTS_JSON: jsonForScript(localizeProducts(list)),
    CONFIG_JSON: jsonForScript(safeConfig)
  });
  return html.replace(/<meta (?:property|name)="(?:og:[^"]+|twitter:[^"]+|product:[^"]+)" content="">\n?/g, '');
}

// 详情页渲染（供缓存与开机预热共用）。不存在/已隐藏返回 PAGE_MISSING 哨兵
async function buildProductHtml(pid, urlWave){
  const list = await getProducts();
  const p = list.find(x=>x.id===pid);
  if(!p) return PAGE_MISSING;
  const cfgNow = await getConfig();
  const hiddenCats = Array.isArray(cfgNow.hiddenCategories)?cfgNow.hiddenCategories:[];
  // 波次直链：?wave=w2 时，即使全局隐藏也允许显示该波商品（与首页一致）
  let inUrlWave = false;
  if(urlWave){
    const wv = String(urlWave).split(',').map(s=>s.trim()).filter(Boolean).filter(s=>['w1','w2','w3','w4','none'].includes(s));
    if(wv.length){
      if(wv.includes('none')) inUrlWave = true;
      else{
        const pre = wv.map(w=>({w1:'w1g',w2:'w2g',w3:'w3g',w4:''}[w])).filter(Boolean);
        if(pre.some(pr=>!pr)) inUrlWave = true;
        else { const g=String(p.waveGroup||'').trim(); if(g && pre.some(pr=>g.indexOf(pr)===0)) inUrlWave = true; }
      }
    }
  }
  // 当前生效波次（config.activeWave）：本波商品即使内存里的 hidden 标记还是旧的/没刷新完，
  // 也必须能打开 —— 根治「切第二波/第三波后点商品说'商品不存在'」这类白页。
  let inActiveWave = false;
  {
    const aw = String(cfgNow.activeWave||'').split(',').map(s=>s.trim()).filter(Boolean);
    if(aw.length){
      const preA = aw.map(w=>({w1:'w1g',w2:'w2g',w3:'w3g',w4:''}[w]));
      if(aw.includes('none') || preA.some(pr=>pr==='')) inActiveWave = true;
      else { const g=String(p.waveGroup||'').trim(); if(g && preA.filter(Boolean).some(pr=>g.indexOf(pr)===0)) inActiveWave = true; }
    }
  }
  if(!inUrlWave && !inActiveWave && (p.hidden || (p.category && hiddenCats.includes(p.category)))) return PAGE_MISSING;
  const ogImage = inferShareImage(p) || pickShopShareImage(list);
  const safeConfig = { ...DEFAULT_CONFIG, ...cfgSafe(cfgNow) };
  const html = renderTemplate('product.html', {
    SHOP_NAME: htmlEscape(safeConfig.shopName),
    OG_TITLE: htmlEscape(p.name),
    OG_DESC: htmlEscape(String(p.desc||'').replace(/<[^>]+>/g,'').slice(0,200) || safeConfig.shopName),
    OG_IMAGE: htmlEscape(absUrl(ogImage, PUBLIC_BASE)),
    OG_URL: htmlEscape(PUBLIC_BASE + '/product/'+p.id),
    OG_PRICE: htmlEscape(p.price || ''),
    HERO_IMAGE: htmlEscape(thumbImg(p.image, 800, 1000, 75) || '/assets/product-placeholder.svg'),
    PRODUCT_JSON: jsonForScript(localizeProduct(p)),
    PRODUCTS_JSON: jsonForScript(localizeProducts(list)),
    CONFIG_JSON: jsonForScript(safeConfig)
  });
  return html.replace(/<meta (?:property|name)="(?:og:[^"]+|twitter:[^"]+|product:[^"]+)" content="">\n?/g, '');
}

// 开机预热页面缓存：让「服务刚醒来的第一个访客」也不用等渲染（Render 免费实例冷启动后尤其关键）
async function warmHtmlCache(){
  if(process.env.NO_PREWARM) return;
  try{
    const t0 = Date.now();
    await renderPageCached('home', buildHomeHtml);
    const list = await getProducts();
    const cfgNow = await getConfig();
    const hiddenCats = Array.isArray(cfgNow.hiddenCategories)?cfgNow.hiddenCategories:[];
    const ids = list.filter(p=>!p.hidden && !(p.category && hiddenCats.includes(p.category))).map(p=>p.id);
    let n = 0;
    for(const id of ids){
      try{ await renderPageCached('product:'+id, ()=>buildProductHtml(id)); n++; }catch(e){}
      await new Promise(r=>setTimeout(r,0));
    }
    console.log('[html prewarm] 已预热首页 +', n, '个详情页，共', htmlCache.size, '页，用时', Date.now()-t0, 'ms');
  }catch(e){ console.error('[html prewarm]', e.message); }
}

// ---------- 图片加速（本域代理 + 进程内缓存 + 长缓存头） ----------
// 根因：Supabase Storage 的 public 对象返回 Cache-Control: no-cache，浏览器/微信每次都要回源，
// 手机上单张主图要等 3~5 秒。这里统一走 /img/ 代理，并在本地缓存字节 + 下发 7 天强缓存，
// 同一张图第二次起（含微信内置浏览器、其他买家）直接命中，不再回源。
const imgCache = new Map(); // key -> { buf, type }
const IMG_CACHE_MAX = 300;
// fix51（2026-09-22）：图片再加一层「磁盘缓存」。内存缓存一重启就没了，
// 扛不住本机到境外反复抖动（症状：后台 39 张主图集体变「暂无图片」）。落盘后只要成功拉到过一次就永远有图。
const IMG_DISK = path.join(ROOT, '.imgcache');
const IMG_DISK_MAX = 800; // 磁盘缓存最多保留张数，超出按最久写入清理
let _imgDiskReady = false;
try { fs.mkdirSync(IMG_DISK, { recursive: true }); _imgDiskReady = true; } catch(e){ _imgDiskReady = false; }
function imgDiskPath(k, ext){ return path.join(IMG_DISK, crypto.createHash('sha1').update(String(k)).digest('hex') + ext); }
function imgDiskRead(k){
  if(!_imgDiskReady) return null;
  try{
    const b = imgDiskPath(k, '.bin');
    if(!fs.existsSync(b)) return null;
    const buf = fs.readFileSync(b);
    if(!buf || !buf.length) return null;
    const c = imgDiskPath(k, '.ct');
    const type = fs.existsSync(c) ? (fs.readFileSync(c, 'utf8').trim() || 'image/jpeg') : 'image/jpeg';
    return { buf, type };
  }catch(e){ return null; }
}
function imgDiskWrite(k, buf, type){
  if(!_imgDiskReady || !buf || !buf.length) return;
  try{
    fs.writeFileSync(imgDiskPath(k, '.bin'), buf);
    fs.writeFileSync(imgDiskPath(k, '.ct'), type || 'image/jpeg');
  }catch(e){}
}
function imgDiskPrune(){
  if(!_imgDiskReady) return;
  try{
    const names = fs.readdirSync(IMG_DISK).filter(n => n.endsWith('.bin'));
    if(names.length <= IMG_DISK_MAX) return;
    const rows = names.map(n => { let t = 0; try{ t = fs.statSync(path.join(IMG_DISK, n)).mtimeMs; }catch(e){} return { n, t }; })
                      .sort((a,b) => a.t - b.t);
    rows.slice(0, rows.length - IMG_DISK_MAX).forEach(x => {
      try{ fs.unlinkSync(path.join(IMG_DISK, x.n)); }catch(e){}
      try{ fs.unlinkSync(path.join(IMG_DISK, x.n.replace(/\.bin$/, '.ct'))); }catch(e){}
    });
  }catch(e){}
}
// 回源并发闸：避免一次性几十个请求把 Node undici 连接池占满（会导致整站请求卡死超时）
let imgFetching = 0;
const IMG_MAX_CONCURRENT = 6;
function localImg(u){
  if(!u) return u;
  const m = String(u).match(/\/storage\/v1\/object\/public\/(.+)$/);
  return m ? '/img/' + m[1] : u;
}
// 缩略图 URL：把 /img/... 原图追加 ?w=&h=&q=，交由下方图片代理走 Supabase 转换端点下发小图。
// 仅对 Supabase 公共图生效；本地占位图（/assets/...）原样返回，绝不破坏。
function thumbImg(u, w, h, q){
  const base = localImg(u);
  if(!base || base.indexOf('/img/')!==0) return base;
  const sep = base.indexOf('?')>=0 ? '&' : '?';
  let qry = 'w='+w;
  if(h && Number(h)>0) qry += '&h='+h;
  qry += '&q='+(q||75);
  return base + sep + qry;
}
function localizeProduct(p){
  if(!p || typeof p!=='object') return p;
  const c = Object.assign({}, p);
  if(c.image) c.image = localImg(c.image);
  if(Array.isArray(c.images)) c.images = c.images.map(localImg);
  if(Array.isArray(c.detailImages)) c.detailImages = c.detailImages.map(localImg);
  if(Array.isArray(c.skus)) c.skus = c.skus.map(s=> (s&&typeof s==='object') ? Object.assign({}, s, { image: localImg(s.image) }) : s);
  if(Array.isArray(c.bundleItems)) c.bundleItems = c.bundleItems.map(b=> (b&&typeof b==='object') ? Object.assign({}, b, { image: localImg(b.image) }) : b);
  return c;
}
function localizeProducts(list){ return (list||[]).map(localizeProduct); }
// 开机预热：把全部产品图片预先拉进内存缓存（不阻塞服务启动）。
// ⚠️ 必须「串行 + 单张超时 + 让出事件循环」：早前版本一次性并发几十个 fetch，
//    把 Node undici 连接池占满，导致服务器自身所有请求（含商家后台上传）全部卡死超时。
async function prewarmImages(){
  if(!process.env.SUPABASE_URL) return;
  if(process.env.NO_PREWARM==='1') return;
  try{
    const list = await getProducts();
    const keys = [];
    const seen = new Set();
    for(const p of list){
      const urls = [p.image, ...(p.images||[]), ...(p.detailImages||[]),
        ...(p.skus||[]).map(s=> s&&s.image), ...(p.bundleItems||[]).map(b=> b&&b.image)].filter(Boolean);
      for(const u of urls){
        const m = String(u).match(/\/storage\/v1\/object\/public\/(.+)$/);
        if(!m) continue;
        if(imgCache.has(m[1]) || seen.has(m[1])) continue;
        seen.add(m[1]); keys.push(m[1]);
      }
    }
    let n = 0;
    for(const key of keys){
      if(imgCache.size >= IMG_CACHE_MAX) break;
      try{
        const ctl = new AbortController(); const tm = setTimeout(()=>ctl.abort(), 8000);
        const r = await fetch(process.env.SUPABASE_URL + '/storage/v1/object/public/' + key, { signal: ctl.signal });
        clearTimeout(tm);
        if(r.ok){
          const buf = Buffer.from(await r.arrayBuffer());
          if(imgCache.size < IMG_CACHE_MAX) imgCache.set(key, { buf, type: r.headers.get('content-type') || 'image/jpeg' });
          n++;
        }
      }catch(e){}
      await new Promise(s=>setTimeout(s, 80));   // 让出事件循环，避免拖慢在线请求
    }
    console.log('[img prewarm] 已预热缓存', n, '张图片，共', imgCache.size, '张');
  }catch(e){ console.error('[img prewarm]', e.message); }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res)=>{
  // fix49：boot 最多只等 8 秒。弱网（Supabase 慢/超时时）原来会「连 /admin 都打不开」——
  // 因为每个请求都无上限地 await ensureBoot()。现在超时后先用本地缓存数据响应，boot 在后台继续跑，
  // 跑完（内存刷新）后下一次请求就是最新数据。
  try { await Promise.race([ ensureBoot(), new Promise(r=>setTimeout(r, 8000)) ]); } catch(e){
    console.error('[Boot Error]', e);
    res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'boot_failed', message:e.message})); return;
  }
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch(e){ res.writeHead(400); res.end('bad url'); return; }
  const pathname = decodeURIComponent(u.pathname);
  const method = req.method;
  // 微信要求 og:image / og:url 必须是绝对地址；云端反向代理会带上 x-forwarded-proto
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || ('localhost:'+PORT);
  const BASE = proto + '://' + host;

  try {
    // ===== API =====
    if(pathname.startsWith('/api/')){
      // 商品 / 配置 / 订单列表（只读）
      if(method==='GET' && pathname==='/api/products'){
        const list = await getProducts();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(list)); return;
      }
      // fix46（2026-09-21）：单个产品「云端真值」读取。
      // 后台点「编辑」时先调它：直接读云端 product:<id> 这一行，绕过本实例的内存副本与读缓存，
      // 保证弹窗里显示的一定是数据库里的最新内容（根因：editProduct 原来只读页面内存 PRODUCTS，
      // 内存一旧，就会出现「保存成功、打开还是旧值」）。
      // 若该产品正有待写回的 dirty 标记、或云端瞬时读失败，则回退到内存副本，保证接口永远可用。
      const mGetOneProd = pathname.match(/^\/api\/products\/([\w-]+)$/);
      if(method==='GET' && mGetOneProd){
        const pid = mGetOneProd[1];
        let item = null;
        try{
          if(USE_SUPABASE && sb && !dirtyProductIds.has(pid)){
            const { data, error } = await withRetry(()=>sb.from('shop_data').select('value').eq('key','product:'+pid).maybeSingle(), 'getProductRow:'+pid, 2);
            if(!error && data && data.value) item = data.value;
          }
        }catch(e){ console.error('[GET /api/products/:id] 读云端失败，回退内存副本：', e.message); }
        if(!item) item = products.find(x=>x.id===pid) || null;
        if(!item){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, error:'not_found'})); return; }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, product:item})); return;
      }
      if(method==='GET' && pathname==='/api/config'){
        const out = { ...DEFAULT_CONFIG, ...cfgSafe(await getConfig()) };
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(out)); return;
      }
      if(method==='GET' && pathname==='/api/orders'){
        // 关键：让 /api/orders 始终反映云端最新状态（外部进程如 buchu-ship-cloud
        // 也会写 order:<id> 单行，仅靠内存副本会看不到）
        await refreshOrdersFromCloud();
        const list = await getOrders();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(list.map(enrichOrderBundles))); return;
      }
      // 按姓名/手机号查询订单
      if(method==='GET' && pathname==='/api/orders/lookup'){
        const key = String(u.searchParams.get('key')||'').trim();
        if(!key){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify([])); return; }
        const lower = key.toLowerCase();
        // 关键：买家端查询前先复核云端最新状态（后台在本地 4301 把订单改成已取消，
        // 买家访问线上 Render 实例的内存副本仍是旧状态，不刷新会一直读到待确认）
        await refreshOrdersFromCloud();
        const list = await getOrders();
        const found = list.filter(o=>{
          const nameMatch = (o.name||'').toLowerCase().includes(lower);
          const phoneMatch = (o.phone||'').includes(key);
          return nameMatch || phoneMatch;
        }).sort((a,b)=>b.createdAt-a.createdAt);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(found.map(enrichOrderBundles))); return;
      }
      // 单个订单（供前端恢复「待付款」订单）
      const mOrderApi = pathname.match(/^\/api\/orders\/([\w-]+)$/);
      if(method==='GET' && mOrderApi){
        // 同上：读单个订单前先复核云端，避免读到本实例过期的内存状态
        await refreshOrdersFromCloud();
        const list = await getOrders();
        const o = list.find(o=>o.id===mOrderApi[1]) || null;
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(o?enrichOrderBundles(o):o)); return;
      }
      // 创建订单
      if(method==='POST' && pathname==='/api/orders'){
        let body; try { body = JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        const items = (body.items||[]).filter(it=> it && it.id && Number(it.qty)>0);
        if(!items.length){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'empty'})); return; }
        if(!body.name || !body.phone || !body.address){
          res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'missing_contact'})); return;
        }
        // ★★ fix41 防重复下单（2026-09-18 真实事故）★★
        // 事故：买家手机端一次点击被浏览器/网络连发 29 次 → 凭空生成 29 笔一模一样订单，
        //       每笔都扣了库存（且多是"待付款"），把商品库存直接锁死 / 归零。
        // 规则：同一手机号 + 同一购物车内容，在 15 秒窗口内只认第一单，后续直接返回那一单。
        // 只靠内存 orders 判定（saveOrderRow 是同步入内存的），不新增任何字段、不改数据格式。
        const _sig = (o)=> String(o.phone||'').trim() + '|' +
          (o.items||[]).map(it=>String(it.id)+'#'+String(it.skuId||'')+'x'+Number(it.qty||0)).sort().join(',');
        const _mySig = String(body.phone||'').trim() + '|' +
          items.map(it=>(String(it.id||'').split('#')[0])+'#'+String(it.skuId||(String(it.id||'').split('#')[1]||''))+'x'+Number(it.qty)).sort().join(',');
        const _now = Date.now();
        const _dup = orders.find(o=> o && o.status !== '已取消' && _now - (Number(o.createdAt)||0) < 15000 && _sig(o) === _mySig);
        if(_dup){
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
          res.end(JSON.stringify({ id:_dup.id, deduped:true })); return;
        }
        const detail = items.map(it=>{
          // 兼容旧格式：购物车键可能以 "产品id#SKUid" 形式整体传入
          const rawId = String(it.id||'');
          const split = rawId.split('#');
          const pid = split[0] || rawId;
          const skuIdFromKey = split.length>1 ? split[1] : '';
          const p = products.find(p=>p.id===pid);
          let name = p?p.name:rawId;
          let price = p?p.price:0;
          let image = p?p.image||p.images&&p.images[0]:'';
          let skuId = String(it.skuId || skuIdFromKey || '');
          let skuName = '';
          let skuBundle = [];
          if(p && skuId){
            const sku = (p.skus||[]).find(s=>String(s.id)===skuId);
            if(sku){
              skuName = String(sku.name||'').trim();
              price = Number(sku.price||p.price||0);
              image = String(sku.image||p.image||'').trim() || image;
              skuBundle = Array.isArray(sku.bundleItems)?sku.bundleItems:[];
              if(skuName) name = name + ' · ' + skuName;
            }
          }
          return { id:pid, skuId, skuName, name, price, qty:Number(it.qty), image, bundleItems: skuBundle.length?skuBundle:(p&&p.bundleItems?p.bundleItems:[]) };
        });
        const total = detail.reduce((s,x)=> s + x.price*x.qty, 0);

        // ===== 库存校验与扣减（stock 为数字才限量；null/未填视为不限量）=====
        // 注：products 以内存副本为权威（启动已载入云端最新），不再每单 syncProducts() 往返，
        // 避免 200+ 并发下 read-modify-write 整个数组的 O(n²) 瓶颈；扣减后回写云端。
        // 同一产品/规格的数量先合并（购物车分 key 传入，理论上不重复，双保险）
        const needMap = {};
        detail.forEach(x=>{
          const k = x.skuId ? (x.id+'#'+x.skuId) : x.id;
          needMap[k] = (needMap[k]||0) + x.qty;
        });
        // 校验：库存不足直接拒单
        for(const k in needMap){
          const [pid, skuId] = k.split('#');
          const p = products.find(p=>p.id===pid);
          if(!p) continue;
          const needQty = needMap[k];
          // 商家后台手动强制售罄：直接拒单（不管库存是否充足）
          if(p.forceSoldOut){
            res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({error:'manual_sold_out', message:'「'+p.name+'」已下架，请看看其他宝贝～'})); return;
          }
          if(skuId){
            const sku = (p.skus||[]).find(s=>String(s.id)===skuId);
            if(sku && sku.stock!=null && Number(sku.stock) < needQty){
              res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});
              res.end(JSON.stringify({error:'insufficient_stock', message:'「'+(p.name+' · '+(sku.name||''))+'」库存不足（仅剩'+Number(sku.stock)+'件），请返回商城重新选购或联系夏天老师补货。'})); return;
            }
          } else if(p.stock!=null && Number(p.stock) < needQty){
            res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({error:'insufficient_stock', message:'「'+p.name+'」库存不足（仅剩'+Number(p.stock)+'件），请返回商城重新选购或联系夏天老师补货。'})); return;
          }
        }
        // 扣减（下单即扣，防止超卖）
        let stockDeducted = false;
        for(const k in needMap){
          const [pid, skuId] = k.split('#');
          const p = products.find(p=>p.id===pid);
          if(!p) continue;
          const needQty = needMap[k];
          if(skuId){
            const sku = (p.skus||[]).find(s=>String(s.id)===skuId);
            if(sku && sku.stock!=null){ sku.stock = Math.max(0, Math.floor(Number(sku.stock)) - needQty); stockDeducted = true; markProductDirty(pid, 'ops'); }
          } else if(p.stock!=null){
            p.stock = Math.max(0, Math.floor(Number(p.stock)) - needQty); stockDeducted = true; markProductDirty(pid, 'ops');
          }
        }

        const id = genId();
        const order = {
          id, items:detail, total,
          name:String(body.name).slice(0,50), phone:String(body.phone).slice(0,30),
          address:String(body.address).slice(0,200), wechat:String(body.wechat||'').slice(0,50),
          note:String(body.note||'').slice(0,200),
          status:'待付款', tracking:'',
          stockDeducted, // 标记：本单已扣库存，取消时据此恢复（历史订单无此标记，不回溯）
          createdAt:Date.now(), paidAt:null, confirmedAt:null, shippedAt:null
        };
        saveOrderRow(order); // 批量非阻塞写入（内存即时同步，Supabase 500ms 内批量落盘），下单响应秒回
        if(stockDeducted) saveProductsDebounced(); // 防抖批量落盘：200 并发合并为 1-2 次写入，不阻塞下单响应
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({id})); return;
      }
      // 客户确认已发送付款截图
      const mPaid = pathname.match(/^\/api\/orders\/([\w-]+)\/paid$/);
      if(method==='POST' && mPaid){
        await refreshOrderOne(mPaid[1]); // 只复核这一笔（全量聚合在千单时要 1.5s+）
        const o = orders.find(o=>o.id===mPaid[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        if(o.status==='待付款'){ o.status='待确认'; o.paidScreenshotAt=Date.now(); if(!o.paidAt) o.paidAt=Date.now(); await saveOrderRowSync(o); }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 确认收款
      const mConfirm = pathname.match(/^\/api\/orders\/([\w-]+)\/confirm$/);
      if(method==='POST' && mConfirm){
        await refreshOrderOne(mConfirm[1]); // 只复核这一笔
        const o = orders.find(o=>o.id===mConfirm[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        if(o.status==='待付款' || o.status==='待确认'){
          o.status='待发货'; o.confirmedAt=Date.now(); if(!o.paidAt) o.paidAt=Date.now();
          ensureShipCode(o); // 进入待发货时自动分配唯一编号
          await saveOrderRowSync(o);
        }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 发货
      const mShip = pathname.match(/^\/api\/orders\/([\w-]+)\/ship$/);
      if(method==='POST' && mShip){
        await refreshOrderOne(mShip[1]); // 只复核这一笔
        const o = orders.find(o=>o.id===mShip[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        o.status='已发货'; o.tracking=String(body.tracking||'').slice(0,60); o.shippedAt=Date.now(); await saveOrderRowSync(o);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 手工填写/更新快递单号（fix54）★★只写 tracking 字段★★
      // 严禁在此改 status / shippedAt / shipCode / 金额 / 明细 —— 就是「订单不能到处乱跑」的保障：
      // 商家在「今日可发」手上先记下快递单号，订单仍留在原栏目，直到走完正常发货闭环。
      const mTrack = pathname.match(/^\/api\/orders\/([\w-]+)\/tracking$/);
      if(method==='POST' && mTrack){
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        const tk = String(body.tracking==null?'':body.tracking).trim().slice(0,60);
        await refreshOrderOne(mTrack[1]); // 只复核这一笔，避免整表往返
        const o = orders.find(o=>o.id===mTrack[1]);
        if(!o){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'订单不存在'})); return; }
        if(o.status==='已取消'){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'已取消的订单不能填写单号'})); return; }
        const before={ status:o.status, tracking:o.tracking };
        o.tracking = tk;
        // 双重保险：即便上游哪里手滑改了状态，这里也强制还原，保证「只动单号」
        if(o.status!==before.status) o.status = before.status;
        await saveOrderRowSync(o);
        console.log('[tracking]', o.id, before.tracking||'(空)', '->', tk||'(空)', '| status 保持', o.status);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 「今日可发」保存单号并直接标记「已发货」（fix56）★★严格单笔★★
      // 铁律：只动被点这一笔的 status/tracking/shippedAt。
      // 绝不触碰其他订单、不做任何重排、不写 orders 大数组（防整表覆盖）。
      // shipCode / 金额 / 明细 / paidAt / confirmedAt / 备注 一律原样保留。
      const mTrackShip = pathname.match(/^\/api\/orders\/([\w-]+)\/tracking-and-ship$/);
      if(method==='POST' && mTrackShip){
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        const tk = String(body.tracking==null?'':body.tracking).trim().slice(0,60);
        if(!tk){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'请先填写快递单号，再点「保存并发货」'})); return; }
        await refreshOrderOne(mTrackShip[1]); // 只复核这一笔，避免整表往返
        const o = orders.find(o=>o.id===mTrackShip[1]);
        if(!o){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'订单不存在'})); return; }
        if(o.status==='已取消'){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'已取消的订单不能发货'})); return; }
        if(o.status==='已发货'){
          // 幂等：已经是已发货就原样返回，不重写、不刷新 shippedAt（防重复点造成数据抖动）
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status, alreadyShipped:true})); return;
        }
        const before={ status:o.status, tracking:o.tracking };
        o.status='已发货'; o.tracking=tk; o.shippedAt=Date.now();
        await saveOrderRowSync(o); // 只写 order:<id> 这一行的 key
        console.log('[tracking-and-ship]', o.id, before.status, '-> 已发货 | 单号', tk);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status, before})); return;
      }
      // 允许/禁止发货管家采集（仅待发货状态可设置）
      const mAllowPull = pathname.match(/^\/api\/orders\/([\w-]+)\/allow-pull$/);
      if(method==='POST' && mAllowPull){
        await syncOrders();
        const o = orders.find(o=>o.id===mAllowPull[1]);
        if(!o){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'no'})); return; }
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        o.allowPull = !!body.allowPull;
        o.allowPullAt = o.allowPull ? Date.now() : null;
        await saveOrderRowSync(o);
        if(!USE_SUPABASE) await saveKV('orders', orders).catch(e=>console.error('[allow-pull disk]',e.message));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o})); return;
      }
      // 批量允许/禁止（仅操作 status==='待发货' 的订单）
      const mBatchAllow = pathname.match(/^\/api\/orders\/batch-allow-pull$/);
      if(method==='POST' && mBatchAllow){
        await syncOrders();
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        const allow = !!body.allow;
        const ids = Array.isArray(body.ids) ? body.ids : null; // 不传 ids 则全量操作待发货
        const targets = orders.filter(o => o.status==='待发货' && (!ids || ids.includes(o.id)));
        const now = Date.now();
        targets.forEach(o => { o.allowPull = allow; o.allowPullAt = allow ? now : null; });
        // 逐行落盘（沿用既有 saveOrderRowSync）；用 Promise.all 加速
        await Promise.all(targets.map(o => saveOrderRowSync(o).catch(e=>console.error('[batch-allow]',o.id,e.message))));
        if(!USE_SUPABASE) await saveKV('orders', orders).catch(e=>console.error('[batch-allow disk]',e.message));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, count:targets.length})); return;
      }
      // 「同意进入今日可发」：把勾选了「允许发货管家采集」的待发货订单，移入独立的「今日可发」状态，
      // 使其从「待发货」中移除——同一订单不会同时出现在两个栏目（互斥，防止重复）。
      const mTodayAccept = pathname.match(/^\/api\/orders\/today-accept$/);
      if(method==='POST' && mTodayAccept){
        await refreshOrdersFromCloud(); // 写前复核云端，避免用过期内存副本
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const now = Date.now();
        const targets = orders.filter(o => o.status==='待发货' && ids.includes(o.id));
        targets.forEach(o => { o.status='今日可发'; o.allowPull=true; o.allowPullAt=now; o.todayAt=now; });
        await Promise.all(targets.map(o => saveOrderRowSync(o).catch(e=>console.error('[today-accept]', o.id, e.message))));
        if(!USE_SUPABASE) await saveKV('orders', orders).catch(e=>console.error('[today-accept disk]', e.message));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, count:targets.length})); return;
      }
      // 商家后台「今日可发订单」→ 全部导出：把当前允许采集的待发货订单形成一个「商城本次汇总单」，
      // 追加到 mall_sessions 数组（一天可多次汇总）。发货管家 /shipper 读取 sessions 列表。
      // 导出成功后把每笔订单标记为 status='待回传'（离开「今日可发」、进入「等待回传区」），防止重复导出。
      const mMallExport = pathname.match(/^\/api\/mall-today-export$/);
      if(method==='POST' && mMallExport){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        const date = String(body.date||new Date().toISOString().slice(0,10));
        const exported = Array.isArray(body.orders) ? body.orders.filter(o=>o && o.id && o.phone) : [];
        const session = {
          sessionId: 'M'+Date.now().toString(36)+Math.random().toString(36).slice(2,4),
          ts: Date.now(), date, orders: exported
        };
        let savedIds = [];
        try {
          const arr = await loadKV('mall_sessions', []);
          const list = Array.isArray(arr) ? arr : [];
          list.push(session);
          await saveKV('mall_sessions', list);
          // 关键：先刷新内存订单副本。Render 冷启动/内存可能过期或为空，直接 find 会找不到订单，
          // 导致「标记为待回传」这一步空转、防重复失效。refreshOrdersFromCloud() 正是 /api/orders 用的那份权威数据源。
          await refreshOrdersFromCloud().catch(e=>console.error('[mall-export refresh]', e.message));
          // 防重复：把已导出的「今日可发」订单标记为「待回传」，使其离开「今日可发」、进入「等待回传区」
          const byId = new Map(exported.map(o=>[o.id, o]));
          const dirty = [];
          orders.forEach(o=>{ if(byId.has(o.id) && (o.status==='今日可发' || o.status==='待发货')){ o.status='待回传'; o.exportedAt=Date.now(); dirty.push(o); } });
          await Promise.all(dirty.map(o=>saveOrderRowSync(o).catch(e=>console.error('[mall-export markReturn]', o.id, e.message))));
          savedIds = dirty.map(o=>o.id);
        }
        catch(e){ res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'save_failed', message:e.message})); return; }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, sessionId:session.sessionId, ts:session.ts, count:exported.length, totalSessions:(await loadKV('mall_sessions',[])).length, returnedIds:savedIds})); return;
      }
      // 取消订单（允许待付款 / 待确认 状态，含商家端「未收到该款项」）
      const mCancel = pathname.match(/^\/api\/orders\/([\w-]+)\/cancel$/);
      if(method==='POST' && mCancel){
        await refreshOrderOne(mCancel[1]); // 只复核这一笔
        const o = orders.find(o=>o.id===mCancel[1]);
        if(!o){ res.writeHead(404); res.end(JSON.stringify({error:'no'})); return; }
        if(o.status!=='待付款' && o.status!=='待确认'){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'only_pending_or_confirm_can_cancel'})); return; }
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        // 恢复库存：仅本功能上线后下单（stockDeducted 标记）的订单才恢复，历史订单不回溯
        let stockRestored = false;
        if(o.stockDeducted){
          // 内存副本为权威，直接恢复库存（不再 syncProducts 往返）
          (o.items||[]).forEach(it=>{
            const p = products.find(p=>p.id===it.id);
            if(!p) return;
            const qty = Number(it.qty)||0;
            if(it.skuId){
              const sku = (p.skus||[]).find(s=>String(s.id)===it.skuId);
              if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) + qty; stockRestored = true; markProductDirty(it.id, 'ops'); }
            } else if(p.stock!=null){
              p.stock = Math.floor(Number(p.stock)) + qty; stockRestored = true; markProductDirty(it.id, 'ops');
            }
          });
        }
        const prevStatus = o.status;
        const prevCancelledAt = o.cancelledAt;
        o.status='已取消';
        o.cancelledAt=Date.now();
        try {
          await saveOrderRowSync(o);
        } catch(e){
          // 关键：云端保存失败时必须回滚状态和库存，否则内存与数据库不一致，重复点击会报状态错误
          o.status = prevStatus;
          if(prevCancelledAt === undefined) delete o.cancelledAt; else o.cancelledAt = prevCancelledAt;
          if(stockRestored){
            (o.items||[]).forEach(it=>{
              const p = products.find(p=>p.id===it.id);
              if(!p) return;
              const qty = Number(it.qty)||0;
              if(it.skuId){
                const sku = (p.skus||[]).find(s=>String(s.id)===it.skuId);
                if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) - qty; markProductDirty(it.id, 'ops'); }
              } else if(p.stock!=null){
                p.stock = Math.floor(Number(p.stock)) - qty; markProductDirty(it.id, 'ops');
              }
            });
          }
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'save_failed', message:e.message})); return;
        }
        if(stockRestored) saveProductsDebounced();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 恢复已取消订单：商家核实后重新成立，进入待发货（库存恢复后再次扣除）
      const mRestore = pathname.match(/^\/api\/orders\/([\w-]+)\/restore$/);
      if(method==='POST' && mRestore){
        const o = orders.find(o=>o.id===mRestore[1]);
        if(!o){ res.writeHead(404); res.end(JSON.stringify({error:'no'})); return; }
        if(o.status!=='已取消'){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'only_cancelled_can_restore'})); return; }
        // 重新扣减库存：仅本功能上线后下单（stockDeducted 标记）的订单才扣，历史订单不回溯
        let stockRededucted = false;
        if(o.stockDeducted){
          (o.items||[]).forEach(it=>{
            const p = products.find(p=>p.id===it.id);
            if(!p) return;
            const qty = Number(it.qty)||0;
            if(it.skuId){
              const sku = (p.skus||[]).find(s=>String(s.id)===it.skuId);
              if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) - qty; stockRededucted = true; markProductDirty(it.id, 'ops'); }
            } else if(p.stock!=null){
              p.stock = Math.floor(Number(p.stock)) - qty; stockRededucted = true; markProductDirty(it.id, 'ops');
            }
          });
        }
        const prevStatus = o.status;
        const prevRestoredAt = o.restoredAt;
        const prevRestoredCount = o.restoredCount;
        o.status='待发货';
        o.restoredAt=Date.now();
        o.restoredCount=(o.restoredCount||0)+1;
        ensureShipCode(o); // 恢复进入待发货时补编号
        try {
          await saveOrderRowSync(o);
        } catch(e){
          // 关键：云端保存失败时必须回滚状态、重扣次数和库存
          o.status = prevStatus;
          if(prevRestoredAt === undefined) delete o.restoredAt; else o.restoredAt = prevRestoredAt;
          o.restoredCount = prevRestoredCount;
          if(stockRededucted){
            (o.items||[]).forEach(it=>{
              const p = products.find(p=>p.id===it.id);
              if(!p) return;
              const qty = Number(it.qty)||0;
              if(it.skuId){
                const sku = (p.skus||[]).find(s=>String(s.id)===it.skuId);
                if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) + qty; markProductDirty(it.id, 'ops'); }
              } else if(p.stock!=null){
                p.stock = Math.floor(Number(p.stock)) + qty; markProductDirty(it.id, 'ops');
              }
            });
          }
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'save_failed', message:e.message})); return;
        }
        if(stockRededucted) saveProductsDebounced();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // ---------- 修改订单商品（删除某几项 / 换货补货追加）：重算 total，被删商品恢复库存 ----------
      const mUpdateItems = pathname.match(/^\/api\/orders\/([\w-]+)\/update-items$/);
      if(method==='POST' && mUpdateItems){
        await refreshOrderOne(mUpdateItems[1]); // 只复核这一笔
        const o = orders.find(o=>o.id===mUpdateItems[1]);
        if(!o){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'no'})); return; }
        // 仅未发货订单可改商品（已发货/已取消不可直接改）
        if(o.status==='已发货' || o.status==='已取消'){
          res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'only_unshipped_can_edit'})); return;
        }
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        if(!Array.isArray(body.items)){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'items_required'})); return; }
        const keyOf = x => x.skuId ? (String(x.id)+'#'+String(x.skuId)) : String(x.id);
        const newItems = body.items.map(it=>({
          id: String(it.id||it.pid||'').slice(0,50),
          skuId: String(it.skuId||'').slice(0,50),
          skuName: String(it.skuName||'').slice(0,100),
          name: String(it.name||'').slice(0,200),
          price: Number(it.price)||0,
          qty: Math.max(0, Math.floor(Number(it.qty)||0)),
          unit: String(it.unit||'').trim().slice(0,10),
          image: String(it.image||'').slice(0,500),
          bundleItems: Array.isArray(it.bundleItems)?it.bundleItems:[],
          isManualAdd: !!it.isManualAdd
        })).filter(it=> it.qty>0 && (it.id || it.name));
        // diff：旧 items 中被删的 key → 恢复库存（仅本功能上线后下单、已扣库存的才恢复）
        const newKeys = new Set(newItems.map(keyOf));
        let stockRestored=false;
        (o.items||[]).forEach(it=>{
          if(!newKeys.has(keyOf(it)) && o.stockDeducted){
            const p=products.find(p=>p.id===it.id); if(!p) return;
            const qty=Number(it.qty)||0;
            if(it.skuId){ const sku=(p.skus||[]).find(s=>String(s.id)===it.skuId); if(sku&&sku.stock!=null){ sku.stock=Math.floor(Number(sku.stock))+qty; stockRestored=true; markProductDirty(it.id, 'ops');} }
            else if(p.stock!=null){ p.stock=Math.floor(Number(p.stock))+qty; stockRestored=true; markProductDirty(it.id, 'ops'); }
          }
        });
        const prevItems=o.items, prevTotal=o.total, prevStatus=o.status, prevCancelledAt=o.cancelledAt;
        o.items=newItems;
        o.total=newItems.reduce((s,x)=>s+(x.isManualAdd?0:x.price*x.qty),0);
        if(newItems.length===0){ o.status='已取消'; o.cancelledAt=Date.now(); }
        try { await saveOrderRowSync(o); }
        catch(e){
          o.items=prevItems; o.total=prevTotal; o.status=prevStatus;
          if(prevCancelledAt===undefined) delete o.cancelledAt; else o.cancelledAt=prevCancelledAt;
          if(stockRestored){ (o.items||[]).forEach(it=>{ const p=products.find(p=>p.id===it.id); if(!p) return; const qty=Number(it.qty)||0; if(it.skuId){ const sku=(p.skus||[]).find(s=>String(s.id)===it.skuId); if(sku&&sku.stock!=null){ sku.stock=Math.floor(Number(sku.stock))-qty; markProductDirty(it.id, 'ops');} } else if(p.stock!=null){ p.stock=Math.floor(Number(p.stock))-qty; markProductDirty(it.id, 'ops');} }); }
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'save_failed', message:e.message})); return;
        }
        if(stockRestored) saveProductsDebounced();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o})); return;
      }
      // ---------- 修改订单联系信息 / 备注（微信号、备注等） ----------
      const mContact = pathname.match(/^\/api\/orders\/([\w-]+)\/contact$/);
      if(method==='POST' && mContact){
        await refreshOrderOne(mContact[1]); // 只复核这一笔
        const o = orders.find(o=>o.id===mContact[1]);
        if(!o){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'no'})); return; }
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        const prev = { wechat:o.wechat, note:o.note };
        if(body.wechat!=null) o.wechat = String(body.wechat).trim().slice(0,50);
        if(body.note!=null) o.note = String(body.note).trim().slice(0,500);
        try { await saveOrderRowSync(o); }
        catch(e){
          o.wechat = prev.wechat; o.note = prev.note;
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'save_failed', message:e.message})); return;
        }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o})); return;
      }
      // ---------- 新建手工订单（商家后台补单/换货追加）：沿用客户信息，商品可手工填写，不扣系统库存 ----------
      if(method==='POST' && pathname==='/api/orders/manual'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        if(!body.name || !body.phone || !body.address){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'missing_contact'})); return; }
        const rawItems = Array.isArray(body.items)?body.items:[];
        if(!rawItems.length){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'empty'})); return; }
        const detail = rawItems.map(it=>{
          const pid = String(it.id||'').slice(0,50);
          const p = pid ? products.find(p=>p.id===pid) : null;
          const name = p ? p.name : String(it.name||'手工商品').slice(0,200);
          const price = p ? Number(p.price||0) : (Number(it.price)||0);
          return {
            id: pid,
            skuId: String(it.skuId||'').slice(0,50),
            skuName: String(it.skuName||'').slice(0,100),
            name,
            price,
            qty: Math.max(1, Math.floor(Number(it.qty)||1)),
            unit: String(it.unit||'').trim().slice(0,10),
            image: p ? (p.image||p.images&&p.images[0]||'') : String(it.image||'').slice(0,500),
            bundleItems: Array.isArray(it.bundleItems)?it.bundleItems:[]
          };
        });
        const total = detail.reduce((s,x)=>s+x.price*x.qty,0);
        const id = genId();
        const order = {
          id, items:detail, total,
          name:String(body.name).slice(0,50), phone:String(body.phone).slice(0,30),
          address:String(body.address).slice(0,200), wechat:String(body.wechat||'').slice(0,50),
          note:String('【手工补单】'+(body.note||'')).slice(0,200),
          status: (body.status==='待发货'||body.status==='待确认'||body.status==='今日可发')?body.status:'待发货',
          tracking:'',
          stockDeducted:false, // 手工订单不扣系统库存
          isManual:true,
          createdAt:Date.now(), paidAt:Date.now(), confirmedAt:Date.now(), shippedAt:null
        };
        if(order.status==='待发货' || order.status==='今日可发') ensureShipCode(order); // 手工直接进发货队列也自动编号
        saveOrderRow(order);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, id, order})); return;
      }
      // 更新配置（店铺名/联系人/公告/收款码）
      const mConfig = pathname.match(/^\/api\/config$/);
      if(method==='POST' && mConfig){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        if(body.shopName!=null) config.shopName=String(body.shopName).slice(0,50);
        if(body.contactName!=null) config.contactName=String(body.contactName).slice(0,30);
        if(body.announcement!=null) config.announcement=String(body.announcement).slice(0,300);
        if(body.activityDeadline!=null) config.activityDeadline=String(body.activityDeadline).slice(0,50);
        if(body.activityStart!=null) config.activityStart=String(body.activityStart).slice(0,50);
        if(Array.isArray(body.countdownPhrases)) config.countdownPhrases=body.countdownPhrases.filter(x=>x!=null).map(x=>String(x).slice(0,50)).filter(s=>s.trim().length);
        if(body.countdownSegmentHours!=null){ const _n=Number(body.countdownSegmentHours); if(Number.isFinite(_n)&&_n>0&&_n<=8760) config.countdownSegmentHours=Math.floor(_n); }
        if(body.countdownManualIndex!=null){ const _m=Number(body.countdownManualIndex); if(Number.isFinite(_m)) config.countdownManualIndex=Math.floor(_m); }
        if(body.bankName!=null) config.bankName=String(body.bankName).slice(0,50);
        if(body.bankAccount!=null) config.bankAccount=String(body.bankAccount).slice(0,60);
        if(body.bankHolder!=null) config.bankHolder=String(body.bankHolder).slice(0,20);
        if(body.hiddenCategories!=null){
          const arr=Array.isArray(body.hiddenCategories)?body.hiddenCategories:[];
          config.hiddenCategories=arr.map(x=>String(x).trim().slice(0,50)).filter(Boolean);
        }
        // 2026-09-12 加：当前活动波次（none=日常 / w1=第一波 / w2 / w3 / w4=返场）
        if(body.activeWave!=null) config.activeWave=String(body.activeWave).trim().slice(0,10);
        if(body.hours!=null){ const h=Number(body.hours); if(Number.isFinite(h)&&h>0){ config.waveEndsAt=Date.now()+Math.round(h*3600*1000); config.activityDeadline=new Date(config.waveEndsAt).toISOString(); } }
        if(body.paymentQrBase64){ const url=await saveImage(body.paymentQrBase64,'payment-qr'); if(url) config.paymentQr=url; }
        if(body.paymentWechatQrBase64){ const url=await saveImage(body.paymentWechatQrBase64,'payment-wechat'); if(url) config.paymentWechatQr=url; }
        if(body.paymentAlipayQrBase64){ const url=await saveImage(body.paymentAlipayQrBase64,'payment-alipay'); if(url) config.paymentAlipayQr=url; }
        if(body.bankImageBase64){ const url=await saveImage(body.bankImageBase64,'bank'); if(url) config.bankImage=url; }
        await saveConfig();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, config})); return;
      }

      // 图库：列出所有文件夹和图片
      if(method==='GET' && pathname==='/api/gallery'){
        const list=[];
        const entries=fs.readdirSync(GALLERY,{withFileTypes:true});
        for(const ent of entries){
          if(ent.isDirectory()){
            const files=fs.readdirSync(path.join(GALLERY,ent.name))
              .filter(f=>/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(f))
              .map(f=>({name:f, url:'/assets/gallery/'+encodeURIComponent(ent.name)+'/'+encodeURIComponent(f)}));
            list.push({name:ent.name, files});
          }
        }
        if(!list.length){
          ensureDir(path.join(GALLERY,'默认图库'));
          list.push({name:'默认图库', files:[]});
        }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(list)); return;
      }
      // 图库：新建文件夹
      if(method==='POST' && pathname==='/api/gallery/folder'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        const name=String(body.name||'').trim().replace(/[\\/:*?"<>|]/g,'_').slice(0,50);
        if(!name){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'empty'})); return; }
        const target=path.join(GALLERY,name);
        if(fs.existsSync(target)){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, existed:true})); return; }
        ensureDir(target);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
      }
      // 图库：上传图片到指定文件夹
      if(method==='POST' && pathname==='/api/gallery/upload'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        const folder=String(body.folder||'默认图库').trim().replace(/[\\/:*?"<>|]/g,'_');
        const m=String(body.base64||'').match(/^data:(image\/\w+);base64,(.+)$/);
        if(!m){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad image'})); return; }
        const ext=m[1]==='image/png'?'png':(m[1]==='image/jpeg'?'jpg':(m[1]==='image/webp'?'webp':'png'));
        const buf=Buffer.from(m[2],'base64');
        const fileName=String(body.fileName||'img').replace(/[\\/:*?"<>|]/g,'_').replace(/\.[^.]+$/,'')+'_'+Date.now().toString(36)+'.'+ext;
        if(USE_SUPABASE){
          const url=await saveImage(body.base64, fileName, 'gallery/'+folder);
          if(!url){ res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'upload failed'})); return; }
          res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, url, fileName})); return;
        }
        const targetDir=path.join(GALLERY,folder);
        ensureDir(targetDir);
        fs.writeFileSync(path.join(targetDir,fileName),buf);
        const url='/assets/gallery/'+encodeURIComponent(folder)+'/'+encodeURIComponent(fileName);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, url, fileName})); return;
      }

      // 富文本描述安全过滤：白名单标签 + 移除脚本/事件属性/危险协议
      const SANITIZE_ALLOWED_TAGS = ['p','br','div','span','b','strong','i','em','u','ul','ol','li','h1','h2','h3','h4','h5','h6','a','img','table','tbody','thead','tr','td','th','hr','sub','sup','small','big','mark','section','article','blockquote','pre','code','font','figure','figcaption','dl','dt','dd','center','strike','del','ins'];
      function sanitizeHtml(html){
        if(!html) return '';
        if(_sanitizeHtml){
          return _sanitizeHtml(String(html).trim(), {
            allowedTags: SANITIZE_ALLOWED_TAGS,
            allowedAttributes: {
              '*': ['style','class','color'],
              'a': ['href','target','rel'],
              'img': ['src','alt']
            },
            allowedSchemes: ['http','https','data'],
            allowedSchemesAppliedToAttributes: ['href','src'],
            allowProtocolRelative: false
          });
        }
        // 降级：库未安装时的自定义过滤（保留格式标签，文本优先保留）
        let s=String(html).trim();
        s = s.replace(/<\s*(script|style|iframe|object|embed|link|meta|head|html|body|svg|math|form|input|button|textarea|select|option)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>|\s*<\s*(script|style|iframe|object|embed|link|meta|head|html|body|svg|math|form|input|button|textarea|select|option)\b[^>]*\/?>/gi,'');
        s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi,'');
        s = s.replace(/\son\w+\s*=\s*'[^']*'/gi,'');
        s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi,'');
        s = s.replace(/(href|src)\s*=\s*("|')\s*(javascript|vbscript|data):/gi,'$1=$2#');
        const allowed=new Set(SANITIZE_ALLOWED_TAGS.map(t=>t.toUpperCase()));
        s = s.replace(/(<\/?)\s*([a-zA-Z0-9]+)\b([^>]*)>/g, (m,slash,tag,attrs)=>{
          const t=tag.toUpperCase();
          if(!allowed.has(t)) return '';
          if(t==='IMG'){
            if(slash==='</') return '';
            const src=(attrs.match(/src\s*=\s*("|')([^"']*)\1/i)||[])[2]||'';
            if(!/^https?:\/\/|^data:image\//i.test(src)) return '';
            return '<img src="'+src.replace(/"/g,'')+'" alt="">';
          }
          if(t==='A'){
            if(slash==='</') return '</a>';
            const href=(attrs.match(/href\s*=\s*("|')([^"']*)\1/i)||[])[2]||'';
            const safeHref=/^\s*(javascript|vbscript):/i.test(href)?'#':href.replace(/"/g,'');
            return '<a href="'+safeHref+'" target="_blank" rel="noopener noreferrer">';
          }
          const style=(attrs.match(/style\s*=\s*("|')([^"']*)\1/i)||[])[2]||'';
          const safeStyle=style.replace(/url\s*\(/gi,'').replace(/expression\s*\(/gi,'').replace(/javascript:/gi,'');
          const cls=(attrs.match(/class\s*=\s*("|')([^"']*)\1/i)||[])[2]||'';
          const safeCls=cls.replace(/[^a-zA-Z0-9_\- ]/g,'').trim();
          const colorAttr=(attrs.match(/color\s*=\s*("|')([^"']*)\1/i)||[])[2]||'';
          return slash + tag.toLowerCase() + (safeStyle?' style="'+safeStyle.replace(/"/g,'')+'"':'') + (safeCls?' class="'+safeCls+'"':'') + (colorAttr?' color="'+colorAttr.replace(/"/g,'')+'"':'') + '>';
        });
        return s;
      }
      // 产品管理：增 / 改
      if(method==='POST' && pathname==='/api/products'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        const p=body;
        const clientSaveId = String(p.clientSaveId || '').trim();
        // 幂等：同一 clientSaveId 已处理过，直接返回上次结果，不再写库
        if(clientSaveId){
          const cached = getSavedById(clientSaveId);
          if(cached){
            console.log('[POST /api/products] 幂等命中:', clientSaveId);
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, product:cached, cached:true})); return;
          }
        }
        const id=String(p.id||'').trim();
        const isNew=!id || !products.find(x=>x.id===id);
        const newId=id || crypto.randomBytes(4).toString('hex').toUpperCase();
        const skuBundle = (b)=>Array.isArray(b)?b.slice(0,20).map(x=>({
          name: String(x.name||'').trim().slice(0,100),
          qty: Math.max(0, Math.floor(Number(x.qty)||0)),
          unit: String(x.unit||'件').trim().slice(0,10)
        })).filter(x=>x.name && x.qty>0):[];
        const existing = products.find(x=>x.id===id) || {};
        const item={
          id: newId,
          name: String(p.name!==undefined?p.name:(existing.name||'未命名')).trim().slice(0,100),
          subtitle: String(p.subtitle!==undefined?p.subtitle:(existing.subtitle||'')).trim().slice(0,300),
          price: p.price!==undefined?Math.max(0, Number(p.price)||0):(existing.price||0),
          originalPrice: p.originalPrice!==undefined?Math.max(0, Number(p.originalPrice)||0):(existing.originalPrice||0),
          stock: p.stock!==undefined?Math.max(0, Number(p.stock)||0):(existing.stock||0),
          forceSoldOut: p.forceSoldOut!==undefined?!!p.forceSoldOut:(existing.forceSoldOut||false), // 后台弹窗没提供该字段，必须与旧数据合并，防止被清空
          hidden: p.hidden!==undefined?!!p.hidden:(existing.hidden||false),
          // 2026-09-12 加：活动分组（第一波1/2/3组、第二波A/B组、第三波定制/盲盒、返场）
          waveGroup: String(p.waveGroup!==undefined?p.waveGroup:(existing.waveGroup||'')).trim().slice(0,30),
          category: String(p.category!==undefined?p.category:(existing.category||'')).trim().slice(0,50),
          desc: p.desc!==undefined?sanitizeHtml(String(p.desc).trim()).slice(0,30000):(existing.desc||''),
          image: String(p.image!==undefined?p.image:(existing.image||'/assets/products/default.svg')).trim(),
          detailImages: p.detailImages!==undefined?(Array.isArray(p.detailImages)?p.detailImages.filter(u=>String(u).startsWith('/')||/^https?:/.test(u)).slice(0,20):[]):(existing.detailImages||[]),
          folder: String(p.folder!==undefined?p.folder:(existing.folder||'')).trim(),
          shareImage: String(p.shareImage!==undefined?p.shareImage:(existing.shareImage||'')).trim(),
          bundleItems: p.bundleItems!==undefined?skuBundle(p.bundleItems):(existing.bundleItems||[]),
          skus: p.skus!==undefined?(Array.isArray(p.skus)?p.skus.slice(0,20).map(s=>({
            id: String(s.id||'').trim() || crypto.randomBytes(3).toString('hex').toUpperCase(),
            name: String(s.name||'').trim().slice(0,100),
            subtitle: String(s.subtitle!==undefined?s.subtitle:(existing.skus&&existing.skus.find(es=>es.id===s.id)?existing.skus.find(es=>es.id===s.id).subtitle:'')).trim().slice(0,80),
            price: Math.max(0, Number(s.price)||0),
            stock: Math.max(0, Math.floor(Number(s.stock)||0)),
            image: String(s.image||'').trim().slice(0,300),
            bundleItems: skuBundle(s.bundleItems)
          })).filter(s=>s.name):[]):(existing.skus||[]),
          // 有 SKU 时，主价格/库存自动以 SKU 最低价和总库存为准，避免列表与 SKU 不同步
          updatedAt: Date.now()
        };
        if(item.skus && item.skus.length){
          item.price = Math.min(...item.skus.map(s=>Number(s.price)||0));
          item.stock = item.skus.reduce((sum,s)=>sum+(Number(s.stock)||0),0);
        }
        // 关键修复（2026-09-12）：改了「活动分组」必须立刻重算 hidden。
        // 否则上一波切波时留下的 hidden=false 会让这个品在当前波次的买家端继续露出
        //（症状：把产品改成「返场爆品」并保存成功，切到第二波却还能看到它）。
        // 2026-09-13 升级：支持多波次同时开启（如 w2,w3），waveGroup 变化时按当前所有生效波次重算 hidden。
        const curWaves = String(config.activeWave||'').split(',').map(s=>s.trim()).filter(Boolean);
        const WAVE_PREFIX_MAP = { w1:'w1g', w2:'w2g', w3:'w3g', w4:'' };
        const activePrefixes = curWaves.map(w=>WAVE_PREFIX_MAP[w]).filter((p,i,arr)=>p!=null && arr.indexOf(p)===i);
        const hasAllPrefix = activePrefixes.some(p=>!p);
        if(activePrefixes.length && !hasAllPrefix && String(existing.waveGroup||'').trim() !== String(item.waveGroup||'').trim()){
          const wg = String(item.waveGroup||'').trim();
          item.hidden = !activePrefixes.some(pre=>wg.indexOf(pre)===0);
        }
        if(isNew){ item.createdAt=item.updatedAt; products.push(item); }
        else { const idx=products.findIndex(x=>x.id===id); item.createdAt=products[idx].createdAt||item.updatedAt; products[idx]=item; }
        // 产品改为独立行存储：只 upsert 当前产品，回到秒级保存
        markProductDirty(item.id);
        // 路由层加重试：withRetry 默认 2 次仍偶发被 supabase 免费层瞬时抖动打挂，
        // 这里再包 2 次重试（间隔 1.5s），总计最多 3 次尝试，把抖动吞掉不再让前端看到失败 banner。
        // 内存已是最新的（products[idx]=item 在前），重试只重做云端 upsert，安全幂等。
        let saved=false, lastErr;
        for(let attempt=0; attempt<3; attempt++){
          // fix52：单轮上限 12s×2（原来 20s×2，三轮回合最坏要 3 分钟才报错），保持"能等到结果"
          try { await flushDirtyProducts({ timeoutMs: 12000, retries: 2 }); saved=true; break; }
          catch(e){
            lastErr=e;
            console.error(`[POST /api/products] flushDirtyProducts 第${attempt+1}/3次失败:`, e.message);
            if(attempt<2) await new Promise(r=>setTimeout(r, 1500));
          }
        }
        if(!saved){
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'云端保存失败：'+lastErr.message})); return;
        }
        // fix49：写后回读校验 —— 只有云端确实存下了（回读到的 updatedAt 与本次一致）才报成功，
        // 从根上杜绝「显示保存成功、其实没落库」这种最误导人的情况。
        try{
          const rb = await withRetry(()=>sb.from('shop_data').select('value').eq('key','product:'+item.id).maybeSingle(), 'verifySave:'+item.id, 2);
          const v = rb && rb.data && rb.data.value;
          if(!v || Number(v.updatedAt) !== Number(item.updatedAt)){
            res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'云端未确认写入（回读不一致），请再点一次「保存产品」重试'})); return;
          }
        }catch(e){
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'云端写入状态未确认（回读失败：'+e.message+'），请稍后重试'})); return;
        }
        recordSaveId(clientSaveId, item);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, product:item})); return;
      }
      // 产品管理：删
      const mDelProd = pathname.match(/^\/api\/products\/([\w-]+)$/);
      if(method==='DELETE' && mDelProd){
        const idx=products.findIndex(x=>x.id===mDelProd[1]);
        if(idx===-1){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return; }
        const delId = mDelProd[1];
        products.splice(idx,1);
        await deleteProductRow(delId);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
      }
      // 产品管理：排序
      if(method==='POST' && pathname==='/api/products/reorder'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'bad_request', message:e.message||'请求数据格式错误'})); return; }
        const ids=Array.isArray(body.ids)?body.ids:[];
        const map=new Map(products.map(p=>[p.id,p]));
        const next=[];
        ids.forEach(id=>{ const p=map.get(id); if(p){ next.push(p); map.delete(id); } });
        map.forEach(p=>next.push(p));
        products=next;
        await saveProductOrder(true);   // fix52：拖拽排序是明确的顺序变更，强制写
        // 排序变更不大，整盘同步一次本地 seed；云端模式下只写 order key 即可
        if(!USE_SUPABASE) await withLock(()=> writeJsonAtomic('products.json', products));
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
      }
      // 商家后台：快速切换「强制售罄」开关（不需打开编辑弹窗，列表卡片直接点）
      const mToggleFSO = pathname.match(/^\/api\/products\/([\w-]+)\/toggle-force-sold-out$/);
      if(method==='POST' && mToggleFSO){
        const idx = products.findIndex(x=>x.id===mToggleFSO[1]);
        if(idx===-1){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return; }
        const pid = mToggleFSO[1];
        // fix52：先定下目标值再写，响应也回这个确定值（不再回读可能被并发同步改动的数组）
        const wantFso = !products[idx].forceSoldOut;
        products[idx].forceSoldOut = wantFso;
        setOpsTarget(pid, { forceSoldOut: wantFso });
        markProductDirty(pid, 'ops');
        try {
          await flushDirtyProducts({ timeoutMs: OPS_FLUSH_TIMEOUT_MS, retries: 3 });  // fix52：9s×3，失败快速反馈
        } catch(e){
          // fix52：必须回一个明确 JSON。旧版这里没有 catch，写库失败时请求会一路悬挂，
          // 柒木的体感就是「点了没反应，过一会儿才弹错」。内存保持已改 + 脏行保留，网络恢复后自动补存。
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});
          res.end(JSON.stringify({ok:false, message:'云端没写进去（'+(e&&e.message||e)+'）。已记住这次改动，网络恢复后会自动补存；也可以稍后再点一次。'}));
          return;
        }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, forceSoldOut: wantFso})); return;
      }
      // 商家后台：快速切换「隐藏/上架」开关（隐藏后买家端完全不可见）
      const mToggleHidden = pathname.match(/^\/api\/products\/([\w-]+)\/toggle-hidden$/);
      if(method==='POST' && mToggleHidden){
        const idx = products.findIndex(x=>x.id===mToggleHidden[1]);
        if(idx===-1){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return; }
        const pid = mToggleHidden[1];
        // fix52：同上，目标值先定、响应回确定值
        const wantHidden = !products[idx].hidden;
        products[idx].hidden = wantHidden;
        setOpsTarget(pid, { hidden: wantHidden });
        markProductDirty(pid, 'ops');
        try {
          await flushDirtyProducts({ timeoutMs: OPS_FLUSH_TIMEOUT_MS, retries: 3 });  // fix52：9s×3，失败快速反馈
        } catch(e){
          // fix52：同上——写库失败也必须有明确回应，不能让请求悬挂（"点上架点不动"的直接原因之一）
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'});
          res.end(JSON.stringify({ok:false, message:'云端没写进去（'+(e&&e.message||e)+'）。已记住这次改动，网络恢复后会自动补存；也可以稍后再点一次。'}));
          return;
        }
        clearHtmlCache(); // 单个隐藏/上架也即时清买家端页面缓存，保证与批量隐藏同步生效
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, hidden: wantHidden})); return;
      }
      // 商家后台：批量隐藏/上架多个产品（买家端立即不可见）。body: {ids:[...], hidden:true|false}
      if(method==='POST' && pathname==='/api/products/batch-hidden'){
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        const ids = Array.isArray(body.ids) ? body.ids.map(x=>String(x).trim()).filter(Boolean).slice(0,500) : [];
        if(!ids.length){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'no ids'})); return; }
        const hidden = body.hidden===true;
        let updated = 0;
        await syncProductsFromCloud();
        await withLock(async()=>{
          for(const pid of ids){
            const idx = products.findIndex(x=>x.id===pid);
            if(idx===-1) continue;
            if(products[idx].hidden === hidden) continue; // 已经是目标状态就跳过
            products[idx].hidden = hidden;
            markProductDirty(pid, 'ops');
            updated++;
          }
          if(updated) await flushDirtyProducts({ timeoutMs: OPS_FLUSH_TIMEOUT_MS, retries: 3 });
        });
        // 操作产品配置触发表，让买家端 / 与详情页缓存失效
        clearHtmlCache();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, updated, hidden})); return;
      }
      // 商家后台：一键切换活动波次。自动上架本波商品、隐藏非本波商品，并把买家端分类栏切成该波分组。
      // 2026-09-13 升级：支持同时选择多个波次（如第二波+第三波同时上）。
      if(method==='POST' && pathname==='/api/admin/apply-wave'){
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        // 支持 {waves:['w2','w3']} 或向后兼容 {wave:'w2'}
        let waves = Array.isArray(body.waves) ? body.waves.map(String).map(s=>s.trim()).filter(Boolean) : [];
        if(!waves.length && body.wave!=null) waves = [String(body.wave||'none').trim()];
        const WAVE_PREFIX = { w1:'w1g', w2:'w2g', w3:'w3g', w4:'' };
        // none / 空 = 全部显示
        const wantsNone = waves.includes('none') || waves.length===0;
        const activePrefixes = wantsNone ? [] : waves.map(w=>WAVE_PREFIX[w]).filter((p,i,arr)=>p!=null && arr.indexOf(p)===i);
        const hasAllPrefix = activePrefixes.some(p=>!p); // 含 w4 或空 prefix 时全部显示
        const h=Number(body.hours);
        let shown=0, hid=0, lastErr=null;
        // 幂等重试 3 次：products 与 config 必须都写成功，否则会出现
        // 「产品已按本波切换、但 activeWave 还是上一波」→ 买家端产品对、倒计时文案错。
        for(let attempt=0; attempt<3; attempt++){
          try{
            await syncProductsFromCloud();
            shown=0; hid=0;
            await withLock(async()=>{
              for(const p of products){
                const g=String(p.waveGroup||'').trim();
                let wantHidden;
                if(wantsNone || hasAllPrefix) wantHidden=false;
                else if(!g) wantHidden=true;
                else wantHidden = !activePrefixes.some(pre=>g.indexOf(pre)===0);
                if(!!p.hidden!==wantHidden){ p.hidden=wantHidden; markProductDirty(p.id, 'ops'); }
                if(wantHidden) hid++; else shown++;
              }
              await flushDirtyProducts({ timeoutMs: 12000, retries: 3 });
            });
            config.activeWave = wantsNone ? 'none' : waves.join(',');
            if(wantsNone) config.waveDur = '';
            // 公告滚动条按「当前波次开始时间」轮播，必须与活动倒计时同步。
            // 旧版沿用全局 activityStart（2026-09-12），导致四句话永远停在最后一句。
            config.activityStart = new Date().toISOString();
            if(Number.isFinite(h)&&h>0){
              config.waveEndsAt = Date.now()+Math.round(h*3600*1000);
              config.activityDeadline = new Date(config.waveEndsAt).toISOString();
              config.waveDur = Math.round(h)+'h';
            }
            await saveConfig();
            clearHtmlCache();
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, wave:config.activeWave, shown, hidden:hid, attempt:attempt+1})); return;
          }catch(e){
            lastErr=e;
            console.error('[apply-wave] 第'+(attempt+1)+'次失败:', e && e.message);
            if(attempt<2) await new Promise(r=>setTimeout(r,700));
          }
        }
        clearHtmlCache();
        res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, error:'切换失败（已自动重试3次，产品与波次均未改动）：'+((lastErr&&lastErr.message)||lastErr)})); return;
      }

      // 网络自检：用于排查「本地后台保存/切换活动一直失败」是网络还是数据问题。
      // 返回当前网络模式 + 一次真实的 Supabase 读探测用时。
      if(method==='GET' && pathname==='/api/diag'){
        const out = { netMode: NET_MODE, useSupabase: USE_SUPABASE, host: null, proxy: null, readOk: null, readMs: null, error: null };
        try { out.host = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null; } catch(e){}
        out.proxy = String(process.env.SUPABASE_PROXY || '') || null;
        if(USE_SUPABASE){
          const t0 = Date.now();
          try {
            const { error } = await withRetry(()=>sb.from('shop_data').select('key').limit(1), 'diag');
            if(error) throw new Error(error.message);
            out.readOk = true;
          } catch(e){ out.readOk = false; out.error = e.message; }
          out.readMs = Date.now() - t0;
        }
        res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
        res.end(JSON.stringify(out)); return;
      }

      // 商家后台自检版本端点：admin.html 加载时会 fetch 这里对比自己嵌入的版本号，
      // 不一致就 location.replace 强制刷一次。no-store 防止任何中间层缓存。
      // 必须放在 /api/* 块内部，避免被 1340 行兜底 404 吃掉。
      if(method==='GET' && pathname==='/api/admin-build'){
        res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store, must-revalidate', 'Pragma':'no-cache'});
        res.end(JSON.stringify({ v: ADMIN_BUILD, t: Date.now() }));
        return;
      }

      res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return;
    }

    // ===== 页面 =====
    if((method==='GET'||method==='HEAD') && (pathname==='/' || pathname==='')){
      const html = await renderPageCached('home', buildHomeHtml);
      if(!html || html===PAGE_MISSING){ res.writeHead(503,{'Content-Type':'text/html; charset=utf-8'}); res.end('页面生成中，请稍后重试'); return; }
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(method==='HEAD'?'':html); return;
    }

      const mProd = pathname.match(/^\/product\/([\w-]+)$/);
      if((method==='GET'||method==='HEAD') && mProd){
        const pid = mProd[1];
        let urlWave = '';
        try{ const u = new URL(req.url, 'http://localhost'); urlWave = u.searchParams.get('wave')||''; }catch(e){}
        const pkey = 'product:'+pid+(urlWave?(':'+urlWave):'');
        const html = await renderPageCached(pkey, ()=>buildProductHtml(pid, urlWave));
        if(html === PAGE_MISSING){
          // 商品不存在 / 已下架：绝不把「只有'商品不存在'四个字的白页」甩给买家。
          // 302 回商城首页（保留波次直链参数），买家至少落在当前活动页继续逛、继续下单。
          const back = '/' + (urlWave ? ('?wave='+encodeURIComponent(urlWave)) : '');
          res.writeHead(302,{'Location':back,'Cache-Control':'no-store','Content-Type':'text/html; charset=utf-8'});
          res.end(method==='HEAD'?'':'<!doctype html><meta charset="utf-8"><title>返回商城</title><meta http-equiv="refresh" content="0;url='+back+'">');
          return;
        }
        if(!html){ res.writeHead(503,{'Content-Type':'text/html; charset=utf-8'}); res.end('页面生成中，请稍后重试'); return; }
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(method==='HEAD'?'':html); return;
    }

    const mOrder = pathname.match(/^\/order\/([\w-]+)$/);
    if(method==='GET' && mOrder){
      const list = await getOrders();
      const o = list.find(o=>o.id===mOrder[1]) || null;
      const cfgNow = await getConfig();
      const html = renderTemplate('order.html', {
        SHOP_NAME: htmlEscape(cfgNow.shopName),
        ORDER_JSON: jsonForScript(o?enrichOrderBundles(o):o),
        CONFIG_JSON: jsonForScript(cfgNow)
      });
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(method==='HEAD'?'':html); return;
    }

    if(method==='GET' && pathname==='/admin'){
      fs.readFile(path.join(PUBLIC,'admin.html'), (err, buf)=>{
        if(err){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); return; }
        const html = buf.toString('utf8').replace('</head>', ADMIN_SELF_CHECK + '</head>');
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(html);
      });
      return;
    }

    if(method==='GET' && pathname==='/business_rules.js'){ sendFile(res, path.join(PUBLIC,'business_rules.js')); return; }
    if(method==='GET' && pathname==='/xlsx.full.min.js'){ sendFile(res, path.join(PUBLIC,'xlsx.full.min.js')); return; }

    // 图片加速代理：/img/shop/gallery/xxx.jpg → Supabase Storage，进程内缓存 + 7 天强缓存
    // 缩略图：浏览器端 thumbUrl/thumbImg 会追加 ?w=&h=&q=，此时走 Supabase 图片转换端点下发小图（约 1/8 体积），
    // 转换失败时自动回退原图，保证任何情况下都能出图、绝不让买家看到裂图。
    const mImg = pathname.match(/^\/img\/(.+)$/);
    if((method==='GET'||method==='HEAD') && mImg){
      const key = mImg[1];
      if(key.includes('..') || !/^shop\//.test(key)){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('not found'); return; }
      // 缩略图参数（浏览器端追加）
      const sp = u.searchParams;
      const tw = parseInt(sp.get('w')||'',10);
      const th = parseInt(sp.get('h')||'',10);
      const tq = parseInt(sp.get('q')||'',10) || 70;
      const isThumb = Number.isFinite(tw) && tw>0;
      const cacheKey = key + (isThumb ? ('#'+tw+'x'+(Number.isFinite(th)&&th>0?th:'')+'q'+tq) : '');
      const hit = imgCache.get(cacheKey);
      if(hit){
        res.writeHead(200,{'Content-Type':hit.type,'Content-Length':hit.buf.length,'Cache-Control':'public, max-age=604800, immutable'});
        res.end(method==='HEAD' ? undefined : hit.buf); return;
      }
      // fix51：磁盘缓存命中 —— 进程重启 / 本机断外网都还能出图
      const dhit = imgDiskRead(cacheKey);
      if(dhit){
        if(imgCache.size >= IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
        imgCache.set(cacheKey, dhit);
        res.writeHead(200,{'Content-Type':dhit.type,'Content-Length':dhit.buf.length,'Cache-Control':'public, max-age=604800, immutable'});
        res.end(method==='HEAD' ? undefined : dhit.buf); return;
      }
      if(!process.env.SUPABASE_URL){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('no storage'); return; }
      // 并发闸：排队等待，最长 6 秒，超时返回 503（前端会显示占位图，不影响整站）
      {
        const deadline = Date.now() + 6000;
        while(imgFetching >= IMG_MAX_CONCURRENT){
          if(Date.now() > deadline){ res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8'}); res.end('busy'); return; }
          await new Promise(s=>setTimeout(s, 60));
        }
      }
      imgFetching++;
      try{
        const ctl = new AbortController(); const tm = setTimeout(()=>ctl.abort(), 20000);
        let r;
        if(isThumb){
          // 优先走 Supabase 图片转换端点（小图），失败回退原图
          const base = process.env.SUPABASE_URL + '/storage/v1/render/image/public/' + key;
          const turl = base + '?width='+tw + (Number.isFinite(th)&&th>0 ? '&height='+th : '') + '&resize=cover&quality='+tq;
          try{
            r = await fetch(turl, { signal: ctl.signal });
            if(!r.ok) throw new Error('transform '+r.status);
          }catch(e){
            r = await fetch(process.env.SUPABASE_URL + '/storage/v1/object/public/' + key, { signal: ctl.signal });
          }
        } else {
          r = await fetch(process.env.SUPABASE_URL + '/storage/v1/object/public/' + key, { signal: ctl.signal });
        }
        clearTimeout(tm);
        if(!r.ok){ res.writeHead(r.status===404?404:502,{'Content-Type':'text/plain; charset=utf-8'}); res.end('img fetch failed: '+r.status); return; }
        const buf = Buffer.from(await r.arrayBuffer());
        const type = r.headers.get('content-type') || 'image/jpeg';
        if(imgCache.size >= IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
        imgCache.set(cacheKey, { buf, type });
        imgDiskWrite(cacheKey, buf, type); imgDiskPrune(); // fix51：落盘，扛重启/断网
        res.writeHead(200,{'Content-Type':type,'Content-Length':buf.length,'Cache-Control':'public, max-age=604800, immutable'});
        res.end(method==='HEAD' ? undefined : buf); return;
      }catch(e){
        console.error('[img proxy]', key, e.message);
        res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'}); res.end('img error'); return;
      }finally{
        imgFetching--;
      }
    }

    if(method==='GET' && pathname.startsWith('/assets/')){
      const rel = path.normalize(pathname.slice(1));
      const full = path.join(PUBLIC, rel);
      if(!full.startsWith(PUBLIC)){ res.writeHead(403); res.end('forbidden'); return; }
      sendFile(res, full); return;
    }

    res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found');
  } catch(e){
    console.error('[Server Error]', e);
    res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'server_error', message:e.message}));
  }
});

// 先启动监听（让 Render 健康检查立即通过），再异步加载数据
(async ()=>{
  server.listen(PORT, '0.0.0.0', ()=>{
    console.log('不初限时狂欢商城已监听端口 ' + PORT);
    console.log('买家首页: http://localhost:'+PORT+'/');
    console.log('商家后台: http://localhost:'+PORT+'/admin');
    if(process.env.OPEN!=='0' && process.platform==='win32' && !USE_SUPABASE){
      const { exec } = require('child_process');
      exec('cmd /c start "" "http://localhost:'+PORT+'/"');
    }
  });
  ensureBoot()
    .then(()=>warmHtmlCache())                       // 先把首页/详情页渲染好，第一个访客也不用等
    .catch(e=>console.error('[Boot Error]', e));
  setTimeout(()=>prewarmImages(), 3000);
})();
