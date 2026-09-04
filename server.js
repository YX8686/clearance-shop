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

// 云端调用重试：覆盖 Supabase 免费层间歇 fetch failed / 冷启动抖动
// 默认 2 次快速重试（失败后立即再试 1 次，间隔 600ms）。
// 以前默认 5 次指数退避（最长 6.4s）导致保存明显变慢，且前端超时重试会造成重复产品。
async function withRetry(fn, label, retries=2){
  let lastErr;
  for(let i=0;i<retries;i++){
    try{ return await fn(); }
    catch(e){
      lastErr=e;
      console.error(`[${label}] 云端第${i+1}/${retries}次调用失败:`, e.message);
      if(i<retries-1) await new Promise(r=>setTimeout(r, 600));
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
  shareImage: '',
  hiddenCategories: [],
  activityDeadline: '',
  activityStart: ''
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
  // boot 阶段优雅降级：从云端 product:* 独立行聚合；失败时使用本地 data/*.json 种子
  try { products = await loadProductsFromRows(seedProducts); }
  catch(e){ console.error('[boot] products 加载失败，使用本地种子：', e.message); products = seedProducts; }
  try { config = await loadKV('config', seedConfig); }
  catch(e){ console.error('[boot] config 加载失败，使用本地种子：', e.message); config = seedConfig; }
  // 合并默认值：后续新增字段（如 hiddenCategories）不会在老配置里缺失
  config = { ...DEFAULT_CONFIG, ...(typeof config==='object' && config ? config : {}) };
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
process.on('beforeExit', ()=>{ _flushOrderQueue(); flushDirtyProducts().catch(()=>{}); });
function saveOrders(){ return withLock(()=> saveKV('orders', orders)); } // 仅作整批备份残留，下单/状态变更已改用 saveOrderRow
function saveConfig(){ clearHtmlCache(); return withLock(()=> saveKV('config', config, 5)); }

// ===== 产品存储加固：每个产品独立存储为 shop_data 的一行（key=product:<id>）=====
// 旧方案：所有产品塞进 shop_data 的单行(key='products')，产品描述长、数量多后，
// 每次编辑都要 upsert 整个大 JSON，导致保存变慢、Supabase 免费层容易超时/失败。
// 新方案：每个产品 upsert 独立行，单行数据小、写入快，回到秒级保存；排序单独存 product_order。
const dirtyProductIds = new Set();
function markProductDirty(id){ if(id) dirtyProductIds.add(id); }
// ⚠️ 关键：supabase-js 的查询遇到网络/权限错误**不抛异常**，而是把错误放进返回对象的 error 字段。
// 早期改成分行存储时，新写的 upsert 只套了 withRetry 却没检查 error 字段 —— 一旦 Supabase 免费层
// 抖动（fetch failed）或 RLS 拦截，写入其实没成功，却被当成成功并清掉了 dirtyProductIds，
// 症状正是「后台提示保存成功，一刷新又变回旧数据」。统一封装：解析 error 并抛错，交给重试兜底。
async function sbRun(fn, label){
  const r = await withRetry(fn, label);
  if(r && r.error) throw new Error((label||'supabase')+' 失败: '+(r.error.message||JSON.stringify(r.error)));
  return r;
}
async function flushDirtyProducts(){
  if(!dirtyProductIds.size) return;
  const ids = Array.from(dirtyProductIds);
  dirtyProductIds.clear();
  clearHtmlCache();
  if(!USE_SUPABASE){
    // 本地模式仍整盘写入 products.json
    await withLock(()=> writeJsonAtomic('products.json', products));
    return;
  }
  // 云端模式：逐行 upsert；失败的 id 重新加入 dirty 待下次窗口重试
  const failed = [];
  for(const id of ids){
    const p = products.find(x=>x.id===id);
    if(!p) continue;
    try {
      await sbRun(()=>sb.from('shop_data').upsert({ key:'product:'+id, value:p }), 'saveProductRow:'+id);
    } catch(e) {
      console.error('[saveProductRow] 失败:', id, e.message);
      failed.push(id);
    }
  }
  failed.forEach(id=>dirtyProductIds.add(id));
  // 同步排序 key（排序变更较少，有脏行时顺便写）
  try {
    await saveProductOrder();
  } catch(e) {
    console.error('[saveProductOrder]', e.message);
    failed.push('product_order');
  }
  // 关键修复：云端写入失败必须让前端知道。同时把当前内存整盘写一份本地 products.json 作为备份，
  // 避免"前端显示成功但重启后数据丢失"。
  if(failed.length){
    await withLock(()=> writeJsonAtomic('products.json', products)).catch(err=>console.error('[local backup] 失败:', err.message));
    throw new Error('云端保存失败（' + failed.join(', ') + '），已写本地备份，请检查网络后重试');
  }
}
async function saveProductOrder(){
  if(!USE_SUPABASE) return;
  const order = products.map(p=>p.id);
  // 关键修复：必须检查 error 字段，否则排序写入失败会被静默吞掉（supabase-js 不抛异常）
  await sbRun(()=>sb.from('shop_data').upsert({ key:'product_order', value:order }), 'saveProductOrder');
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
async function getProducts(){
  if(!USE_SUPABASE) return products;
  if(dirtyProductIds.size) return products;
  try { return await loadProductsFromRows(products); }
  catch(e){ console.error('[getProducts] 读云端失败，使用内存副本：', e.message); return products; }
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
        const out = { ...DEFAULT_CONFIG, ...(typeof config==='object' && config && !Array.isArray(config) ? config : {}) };
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(out)); return;
      }
      if(method==='GET' && pathname==='/api/orders'){
        // 关键：让 /api/orders 始终反映云端最新状态（外部进程如 buchu-ship-cloud
        // 也会写 order:<id> 单行，仅靠内存副本会看不到）
        await refreshOrdersFromCloud();
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
            if(sku && sku.stock!=null){ sku.stock = Math.max(0, Math.floor(Number(sku.stock)) - needQty); stockDeducted = true; markProductDirty(pid); }
          } else if(p.stock!=null){
            p.stock = Math.max(0, Math.floor(Number(p.stock)) - needQty); stockDeducted = true; markProductDirty(pid);
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
      // 商家后台「今日可发订单」→ 全部导出：把当前允许采集的待发货订单形成一个「商城本次汇总单」，
      // 追加到 mall_sessions 数组（一天可多次汇总）。发货管家 /shipper 读取 sessions 列表。
      const mMallExport = pathname.match(/^\/api\/mall-today-export$/);
      if(method==='POST' && mMallExport){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        const date = String(body.date||new Date().toISOString().slice(0,10));
        const orders = Array.isArray(body.orders) ? body.orders.filter(o=>o && o.id && o.phone) : [];
        const session = {
          sessionId: 'M'+Date.now().toString(36)+Math.random().toString(36).slice(2,4),
          ts: Date.now(), date, orders
        };
        try {
          const arr = await loadKV('mall_sessions', []);
          const list = Array.isArray(arr) ? arr : [];
          list.push(session);
          await saveKV('mall_sessions', list);
        }
        catch(e){ res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'save_failed', message:e.message})); return; }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, sessionId:session.sessionId, ts:session.ts, count:orders.length, totalSessions:(await loadKV('mall_sessions',[])).length})); return;
      }
      // 取消订单（允许待付款 / 待确认 状态，含商家端「未收到该款项」）
      const mCancel = pathname.match(/^\/api\/orders\/([\w-]+)\/cancel$/);
      if(method==='POST' && mCancel){
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
              if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) + qty; stockRestored = true; markProductDirty(it.id); }
            } else if(p.stock!=null){
              p.stock = Math.floor(Number(p.stock)) + qty; stockRestored = true; markProductDirty(it.id);
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
                if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) - qty; markProductDirty(it.id); }
              } else if(p.stock!=null){
                p.stock = Math.floor(Number(p.stock)) - qty; markProductDirty(it.id);
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
              if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) - qty; stockRededucted = true; markProductDirty(it.id); }
            } else if(p.stock!=null){
              p.stock = Math.floor(Number(p.stock)) - qty; stockRededucted = true; markProductDirty(it.id);
            }
          });
        }
        const prevStatus = o.status;
        const prevRestoredAt = o.restoredAt;
        const prevRestoredCount = o.restoredCount;
        o.status='待发货';
        o.restoredAt=Date.now();
        o.restoredCount=(o.restoredCount||0)+1;
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
                if(sku && sku.stock!=null){ sku.stock = Math.floor(Number(sku.stock)) + qty; markProductDirty(it.id); }
              } else if(p.stock!=null){
                p.stock = Math.floor(Number(p.stock)) + qty; markProductDirty(it.id);
              }
            });
          }
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'save_failed', message:e.message})); return;
        }
        if(stockRededucted) saveProductsDebounced();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, order:o, status:o.status})); return;
      }
      // 更新配置（店铺名/联系人/公告/收款码）
      const mConfig = pathname.match(/^\/api\/config$/);
      if(method==='POST' && mConfig){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        if(body.shopName!=null) config.shopName=String(body.shopName).slice(0,50);
        if(body.contactName!=null) config.contactName=String(body.contactName).slice(0,30);
        if(body.announcement!=null) config.announcement=String(body.announcement).slice(0,300);
        if(body.activityDeadline!=null) config.activityDeadline=String(body.activityDeadline).slice(0,50);
        if(body.activityStart!=null) config.activityStart=String(body.activityStart).slice(0,50);
        if(body.bankName!=null) config.bankName=String(body.bankName).slice(0,50);
        if(body.bankAccount!=null) config.bankAccount=String(body.bankAccount).slice(0,60);
        if(body.bankHolder!=null) config.bankHolder=String(body.bankHolder).slice(0,20);
        if(body.hiddenCategories!=null){
          const arr=Array.isArray(body.hiddenCategories)?body.hiddenCategories:[];
          config.hiddenCategories=arr.map(x=>String(x).trim().slice(0,50)).filter(Boolean);
        }
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
              '*': ['style','class'],
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
          return slash + tag.toLowerCase() + (safeStyle?' style="'+safeStyle.replace(/"/g,'')+'"':'') + (safeCls?' class="'+safeCls+'"':'') + '>';
        });
        return s;
      }
      // 产品管理：增 / 改
      if(method==='POST' && pathname==='/api/products'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
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
        // 产品改为独立行存储：只 upsert 当前产品，回到秒级保存
        markProductDirty(item.id);
        try {
          await flushDirtyProducts();
        } catch(e) {
          console.error('[POST /api/products] flushDirtyProducts 失败:', e.message);
          res.writeHead(500,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:false, message:'云端保存失败：'+e.message})); return;
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
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        const ids=Array.isArray(body.ids)?body.ids:[];
        const map=new Map(products.map(p=>[p.id,p]));
        const next=[];
        ids.forEach(id=>{ const p=map.get(id); if(p){ next.push(p); map.delete(id); } });
        map.forEach(p=>next.push(p));
        products=next;
        await saveProductOrder();
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
        products[idx].forceSoldOut = !products[idx].forceSoldOut;
        markProductDirty(pid);
        await flushDirtyProducts();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, forceSoldOut: products[idx].forceSoldOut})); return;
      }
      // 商家后台：快速切换「隐藏/上架」开关（隐藏后买家端完全不可见）
      const mToggleHidden = pathname.match(/^\/api\/products\/([\w-]+)\/toggle-hidden$/);
      if(method==='POST' && mToggleHidden){
        const idx = products.findIndex(x=>x.id===mToggleHidden[1]);
        if(idx===-1){ res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return; }
        const pid = mToggleHidden[1];
        products[idx].hidden = !products[idx].hidden;
        markProductDirty(pid);
        await flushDirtyProducts();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, hidden: products[idx].hidden})); return;
      }

      res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return;
    }

    // ===== 页面 =====
    if((method==='GET'||method==='HEAD') && (pathname==='/' || pathname==='')){
      const cached = getCachedHtml('home');
      if(cached){ res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(method==='HEAD'?'':cached); return; }
      const list = await getProducts();
      const ogImage = pickShopShareImage(list);
      const safeConfig = { ...DEFAULT_CONFIG, ...(typeof config==='object' && config && !Array.isArray(config) ? config : {}) };
      let html = renderTemplate('home.html', {
        SHOP_NAME: htmlEscape(safeConfig.shopName),
        OG_TITLE: htmlEscape(safeConfig.shopName),
        OG_DESC: htmlEscape(safeConfig.announcement || '不初限时狂欢商城 · 全场超低价回馈老客户'),
        OG_IMAGE: htmlEscape(absUrl(ogImage, BASE)),
        OG_URL: htmlEscape(BASE + '/'),
        PRODUCTS_JSON: jsonForScript(list),
        CONFIG_JSON: jsonForScript(safeConfig)
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
        // 隐藏产品或被隐藏分类下的产品：买家端详情页直接返回不存在
        const hiddenCats = Array.isArray(config.hiddenCategories)?config.hiddenCategories:[];
        if(p.hidden || (p.category && hiddenCats.includes(p.category))){
          res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'}); res.end('商品不存在'); return;
        }
        const ogImage = inferShareImage(p) || pickShopShareImage(list);
        const safeConfig = { ...DEFAULT_CONFIG, ...(typeof config==='object' && config && !Array.isArray(config) ? config : {}) };
        let html = renderTemplate('product.html', {
          SHOP_NAME: htmlEscape(safeConfig.shopName),
          OG_TITLE: htmlEscape(p.name),
          OG_DESC: htmlEscape(String(p.desc||'').replace(/<[^>]+>/g,'').slice(0,200) || safeConfig.shopName),
          OG_IMAGE: htmlEscape(absUrl(ogImage, BASE)),
          OG_URL: htmlEscape(BASE + '/product/'+p.id),
          OG_PRICE: htmlEscape(p.price || ''),
          PRODUCT_JSON: jsonForScript(p),
          PRODUCTS_JSON: jsonForScript(list),
          CONFIG_JSON: jsonForScript(safeConfig)
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
