// 清仓商城 · 单文件服务端（支持「本地文件 / Supabase 云端」双模式）
// 本地双击图标零依赖即可跑；配置 SUPABASE_URL + SUPABASE_ANON_KEY 后自动切云端，数据持久化不丢。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const VIEWS = path.join(ROOT, 'views');
const GALLERY = path.join(PUBLIC, 'assets', 'gallery');
const PORT = process.env.PORT || 4100;

// ---------- Supabase 客户端（仅在配置了环境变量时启用；本地模式零依赖也能跑） ----------
let sb = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
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
async function loadKV(key, fallback){
  if(USE_SUPABASE){
    try{
      const { data, error } = await sb.from('shop_data').select('value').eq('key', key).maybeSingle();
      if(!error && data) return data.value;
    }catch(e){ console.error('[loadKV]', key, e.message); }
    return fallback;
  }
  return readJson(key + '.json', fallback);
}
async function saveKV(key, value){
  if(USE_SUPABASE){
    try{
      const { error } = await sb.from('shop_data').upsert({ key, value });
      if(error) console.error('[saveKV]', key, error.message);
    }catch(e){ console.error('[saveKV]', key, e.message); }
    return;
  }
  writeJsonAtomic(key + '.json', value);
}

// ---------- 图片写入（云端=Supabase Storage；本地=PUBLIC/assets） ----------
// storageSub：云端 bucket 内的子路径；本地模式始终写 PUBLIC/assets 根
async function saveImage(base64, fileName, storageSub){
  const m = String(base64).match(/^data:(image\/\w+);base64,(.+)$/);
  if(!m) return '';
  const ext = m[1]==='image/png'?'png':(m[1]==='image/jpeg'?'jpg':(m[1]==='image/webp'?'webp':'png'));
  const buf = Buffer.from(m[2], 'base64');
  const file = String(fileName||'img').replace(/[\\/:*?"<>|]/g,'_').replace(/\.[^.]+$/,'') + '.' + ext;
  if(USE_SUPABASE){
    try{
      const objectPath = (storageSub ? storageSub + '/' : 'uploads/') + file;
      const { error } = await sb.storage.from('shop').upload(objectPath, buf, { contentType: m[1], upsert: true });
      if(error){ console.error('[saveImage] storage', error.message); return ''; }
      const { data:{ publicUrl } } = sb.storage.from('shop').getPublicUrl(objectPath);
      return publicUrl;
    }catch(e){ console.error('[saveImage]', e.message); return ''; }
  }
  fs.writeFileSync(path.join(PUBLIC, 'assets', file), buf);
  return '/assets/' + file;
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
  shareImage: '/assets/share-square.jpg'
};

let products = [];
let config = DEFAULT_CONFIG;
let orders = [];

async function boot(){
  const seedProducts = readJson('products.json', []);
  const seedConfig = readJson('config.json', DEFAULT_CONFIG);
  const seedOrders = readJson('orders.json', []);
  products = await loadKV('products', seedProducts);
  config = await loadKV('config', seedConfig);
  orders = await loadKV('orders', seedOrders);
  if(config.paymentQr && !config.paymentWechatQr) config.paymentWechatQr = config.paymentQr;
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

function saveOrders(){ return withLock(()=> saveKV('orders', orders)); }
function saveConfig(){ return withLock(()=> saveKV('config', config)); }
function saveProducts(){ return withLock(()=> saveKV('products', products)); }

// ---------- 工具 ----------
function htmlEscape(s){ return String(s==null?'':s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function jsonForScript(obj){ return JSON.stringify(obj).replace(/</g,'\\u003c'); }
function absUrl(src, base){
  if(!src) return base + '/assets/share-square.jpg';
  const s = String(src);
  if(/^https?:\/\//i.test(s)) return s;
  if(s.startsWith('//')) return 'https:' + s;
  return base + (s.startsWith('/') ? s : '/' + s);
}
function inferShareImage(p){
  if(p.shareImage) return p.shareImage;
  const img = p.image || '';
  if(/\.svg$/i.test(img)) return img.replace(/\.svg$/i, '-share.jpg');
  return img;
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

// ---------- 路由 ----------
const server = http.createServer(async (req, res)=>{
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
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(products)); return;
      }
      if(method==='GET' && pathname==='/api/config'){
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(config)); return;
      }
      if(method==='GET' && pathname==='/api/orders'){
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(orders)); return;
      }
      // 按姓名/手机号查询订单
      if(method==='GET' && pathname==='/api/orders/lookup'){
        const key = String(u.searchParams.get('key')||'').trim();
        if(!key){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify([])); return; }
        const lower = key.toLowerCase();
        const found = orders.filter(o=>{
          const nameMatch = (o.name||'').toLowerCase().includes(lower);
          const phoneMatch = (o.phone||'').includes(key);
          return nameMatch || phoneMatch;
        }).sort((a,b)=>b.createdAt-a.createdAt);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(found)); return;
      }
      // 单个订单（供前端恢复「待付款」订单）
      const mOrderApi = pathname.match(/^\/api\/orders\/([\w-]+)$/);
      if(method==='GET' && mOrderApi){
        const o = orders.find(o=>o.id===mOrderApi[1]) || null;
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
          const p = products.find(p=>p.id===it.id);
          return { id:it.id, name: p?p.name:it.id, price: p?p.price:0, qty:Number(it.qty) };
        });
        const total = detail.reduce((s,x)=> s + x.price*x.qty, 0);
        const id = genId();
        const order = {
          id, items:detail, total,
          name:String(body.name).slice(0,50), phone:String(body.phone).slice(0,30),
          address:String(body.address).slice(0,200), wechat:String(body.wechat||'').slice(0,50),
          note:String(body.note||'').slice(0,200),
          status:'待付款', tracking:'',
          createdAt:Date.now(), paidAt:null, confirmedAt:null, shippedAt:null
        };
        orders.push(order); await saveOrders();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({id})); return;
      }
      // 客户确认已发送付款截图
      const mPaid = pathname.match(/^\/api\/orders\/([\w-]+)\/paid$/);
      if(method==='POST' && mPaid){
        const o = orders.find(o=>o.id===mPaid[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        if(o.status==='待付款'){ o.status='待确认'; o.paidScreenshotAt=Date.now(); if(!o.paidAt) o.paidAt=Date.now(); await saveOrders(); }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true, status:o.status})); return;
      }
      // 确认收款
      const mConfirm = pathname.match(/^\/api\/orders\/([\w-]+)\/confirm$/);
      if(method==='POST' && mConfirm){
        const o = orders.find(o=>o.id===mConfirm[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        if(o.status==='待付款' || o.status==='待确认'){
          o.status='待发货'; o.confirmedAt=Date.now(); if(!o.paidAt) o.paidAt=Date.now(); await saveOrders();
        }
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
      }
      // 发货
      const mShip = pathname.match(/^\/api\/orders\/([\w-]+)\/ship$/);
      if(method==='POST' && mShip){
        const o = orders.find(o=>o.id===mShip[1]);
        if(!o){ res.writeHead(404); res.end('no'); return; }
        let body={}; try { body=JSON.parse(await readBody(req)); } catch(e){}
        o.status='已发货'; o.tracking=String(body.tracking||'').slice(0,60); o.shippedAt=Date.now(); await saveOrders();
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({ok:true})); return;
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

      // 产品管理：增 / 改
      if(method==='POST' && pathname==='/api/products'){
        let body; try { body=JSON.parse(await readBody(req)); } catch(e){ res.writeHead(400); res.end('bad json'); return; }
        const p=body;
        const id=String(p.id||'').trim();
        const isNew=!id || !products.find(x=>x.id===id);
        const newId=id || crypto.randomBytes(4).toString('hex').toUpperCase();
        const item={
          id: newId,
          name: String(p.name||'未命名').trim().slice(0,100),
          subtitle: String(p.subtitle||'').trim().slice(0,300),
          price: Math.max(0, Number(p.price)||0),
          originalPrice: Math.max(0, Number(p.originalPrice)||0),
          stock: Math.max(0, Number(p.stock)||0),
          category: String(p.category||'').trim().slice(0,50),
          desc: String(p.desc||'').trim().slice(0,500),
          image: String(p.image||'/assets/products/default.svg').trim(),
          detailImages: Array.isArray(p.detailImages) ? p.detailImages.filter(u=>String(u).startsWith('/')||/^https?:/.test(u)).slice(0,20) : [],
          folder: String(p.folder||'').trim(),
          shareImage: String(p.shareImage||'').trim(),
          bundleItems: Array.isArray(p.bundleItems) ? p.bundleItems.slice(0,20).map(b=>({
            name: String(b.name||'').trim().slice(0,100),
            qty: Math.max(0, Math.floor(Number(b.qty)||0)),
            unit: String(b.unit||'件').trim().slice(0,10)
          })).filter(b=>b.name && b.qty>0) : [],
          updatedAt: Date.now()
        };
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

      res.writeHead(404,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'not found'})); return;
    }

    // ===== 页面 =====
    if(method==='GET' && (pathname==='/' || pathname==='')){
      const ogImage = config.shareImage || (products[0]&&products[0].image) || '/assets/share-square.jpg';
      const html = renderTemplate('home.html', {
        SHOP_NAME: htmlEscape(config.shopName),
        OG_TITLE: htmlEscape(config.shopName),
        OG_DESC: htmlEscape(config.announcement || '不初限时狂欢商城 · 全场超低价回馈老客户'),
        OG_IMAGE: htmlEscape(absUrl(ogImage, BASE)),
        OG_URL: htmlEscape(BASE + '/'),
        PRODUCTS_JSON: jsonForScript(products),
        CONFIG_JSON: jsonForScript(config)
      });
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); return;
    }

    const mProd = pathname.match(/^\/product\/([\w-]+)$/);
    if(method==='GET' && mProd){
      const p = products.find(p=>p.id===mProd[1]);
      if(!p){ res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'}); res.end('商品不存在'); return; }
      const ogImage = inferShareImage(p) || config.shareImage || '/assets/share-square.jpg';
      const html = renderTemplate('product.html', {
        SHOP_NAME: htmlEscape(config.shopName),
        OG_TITLE: htmlEscape(p.name),
        OG_DESC: htmlEscape(p.desc || config.shopName),
        OG_IMAGE: htmlEscape(absUrl(ogImage, BASE)),
        OG_URL: htmlEscape(BASE + '/product/'+p.id),
        PRODUCT_JSON: jsonForScript(p),
        PRODUCTS_JSON: jsonForScript(products),
        CONFIG_JSON: jsonForScript(config)
      });
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); return;
    }

    const mOrder = pathname.match(/^\/order\/([\w-]+)$/);
    if(method==='GET' && mOrder){
      const o = orders.find(o=>o.id===mOrder[1]) || null;
      const html = renderTemplate('order.html', {
        SHOP_NAME: htmlEscape(config.shopName),
        ORDER_JSON: jsonForScript(o),
        CONFIG_JSON: jsonForScript(config)
      });
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(html); return;
    }

    if(method==='GET' && pathname==='/admin'){ sendFile(res, path.join(PUBLIC,'admin.html')); return; }

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

// 先加载数据，再启动监听
(async ()=>{
  await boot();
  server.listen(PORT, '0.0.0.0', ()=>{
    console.log('不初限时狂欢商城已启动 → http://localhost:'+PORT);
    console.log('买家首页: http://localhost:'+PORT+'/');
    console.log('商家后台: http://localhost:'+PORT+'/admin');
    if(process.env.OPEN!=='0' && process.platform==='win32' && !USE_SUPABASE){
      const { exec } = require('child_process');
      exec('cmd /c start "" "http://localhost:'+PORT+'/"');
    }
  });
})();
