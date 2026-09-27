# -*- coding: utf-8 -*-
"""从桌面端源图标 (src-tauri/icons/icon.png) 生成 Kotlin 端全套启动图标。

产物（kotlin-app/app/src/main/res/）：
- mipmap-*/ic_launcher.png          legacy 方形（API 24/25 及部分桌面快捷方式）
- mipmap-*/ic_launcher_round.png    legacy 圆形
- mipmap-*/ic_launcher_foreground.png  自适应图标前景（108dp 画布，内容缩到 ~66% 留出安全区）
- mipmap-anydpi-v26/ic_launcher{,_round}.xml  自适应图标定义
- values/ic_launcher_background.xml 自适应背景色（取源图标渐变均色）
- drawable-nodpi/ic_app_logo.png    「关于」页 logo 用完整图标（256px）
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src-tauri", "icons", "icon.png")
RES = os.path.join(ROOT, "kotlin-app", "app", "src", "main", "res")

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
BASE = 48  # legacy 基准 48dp
FG_BASE = 108  # 自适应画布 108dp
FG_ICON_RATIO = 0.85  # 前景整幅出血：轮廓完全盖住 72dp 可视视口（实测 0.85 起视口内无透明像素），避免启动器遮罩下露出背景色形成"背框"

src = Image.open(SRC).convert("RGBA")

# —— 自适应背景色：不透明像素均色 ——
alpha = src.getchannel("A")
bbox = src.getbbox()
core = src.crop(bbox).resize((64, 64), Image.LANCZOS)
px = [p for p in core.getdata() if p[3] > 128]
avg = tuple(sum(c[i] for c in px) // len(px) for i in range(3))
bg_hex = "#%02X%02X%02X" % avg
print("adaptive background =", bg_hex)


def resize(img, size):
    return img.resize((size, size), Image.LANCZOS)


def round_masked(img):
    """圆形蒙版（4x 超采样抗锯齿）。"""
    s = img.size[0]
    mask = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, s * 4 - 1, s * 4 - 1), fill=255)
    mask = mask.resize((s, s), Image.LANCZOS)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


for dpi, scale in DENSITIES.items():
    d = os.path.join(RES, "mipmap-%s" % dpi)
    os.makedirs(d, exist_ok=True)
    # legacy 方形 / 圆形
    legacy = resize(src, round(BASE * scale))
    legacy.save(os.path.join(d, "ic_launcher.png"))
    round_masked(legacy).save(os.path.join(d, "ic_launcher_round.png"))
    # 自适应前景：画布 108dp×scale，图标整体缩到 66% 居中
    canvas = round(FG_BASE * scale)
    fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    icon = resize(src, round(canvas * FG_ICON_RATIO))
    off = (canvas - icon.size[0]) // 2
    fg.paste(icon, (off, off), icon)
    fg.save(os.path.join(d, "ic_launcher_foreground.png"))
    print("mipmap-%s: %dx%d ok" % (dpi, canvas, canvas))

# —— 自适应图标定义（API 26+）——
d = os.path.join(RES, "mipmap-anydpi-v26")
os.makedirs(d, exist_ok=True)
for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
    with open(os.path.join(d, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/ic_launcher_background" />\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
            "</adaptive-icon>\n"
        )

# —— 背景色资源 ——
with open(os.path.join(RES, "values", "ic_launcher_background.xml"), "w", encoding="utf-8", newline="\n") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">%s</color>\n</resources>\n' % bg_hex)

# —— 「关于」页 logo（完整图标，nodpi 单份）——
d = os.path.join(RES, "drawable-nodpi")
os.makedirs(d, exist_ok=True)
resize(src, 256).save(os.path.join(d, "ic_app_logo.png"))

print("done")
