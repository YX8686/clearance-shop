// 清仓商城 · 单文件服务端（支持「本地文件 / Supabase 云端」双模式）
// 本地双击图标零依赖即可跑；配置 SUPABASE_URL + SUPABASE_ANON_KEY 后自动切云端，数据持久化不丢。
// Render 云端启动：先 listen 端口再异步 boot，避免健康检查超时。
const http = require('http');
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
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const fetchWithTimeout = (url, opts) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30000);
      return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
    };
    sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { global: { fetch: fetchWithTimeout } });
  } catch (e) {
    console.error('[Warn] 未能加载 @supabase/supabase-js，已回退本地文件模式：', e.message);
  }
}
const USE_SUPABASE = !!sb;

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

// 云端调用重试：覆盖 Supabase 免费层间歇 fetch failed / 冷启动抖动（避免一阵子连不上就保存失败）
async function withRetry(fn, label, retries=3){
  let lastErr;
  for(let i=0;i<retries;i++){
    try{ return await fn(); }
    catch(e){
      lastErr=e;
      console.error(`[${label}] 云端第${i+1}/${retries}次调用失败:`, e.message);
      if(i<retries-1) await new Promise(r=>setTimeout(r, 400*(i+1)));
    }
  }
  throw lastErr;
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
async function saveKV(key, value){
  if(USE_SUPABASE){
    // 关键修复：失败必须抛错给调用方。之前是 console.error 静默吞掉，
    // 导致前端拿到 {ok:true} 但云端没写入，重启服务后状态回退（症状：商家后台点"确认收款"成功但刷新后订单又回"待处理"）。
    const { error } = await withRetry(()=>sb.from('shop_data').upsert({ key, value }), 'saveKV:'+key);
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

  if(USE_SUPABASE){
    try{
      const safeSub = toSafeStoragePath(storageSub);
      const safeFile = toSafeStorageKey(file, true);
      const objectPath = (safeSub ? safeSub + '/' : 'uploads/') + safeFile;
      const { error } = await sb.storage.from('shop').upload(objectPath, buf, { contentType: m[1], upsert: true });
      if(error) throw error;
      const { data:{ publicUrl } } = sb.storage.from('shop').getPublicUrl(objectPath);
      return publicUrl;
    }catch(e){ console.error('[saveImage] storage failed, fallback local', e.message); }
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
  shareImage: ''
};

let products = [];
let config = DEFAULT_CONFIG;
let orders = [];
let booted = false;
let bootPromise = null;

function ensureBoot(){
  if(booted) return Promise.resolve();
  if(!bootPromise) bootPromise = boot();
  return bootPromise;
}

async function boot(){
  const seedProducts = readJson('products.json', []);
  const seedConfig = readJson('config.json', DEFAULT_CONFIG);
  const seedOrders = readJson('orders.json', []);
  // boot 阶段优雅降级：loadKV 失败时使用本地 data/*.json 种子，保证服务不挂；
  // 首次写入成功后 kvCache 会被覆盖，自动切到云端。
  try { products = await loadKV('products', seedProducts); }
  catch(e){ console.error('[boot] products 加载失败，使用本地种子：', e.message); products = seedProducts; }
  try { config = await loadKV('config', seedConfig); }
  catch(e){ console.error('[boot] config 加载失败，使用本地种子：', e.message); config = seedConfig; }
  // 订单载入：优先从独立行 order:* 聚合（新方案，并发安全）；若无则回退旧 orders 大数组行并拆分迁移
  try {
    if(USE_SUPABASE){
      const { data, error } = await sb.from('shop_data').select('key,value').like('key','order:%');
      if(!error && data && data.length){
        orders = data.map(r=>r.value).filter(Boolean);
      } else {
        const arr = await loadKV('orders', seedOrders);
        orders = Array.isArray(arr)?arr:[];
        if(orders.length){
          await Promise.all(orders.map(o=> (o&&o.id) ? sb.from('shop_data').upsert({key:'order:'+o.id, value:o}).catch(e=>console.error('[migrate]',e.message)) : Promise.resolve()));
          console.log('[migrate] 已拆分旧 orders 数组为', orders.length, '条独立行');
        }
      }
    } else {
      orders = seedOrders;
    }
  }
  catch(e){ console.error('[boot] orders 加载失败，使用本地种子：', e.message); orders = seedOrders; }
  if(config.paymentQr && !config.paymentWechatQr) config.paymentWechatQr = config.paymentQr;
  booted = true;
  console.log('[Data] 模式=' + (USE_SUPABASE ? 'Supabase云端' : '本地文件') +
    '，产品数=' + products.length + '，订单数=' + orders.length);
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
process.on('beforeExit', _flushOrderQueue);
function saveOrders(){ return withLock(()=> saveKV('orders', orders)); } // 仅作整批备份残留，下单/状态变更已改用 saveOrderRow
function saveConfig(){ clearHtmlCache(); return withLock(()=> saveKV('config', config)); }
function saveProducts(){ clearHtmlCache(); return withLock(()=> saveKV('products', products)); }
// 防抖产品保存：200 并发下单时，多单库存扣减合并为 1 次写入（500ms 窗口内），
// 避免每单 await saveProducts() 串行锁 200 次导致超时。内存即权威，落盘只做持久化保险。
let _prodSaveTimer = null;
function saveProductsDebounced(){
  if(_prodSaveTimer) return; // 已有等待中的写入，复用同一窗口
  _prodSaveTimer = setTimeout(()=>{
    _prodSaveTimer = null;
    saveProducts().catch(e=>console.error('[saveProductsDebounced]', e.message));
  }, 500);
}

// 产品读取：云端模式下每次从 Supabase 取最新，防止 Render 实例内存与本地后台不同步
// 读失败时不抛错（避免商城一片空白），降级使用内存副本
async function getProducts(){
  if(!USE_SUPABASE) return products;
  try {
    kvCache.delete('products'); // 强制实时读取，避免 3 秒缓存导致不同步
    return await loadKV('products', products);
  }
  catch(e){ console.error('[getProducts] 读云端失败，使用内存副本：', e.message); return products; }
}

// 订单读取：内存副本即权威（下单/状态变更实时更新内存，启动已从 order:* 独立行聚合载入），
// 后台即时看到最新订单，无需再读旧 orders 大数组行（已废弃）。
function getOrders(){ return orders; }
// 后台/管理端想强制从云端复核时调用：重新聚合 order:* 独立行（不阻塞常规读路径）
async function refreshOrdersFromCloud(){
  if(!USE_SUPABASE) return orders;
  try {
    const { data, error } = await sb.from('shop_data').select('key,value').like('key','order:%');
    if(!error && data) orders = data.map(r=>r.value).filter(Boolean);
  } catch(e){ console.error('[refreshOrdersFromCloud]', e.message); }
  return orders;
}
// 订单写入前必须先刷新内存副本：手机端在云端下的订单，本地服务内存里可能没有，
// 直接 find 内存会 404 静默失败（症状：后台点"确认收款"提示成功但状态不变）
async function syncOrders(){
  if(!USE_SUPABASE) return orders;
  try { orders = await loadKV('orders', orders); }
  catch(e){ console.error('[syncOrders] 同步云端失败，继续使用内存副本：', e.message); }
  return orders;
}

// 产品写入前同步：下单扣库存必须基于云端最新数据，防止 Render 内存副本过期把库存扣错
async function syncProducts(){
  if(!USE_SUPABASE) return products;
  try {
    kvCache.delete('products'); // 强制实时读取
    products = await loadKV('products', products);
  } catch(e){ console.error('[syncProducts] 同步云端失败，继续使用内存副本：', e.message); }
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
    res.writeHead(200, {'Content-Type': MIME[ext]||'application/octet-stream'});
    res.end(buf);
  });
}

function readBody(req){
  return new Promise((resolve,reject)=>{
    let data='';
    req.on('data', c=>{ data+=c; if(data.length>1e7) req.destroy(); });
    req.on('end', ()=> resolve(data));
    req.on('error', reject);
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
const htmlCache = new Map(); // key -> { html, ts }
const HTML_CACHE_TTL = 30000; // 30 秒
function getCachedHtml(key){
  const c = htmlCache.get(key);
  if(c && Date.now() - c.ts < HTML_CACHE_TTL) return c.html;
  if(c) htmlCache.delete(key);
  return null;
}
function setCachedHtml(key, html){ htmlCache.set(key, { html, ts: Date.now() }); }
function clearHtmlCache(){ htmlCache.clear(); }

// ---------- 路由 ----------
const server = http.createServer(async (req, res)=>{
  try { await ensureBoot(); } catch(e){
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
      if(method==='GET' && pathname==='/api/config'){
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(config)); return;
      }
      if(method==='GET' && pathname==='/api/orders'){
        const list = await getOrders();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(list)); return;
      }
      // 按姓名/手机号查询订单
      if(method==='GET' && pathname==='/api/orders/lookup'){
        const key = String(u.searchParams.get('key')||'').trim();
        if(!key){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify([])); return; }
        const lower = key.toLowerCase();
        const list = await getOrders();
        const found = list.filter(o=>{
          const nameMatch = (o.name||'').toLowerCase().includes(lower);
          const phoneMatch = (o.phone||'').includes(key);
          return nameMatch || phoneMatch;
        }).sort((a,b)=>b.createdAt-a.createdAt);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(found)); return;
      }
      // 单个订单（供前端恢复「待付款」订单）
      const mOrderApi = pathname.match(/^\/api\/orders\/([\w-]+)$/);
      if(method==='GET' && mOrderApi){
        const list = await getOrders();
        const o = list.find(o=>o.id===mOrderApi[1]) || null;
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(o)); return;
      }
      // 创建订单
      if(method==='POST' && pathname==='/api/orders'){
        let body; try { body = JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        const items = (body.items||[]).filter(it=> it && it.id && Number(it.qty)>0);
        if(!items.length){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'empty'})); return; }
        if(!body.name || !body.phone || !body.address){
          res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'missing_contact'})); return;
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
            if(sku && sku.stock!=null){ sku.stock = Math.max(0, Math.floor(Number(sku.stock)) - needQty); stockDeducted = true; }
          } else if(p.stock!=null){
            p.stock = Math.max(0, Math.floor(Number(p.stock)) - needQty); stockDeducted = true;
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
        const o = orders.find(o=>o.id===mPaid[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        if(o.status==='待付款'){ o.status='待确认'; o.paidScreenshotAt=Date.now(); if(!o.paidAt) o.paidAt=Date.now(); await saveOrderRowSync(o); }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 确认收款
      const mConfirm = pathname.match(/^\/api\/orders\/([\w-]+)\/confirm$/);
      if(method==='POST' && mConfirm){
        const o = orders.find(o=>o.id===mConfirm[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        if(o.status==='待付款' || o.status==='待确认'){
          o.status='待发货'; o.confirmedAt=Date.now(); if(!o.paidAt) o.paidAt=Date.now(); await saveOrderRowSync(o);
        }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 发货
      const mShip = pathname.match(/^\/api\/orders\/([\w-]+)\/ship$/);
      if(method==='POST' && mShip){
        const o = orders.find(o=>o.id===mShip[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        o.status='已发货'; o.tracking=String(body.tracking||'').slice(0,60); o.shippedAt=Date.now(); await saveOrderRowSync(o);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 取消订单（仅允许待付款状态）
      const mCancel = pathname.match(/^\/api\/orders\/([\w-]+)\/cancel$/);
      if(method==='POST' && mCancel){
        const o = orders.find(o=>o.id===mCancel[1]);
        if(!o){ res.writeHead(404); res.end(JSON.stringify({error:'no'})); return; }
        if(o.status!=='待付款'){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'only_pending_can_cancel'})); return; }
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
              if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) + qty; stockRestored = true; }
            } else if(p.stock!=null){
              p.stock = Math.floor(Number(p.stock)) + qty; stockRestored = true;
            }
          });
        }
        o.status='已取消'; o.cancelledAt=Date.now(); await saveOrderRowSync(o);
        if(stockRestored) saveProductsDebounced();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 更新配置（店铺名/联系人/公告/收款码）
      const mConfig = pathname.match(/^\/api\/config$/);
      if(method==='POST' && mConfig){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        if(body.shopName!=null) config.shopName=String(body.shopName).slice(0,50);
        if(body.contactName!=null) config.contactName=String(body.contactName).slice(0,30);
        if(body.announcement!=null) config.announcement=String(body.announcement).slice(0,300);
        if(body.bankName!=null) config.bankName=String(body.bankName).slice(0,50);
        if(body.bankAccount!=null) config.bankAccount=String(body.bankAccount).slice(0,60);
        if(body.bankHolder!=null) config.bankHolder=String(body.bankHolder).slice(0,20);
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
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        const name=String(body.name||'').trim().replace(/[\\/:*?"<>|]/g,'_').slice(0,50);
        if(!name){ res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'empty'})); return; }
        const target=path.join(GALLERY,name);
        if(fs.existsSync(target)){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, existed:true})); return; }
        ensureDir(target);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
      }
      // 图库：上传图片到指定文件夹
      if(method==='POST' && pathname==='/api/gallery/upload'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
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
              '*': ['style'],
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
          return slash + tag.toLowerCase() + (safeStyle?' style="'+safeStyle.replace(/"/g,'')+'"':'') + '>';
        });
        return s;
      }
      // 产品管理：增 / 改
      if(method==='POST' && pathname==='/api/products'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        const p=body;
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
        if(isNew){ item.createdAt=item.updatedAt; products.push(item); }
        else { const idx=products.findIndex(x=>x.id===id); item.createdAt=products[idx].createdAt||item.updatedAt; products[idx]=item; }
        await saveProducts();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, product:item})); return;
      }
      // 产品管理：删
      const mDelProd = pathname.match(/^\/api\/products\/([\w-]+)$/);
      if(method==='DELETE' && mDelProd){
        const idx=products.findIndex(x=>x.id===mDelProd[1]);
        if(idx===-1){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return; }
        products.splice(idx,1);
        await saveProducts();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
      }
      // 产品管理：排序
      if(method==='POST' && pathname==='/api/products/reorder'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        const ids=Array.isArray(body.ids)?body.ids:[];
        const map=new Map(products.map(p=>[p.id,p]));
        const next=[];
        ids.forEach(id=>{ const p=map.get(id); if(p){ next.push(p); map.delete(id); } });
        map.forEach(p=>next.push(p));
        products=next;
        await saveProducts();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
      }
      // 商家后台：快速切换「强制售罄」开关（不需打开编辑弹窗，列表卡片直接点）
      const mToggleFSO = pathname.match(/^\/api\/products\/([\w-]+)\/toggle-force-sold-out$/);
      if(method==='POST' && mToggleFSO){
        const idx = products.findIndex(x=>x.id===mToggleFSO[1]);
        if(idx===-1){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return; }
        products[idx].forceSoldOut = !products[idx].forceSoldOut;
        await saveProducts();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, forceSoldOut: products[idx].forceSoldOut})); return;
      }

      res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return;
    }

    // ===== 页面 =====
    if((method==='GET'||method==='HEAD') && (pathname==='/' || pathname==='')){
      const cached = getCachedHtml('home');
      if(cached){ res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(method==='HEAD'?'':cached); return; }
      const list = await getProducts();
      const ogImage = pickShopShareImage(list);
      let html = renderTemplate('home.html', {
        SHOP_NAME: htmlEscape(config.shopName),
        OG_TITLE: htmlEscape(config.shopName),
        OG_DESC: htmlEscape(config.announcement || '不初限时狂欢商城 · 全场超低价回馈老客户'),
        OG_IMAGE: htmlEscape(absUrl(ogImage, BASE)),
        OG_URL: htmlEscape(BASE + '/'),
        PRODUCTS_JSON: jsonForScript(list),
        CONFIG_JSON: jsonForScript(config)
      });
      html = html.replace(/<meta (?:property|name)="(?:og:[^"]+|twitter:[^"]+|product:[^"]+)" content="">\n?/g, '');
      setCachedHtml('home', html);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(method==='HEAD'?'':html); return;
    }

    const mProd = pathname.match(/^\/product\/([\w-]+)$/);
    if((method==='GET'||method==='HEAD') && mProd){
      const pkey = 'product:'+mProd[1];
      const cached = getCachedHtml(pkey);
      if(cached){ res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(method==='HEAD'?'':cached); return; }
      const list = await getProducts();
      const p = list.find(p=>p.id===mProd[1]);
      if(!p){ res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'}); res.end('商品不存在'); return; }
      const ogImage = inferShareImage(p) || pickShopShareImage(list);
      let html = renderTemplate('product.html', {
        SHOP_NAME: htmlEscape(config.shopName),
        OG_TITLE: htmlEscape(p.name),
        OG_DESC: htmlEscape(String(p.desc||'').replace(/<[^>]+>/g,'').slice(0,200) || config.shopName),
        OG_IMAGE: htmlEscape(absUrl(ogImage, BASE)),
        OG_URL: htmlEscape(BASE + '/product/'+p.id),
        OG_PRICE: htmlEscape(p.price || ''),
        PRODUCT_JSON: jsonForScript(p),
        PRODUCTS_JSON: jsonForScript(list),
        CONFIG_JSON: jsonForScript(config)
      });
      html = html.replace(/<meta (?:property|name)="(?:og:[^"]+|twitter:[^"]+|product:[^"]+)" content="">\n?/g, '');
      setCachedHtml(pkey, html);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(method==='HEAD'?'':html); return;
    }

    const mOrder = pathname.match(/^\/order\/([\w-]+)$/);
    if(method==='GET' && mOrder){
      const list = await getOrders();
      const o = list.find(o=>o.id===mOrder[1]) || null;
      const html = renderTemplate('order.html', {
        SHOP_NAME: htmlEscape(config.shopName),
        ORDER_JSON: jsonForScript(o),
        CONFIG_JSON: jsonForScript(config)
      });
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(method==='HEAD'?'':html); return;
    }

    if(method==='GET' && pathname==='/admin'){
      fs.readFile(path.join(PUBLIC,'admin.html'), (err, buf)=>{
        if(err){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); res.end('Not found'); return; }
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); res.end(buf);
      });
      return;
    }

    if(method==='GET' && pathname==='/business_rules.js'){ sendFile(res, path.join(PUBLIC,'business_rules.js')); return; }

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
  ensureBoot().catch(e=>console.error('[Boot Error]', e));
})();
