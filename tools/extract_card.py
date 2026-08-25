"""
银行卡正面抠图：使用 cv2 GrabCut 把银行卡从米色大理石背景中抠出。
- 假设银行卡大致居中、占图中央区域
- 边缘预检测 + GrabCut 迭代 5 次
- 输出 RGBA PNG，背景透明
"""
import sys
import cv2
import numpy as np
from PIL import Image

src = sys.argv[1]
dst = sys.argv[2]

img_bgr = cv2.imdecode(np.fromfile(src, dtype=np.uint8), cv2.IMREAD_COLOR)
if img_bgr is None:
    print('failed to read', src); sys.exit(1)
H, W = img_bgr.shape[:2]
print(f'image size: {W}x{H}')

# 估算背景：取四边外圈像素的中位色（BGR）
def sample_bg():
    border = np.concatenate([
        img_bgr[0:30, :].reshape(-1, 3),
        img_bgr[-30:, :].reshape(-1, 3),
        img_bgr[:, 0:30].reshape(-1, 3),
        img_bgr[:, -30:].reshape(-1, 3)
    ])
    return np.median(border, axis=0).astype(np.uint8)

bg_bgr = sample_bg()
print('bg color (bgr):', bg_bgr.tolist())

# 转换到 HSV 找"明显不是米色"的区域
hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
# 米色大致 H: 25-45, S: 10-80, V: 180-240
# 银行卡是金黄色，H: 20-40, S: 100-255, V: 150-255
# 卡片边缘和文字是深色，V 低
# 简单策略：用颜色距离排除明显的"非背景"色
bg_hsv = cv2.cvtColor(np.array([[bg_bgr]]), cv2.COLOR_BGR2HSV)[0,0]
print('bg hsv:', bg_hsv.tolist())

# GrabCut：1=明显前景, 2=明显背景, 3=可能前景, 0=可能背景
mask = np.zeros((H, W), np.uint8)
# 假设中央 60% 是银行卡
fx0, fy0 = int(W*0.10), int(H*0.30)
fx1, fy1 = int(W*0.90), int(H*0.70)
rect = (fx0, fy0, fx1-fx0, fy1-fy0)
print('grabcut rect:', rect)

bgdModel = np.zeros((1, 65), np.float64)
fgdModel = np.zeros((1, 65), np.float64)
cv2.grabCut(img_bgr, mask, rect, bgdModel, fgdModel, 5, cv2.GC_INIT_WITH_RECT)

# mask == 0 或 2 = 背景；1 或 3 = 前景
alpha = np.where((mask == 1) | (mask == 3), 255, 0).astype(np.uint8)

# 形态学清理：闭运算填小洞，开运算去小点
kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
alpha = cv2.morphologyEx(alpha, cv2.MORPH_CLOSE, kernel, iterations=2)
alpha = cv2.morphologyEx(alpha, cv2.MORPH_OPEN, kernel, iterations=1)

# 边缘羽化 1px
alpha = cv2.GaussianBlur(alpha, (3, 3), 0)

# 只保留最大连通区域
nb_components, output, stats, centroids = cv2.connectedComponentsWithStats(alpha, connectivity=8)
if nb_components > 1:
    # 排除背景（label 0），找最大非背景区域
    sizes = stats[:, -1][1:]
    if len(sizes) > 0:
        largest = 1 + np.argmax(sizes)
        alpha = np.where(output == largest, 255, 0).astype(np.uint8)

# 再次羽化
alpha = cv2.GaussianBlur(alpha, (3, 3), 0)

# 合成 RGBA
b, g, r = cv2.split(img_bgr)
rgba = cv2.merge([b, g, r, alpha])

# 保存为 PNG（用 imencode + fromfile 解决中文路径问题）
ext = '.png'
ok, buf = cv2.imencode(ext, rgba)
if not ok:
    print('imencode failed'); sys.exit(1)
with open(dst, 'wb') as f:
    f.write(buf.tobytes())
print('saved', dst, 'size:', rgba.shape)

# 输出原始图片大小（用 PIL 转换到 RGB 给出尺寸信息）
im = Image.open(dst)
print('PIL size:', im.size, 'mode:', im.mode)
