#!/usr/bin/env python3
# 手机应用图标 —— 与 PC exe 同一张汐音立绘，不重绘。
#
#   python packages/mobile/scripts/make-launcher-icons.py          （需要 Pillow）
#
# 源：packages/desktop/build/icon.png（512×512，Electron exe / 托盘图标同源）。
# 产物：
#   android/.../mipmap-{mdpi..xxxhdpi}/ic_launcher.png   旧版系统（API < 26）的方形图标
#   android/.../drawable-nodpi/ic_launcher_foreground.png 自适应图标前景（86% 居中，四周透明）
#   android/.../mipmap-anydpi-v26/ic_launcher.xml         自适应图标：深色底 + 上面那层前景
#   android/.../values/ic_launcher_background.xml         底色（取自立绘四角）
#   ios/.../AppIcon.appiconset/*.png                      iOS 全尺寸（1024 由 512 放大）
#
# 为什么要自适应图标：Android 8+ 若没有，系统会把方形图标塞进一个白色圆圈里（白边很难看）。
# 这里用立绘四角的近黑色当底、立绘缩到 86% 居中，圆角/圆形遮罩下都是同一张脸。

import json
import pathlib
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("需要 Pillow：python -m pip install pillow")

HERE = pathlib.Path(__file__).resolve().parent          # packages/mobile/scripts
PKG = HERE.parent                                       # packages/mobile
REPO = PKG.parent.parent                                # repo root
SRC = REPO / "packages" / "desktop" / "build" / "icon.png"
RES = PKG / "android" / "app" / "src" / "main" / "res"
IOS = PKG / "ios" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"

# 自适应图标：108dp 画布，前景占 86%（7% 每边留白），底色 = 立绘四角近黑
INSET = 0.07
BG = "#0C0B0F"

ANDROID_LEGACY = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

IOS_SIZES = {
    "Icon-App-20x20@1x.png": 20,
    "Icon-App-20x20@2x.png": 40,
    "Icon-App-20x20@3x.png": 60,
    "Icon-App-29x29@1x.png": 29,
    "Icon-App-29x29@2x.png": 58,
    "Icon-App-29x29@3x.png": 87,
    "Icon-App-40x40@1x.png": 40,
    "Icon-App-40x40@2x.png": 80,
    "Icon-App-40x40@3x.png": 120,
    "Icon-App-60x60@2x.png": 120,
    "Icon-App-60x60@3x.png": 180,
    "Icon-App-76x76@1x.png": 76,
    "Icon-App-76x76@2x.png": 152,
    "Icon-App-83.5x83.5@2x.png": 167,
    "Icon-App-1024x1024@1x.png": 1024,
}


def main() -> None:
    if not SRC.exists():
        sys.exit(f"找不到源图标：{SRC}")
    src = Image.open(SRC).convert("RGB")
    if src.size != (512, 512):
        print(f"提示：源图标是 {src.size[0]}×{src.size[1]}，按 512 的构图处理")

    # 1) 旧版方形图标
    for folder, size in ANDROID_LEGACY.items():
        out = RES / folder / "ic_launcher.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        src.resize((size, size), Image.LANCZOS).save(out)
        print(f"  + {out.relative_to(REPO)}  {size}×{size}")

    # 2) 自适应图标前景：432px（108dp @4x），立绘 86% 居中，四周透明
    canvas = 432
    art = round(canvas * (1 - 2 * INSET))
    fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    fg.paste(src.resize((art, art), Image.LANCZOS).convert("RGBA"), ((canvas - art) // 2,) * 2)
    out = RES / "drawable-nodpi" / "ic_launcher_foreground.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    fg.save(out)
    print(f"  + {out.relative_to(REPO)}  {canvas}×{canvas}")

    # 3) 自适应图标 XML + 底色
    v26 = RES / "mipmap-anydpi-v26" / "ic_launcher.xml"
    v26.parent.mkdir(parents=True, exist_ok=True)
    v26.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n'
        "</adaptive-icon>\n",
        encoding="utf-8",
    )
    print(f"  + {v26.relative_to(REPO)}")
    color = RES / "values" / "ic_launcher_background.xml"
    color.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'    <color name="ic_launcher_background">{BG}</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    print(f"  + {color.relative_to(REPO)}  {BG}")

    # 4) 旧版系统（API < 31）启动页用的图标：96dp，圆角 24%（与新图标观感一致）
    n = 288  # xxhdpi × 96dp
    splash = src.resize((n, n), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, n - 1, n - 1), radius=round(n * 0.24), fill=255)
    splash.putalpha(mask)
    out = RES / "drawable-xxhdpi" / "splash_icon.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    splash.save(out)
    print(f"  + {out.relative_to(REPO)}  288×288（96dp @xxhdpi）")

    # 5) iOS（一张图铺满，系统自己切圆角；不允许 alpha）
    for name, size in IOS_SIZES.items():
        out = IOS / name
        out.parent.mkdir(parents=True, exist_ok=True)
        src.resize((size, size), Image.LANCZOS).save(out)
        print(f"  + {out.relative_to(REPO)}  {size}×{size}")

    # 确认 iOS 清单与实际文件对得上
    manifest = json.loads((IOS / "Contents.json").read_text(encoding="utf-8"))
    wanted = {img["filename"] for img in manifest["images"] if img.get("filename")}
    missing = sorted(wanted - set(IOS_SIZES))
    if missing:
        sys.exit(f"Contents.json 里还有未生成的尺寸：{missing}")
    print("\n图标已生成：Android 5 档 + 自适应（深底 + 86% 立绘）+ 旧版启动页图标 + iOS 15 张。")


if __name__ == "__main__":
    main()
