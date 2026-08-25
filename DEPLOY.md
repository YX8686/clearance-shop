# 不初限时狂欢商城 · 免费云端部署教程

> 目标：让客户在**手机微信**里点开你分享的商城链接，能看到**带大图的卡片**，点进去就能浏览、下单；你在云端后台管理订单、发货。
> 全部用**免费**服务，无需信用卡。

---

## 一、你需要准备什么（全部免费）

| 服务 | 作用 | 注册方式 |
|------|------|----------|
| **GitHub** | 存代码 | 用邮箱 / GitHub 账号登录（免费） |
| **Supabase** | 存数据（订单 / 产品 / 配置 + 图片） | 用 GitHub 登录（免费，500MB 库 + 1GB 存储） |
| **Render** | 跑商城服务（自动 HTTPS、免备案） | 用 GitHub 登录（免费，750 小时/月） |
| **UptimeRobot** | 防止 Render 休眠（可选但强烈建议） | 邮箱注册（免费） |

只需能上网的电脑，跟着步骤走即可。三个平台都用同一个 GitHub 账号授权最省事。

---

## 二、整体架构（一句话）

`代码放 GitHub` → `Render 拉代码把商城跑起来` → `订单/产品/图片存到 Supabase`。

客户访问 `https://buchu-shop.onrender.com` 就是公网可打开的商城；微信分享时自动抓取卡片大图。

---

## 三、步骤 1：建 Supabase（数据仓库）

1. 打开 https://supabase.com ，点 **Start your project**，用 GitHub 登录。
2. **New project**：
   - Name：`buchu-shop`
   - Region：**Southeast Asia (Singapore)**（离国内近、快）
   - Database Password：设一个并**记好**（本项目用 anon key，不需要它，但建项目时要填）
   - 点 **Create new project**，等 1–2 分钟。
3. 左侧菜单 **API Keys**，复制两样东西（后面填到 Render）：
   - **Project URL**：形如 `https://xxxx.supabase.co`（注意：从 URL 栏复制时可能带 `/rest/v1/` 后缀，必须**去掉**，只保留 `https://xxxx.supabase.co`）
   - **Publishable key**（新版 Supabase 把旧的 `anon public` 改名为 `Publishable key`，二者等价，形如 `sb_publishable_xxxx`）
4. 左侧 **SQL Editor → New query**，把下面整段 SQL 粘进去，点 **Run**：

```sql
-- 1) 数据表：云端存 products / config / orders
CREATE TABLE IF NOT EXISTS shop_data (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2) 开放 shop_data 表的匿名读写（小型私有商城，风险可控）
ALTER TABLE shop_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all_shop_data ON shop_data;
CREATE POLICY allow_all_shop_data ON shop_data
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- 3) 创建图片桶（名字必须叫 shop）
INSERT INTO storage.buckets (id, name, public)
VALUES ('shop', 'shop', true)
ON CONFLICT (id) DO NOTHING;

-- 4) 允许匿名对 shop 桶上传 / 下载 / 删除图片（关键：否则后台传图会被拒）
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_shop_anon ON storage.objects;
CREATE POLICY allow_shop_anon ON storage.objects
  FOR ALL TO anon
  USING (bucket_id = 'shop')
  WITH CHECK (bucket_id = 'shop');
```

5. 左侧 **Storage**，确认多了一个 `shop` 桶且是 **Public**（SQL 已建好，这里只是核对）。

---

## 四、步骤 2：把代码推到 GitHub

1. 打开 https://github.com ，**New repository**：
   - Repository name：`buchu-shop`
   - 选 **Public**
   - 不要勾 Add README（我们已有代码）
   - **Create repository**
2. 把商城文件夹内容传上去。**推荐用 GitHub Desktop**（最简单）：
   - 安装 GitHub Desktop → **File → Add Local Repository** → 选你电脑里的 `clearance-shop` 文件夹
   - **Publish repository** → 选你刚建的 `buchu-shop` → **Push**
   - 要传的内容：`server.js`、`public/`、`views/`、`data/`、`package.json`、`render.yaml`、`.gitignore`
   - （`data/` 里的 `.backup`、`.tmp` 临时文件已被 `.gitignore` 自动忽略，不用管）
3. 传完去 GitHub 网页看一眼，应能看到这些文件。

> 不会用 GitHub Desktop 也可在 GitHub 网页仓库里点 **Add file → Upload files** 把文件拖进去（文件夹逐个拖）。

---

## 五、步骤 3：Render 跑服务

1. 打开 https://render.com ，用 GitHub 登录 → **New → Web Service** → 连 GitHub 选 `buchu-shop` 仓库。
2. 配置：
   - **Name**：`buchu-shop`
   - **Region**：`Singapore`
   - **Branch**：`main`
   - **Build Command**：`npm install`
   - **Start Command**：`node server.js`
   - **Instance Type**：**Free**
3. 展开 **Advanced → Add Environment Variable**，填两项：
   - `SUPABASE_URL` = 你的 Project URL（步骤1第3步复制的）
   - `SUPABASE_ANON_KEY` = 你的 anon public key
4. 点 **Create Web Service**，等几分钟部署。出现绿色 **Live** 后，会给你一个地址：
   `https://buchu-shop.onrender.com`
5. 点这个地址，应看到商城首页（和本地一模一样）。

---

## 六、步骤 4：防休眠（强烈建议）

Render 免费版 **15 分钟没人访问就会睡**，首次唤醒要 30–60 秒，微信抓分享卡片可能因此超时显示不出大图。用 UptimeRobot 免费保活：

1. https://uptimerobot.com 注册（邮箱）→ **Add New Monitor**
2. Monitor Type：**HTTP(s)**；Friendly Name：`buchu-shop`
3. URL：你的 `https://buchu-shop.onrender.com`
4. Monitoring Interval：**Every 5 minutes** → **Create Monitor**

之后 Render 一直醒着，微信里秒开、卡片秒出图。

---

## 七、步骤 5：验证微信分享大图卡片

1. 手机微信 → 把 `https://buchu-shop.onrender.com/` 发到「文件传输助手」或任意群里。
2. 看卡片：应显示**店铺名 + 你的公告 + 大图**（就是桌面图标那张红底大图）。
3. 点卡片 → 进入商城首页。
4. 发某个产品链接 `https://buchu-shop.onrender.com/product/产品ID` → 卡片显示**该产品主图**。
5. 若卡片没出图：等几分钟让微信重新抓取，或改一下店铺公告触发重新抓取即可。

---

## 八、上线后你必须知道的事

- **云端后台**才是线上管理：`https://buchu-shop.onrender.com/admin`（产品 / 订单 / 发货）。你电脑**本地的后台只用于本地测试**，两者数据分离。
- **图片上传**：云端后台上传的产品图、收款码会存到 Supabase（重启不丢）；本地后台传的图只在你电脑上，不上云。
- **数据持久**：订单 / 产品 / 配置都存在 Supabase，Render 重启不丢。
- **隐私提醒**：客户的姓名 / 电话 / 地址会存到**海外（Singapore）免费服务器**，属于数据出境，请确认符合你的合规要求。
- **免费额度**：Render 750 小时/月（配合保活可 24/7）；Supabase 500MB 数据库 + 1GB 存储，足够小商城长期使用。
- **自定义域名**：免费版也能绑你自己的域名（需你先买域名并做解析）。不绑也完全可用 `.onrender.com` 地址。

---

## 九、改了代码怎么更新

GitHub Desktop 里 **Push** 新代码 → Render 监测到 `main` 分支变动会**自动重新部署**（每次 push 自动 build）。不用手动操作。

---

## 十、常见问题

- **部署红 / 首页打不开**：看 Render 的 **Deploy Logs**。最常见是环境变量 `SUPABASE_URL` / `SUPABASE_ANON_KEY` 漏填，或 Supabase 的 `shop_data` 表没建。
- **分享卡片没图**：确认 Supabase 的 `shop` 桶是 **Public**；确认 `shop_data` 表里 `config` 的 `shareImage` 是绝对 https 地址（代码已自动拼，一般不用管）。
- **后台看不到订单**：确认 Supabase 的 `shop_data` 表存在且已建 `allow_all_shop_data` 策略（步骤1 SQL 已做）。
- **本地商城还能用吗**：能。你电脑上双击桌面「不初限时狂欢商城」仍走本地文件模式，照常使用，不受云端影响。

---

## 附：环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `SUPABASE_URL` | 云端必填 | Supabase 项目 URL |
| `SUPABASE_ANON_KEY` | 云端必填 | Supabase anon public key |
| `PORT` | 否 | Render 自动注入，本地默认 4100 |
| `OPEN` | 否 | 本地设 `0` 可禁止自动开浏览器 |
