# -*- coding: utf-8 -*-
"""
生成微信分享卡片大图（JPG）。
微信分享缩略图不支持 SVG，必须用 JPG/PNG，否则卡片只显示文字没图。
用法：python tools/gen_share.py
会读取 data/config.json + data/products.json，
生成 public/assets/share.jpg（首页卡）与 public/assets/products/<id>-share.jpg（商品卡），
并把 shareImage 字段写回 products.json。
"""
import json, os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "public", "assets")
PROD_DIR = os.path.join(ASSETS, "products")
FONT = r"C:\Windows\Fonts\msyh.ttc"  # Microsoft YaHei

W, H = 1200, 630

def f(size, bold=False):
    return ImageFont.truetype(FONT, size, index=(1 if bold else 0))

def gradient(w, h, c1, c2):
    """对角线渐变"""
    img = Image.new("RGB", (w, h), c1)
    px = img.load()
    for y in range(h):
        for x in range(0, w, 4):  # 步长加速
            t = (x / w + y / h) / 2
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            for xx in range(x, min(x + 4, w)):
                px[xx, y] = (r, g, b)
    return img

def wrap(draw, text, font, max_w):
    lines, line = [], ""
    for ch in text:
        test = line + ch
        if draw.textlength(test, font=font) > max_w and line:
            lines.append(line); line = ch
        else:
            line = test
    if line:
        lines.append(line)
    return lines

def soft_circle(img, cx, cy, r, color):
    d = ImageDraw.Draw(img)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)

def gen_home(cfg):
    c1, c2 = (150, 90, 50), (210, 150, 110)   # 暖棕渐变
    img = gradient(W, H, c1, c2)
    d = ImageDraw.Draw(img, "RGBA")
    # 装饰大圆（半透明白）
    soft_circle(img, 1050, -120, 260, (255, 255, 255, 22))
    soft_circle(img, 120, 720, 220, (255, 255, 255, 16))

    d = ImageDraw.Draw(img)
    # 顶部小标签
    d.text((80, 70), "私域专享 · 关仓回馈", font=f(34, True), fill=(255, 240, 225))
    # 主标题
    d.text((78, 130), cfg.get("shopName", "不初限时狂欢商城"), font=f(90, True), fill=(255, 255, 255))
    # 公告（自动换行，最多 2 行）
    ann = cfg.get("announcement", "")
    if not ann:
        ann = "全场超低价回馈老客户，卖完即止。"
    lines = wrap(d, ann, f(36), W - 200)[:2]
    y = 320
    for ln in lines:
        d.text((82, y), ln, font=f(36), fill=(255, 248, 240))
        y += 52
    # 底部标语
    d.text((82, H - 110), "全场超低价  ·  卖完即止  ·  未来一年难再得", font=f(38, True), fill=(255, 230, 210))
    out = os.path.join(ASSETS, "share.jpg")
    img.save(out, "JPEG", quality=92)
    print("生成首页卡:", out)

def gen_product(p):
    c1, c2 = (120, 78, 52), (198, 140, 104)
    img = gradient(W, H, c1, c2)
    d = ImageDraw.Draw(img, "RGBA")
    soft_circle(img, -100, 700, 280, (255, 255, 255, 18))
    soft_circle(img, 1120, -100, 240, (255, 255, 255, 20))
    d = ImageDraw.Draw(img)

    # 分类标签
    cat = p.get("category", "")
    if cat:
        d.text((80, 70), cat, font=f(36, True), fill=(255, 235, 215))
    # 商品名（最多 2 行）
    lines = wrap(d, p.get("name", ""), f(70, True), W - 200)[:2]
    y = 150
    for ln in lines:
        d.text((78, y), ln, font=f(70, True), fill=(255, 255, 255))
        y += 92
    # 价格
    price = p.get("price", 0)
    orig = p.get("originalPrice", 0)
    d.text((82, y + 20), "¥" + str(price), font=f(110, True), fill=(255, 220, 120))
    if orig and orig > price:
        tx = 82 + d.textlength("¥" + str(price), font=f(110, True)) + 30
        d.text((tx, y + 60), "原价 ¥" + str(orig), font=f(40), fill=(235, 215, 200))
    # 底部标语
    d.text((82, H - 100), "不初限时狂欢商城 · 全场超低价 · 卖完即止", font=f(34, True), fill=(255, 235, 215))
    out = os.path.join(PROD_DIR, p["id"] + "-share.jpg")
    img.save(out, "JPEG", quality=92)
    print("生成商品卡:", out)
    return "/assets/products/" + p["id"] + "-share.jpg"

def main():
    cfg = json.load(open(os.path.join(ROOT, "data", "config.json"), encoding="utf-8"))
    products = json.load(open(os.path.join(ROOT, "data", "products.json"), encoding="utf-8"))
    gen_home(cfg)
    for p in products:
        p["shareImage"] = gen_product(p)
    json.dump(products, open(os.path.join(ROOT, "data", "products.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    # 把首页分享图写进 config
    cfg["shareImage"] = "/assets/share.jpg"
    json.dump(cfg, open(os.path.join(ROOT, "data", "config.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("完成，已写回 products.json / config.json 的 shareImage 字段")

if __name__ == "__main__":
    main()
