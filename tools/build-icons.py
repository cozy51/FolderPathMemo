#!/usr/bin/env python3
"""icons\\*.svg から拡張機能用のPNGアイコンを生成します。

使い方:
    pip install cairosvg pillow
    python tools/build-icons.py

16pxと32pxは細部がつぶれるため、簡略版の icon-small.svg から生成します。
48pxと128pxは通常版の icon.svg から生成します。
"""

from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"

# 出力サイズ -> 元にするSVG
SOURCES = {
    16: "icon-small.svg",
    32: "icon-small.svg",
    48: "icon.svg",
    128: "icon.svg",
}

# 縮小時のジャギーを抑えるための拡大倍率
SUPERSAMPLE = 8


def render(svg_path: Path, size: int) -> Image.Image:
    large = size * SUPERSAMPLE
    png = cairosvg.svg2png(
        url=str(svg_path),
        output_width=large,
        output_height=large,
        background_color=None,
    )
    from io import BytesIO

    image = Image.open(BytesIO(png)).convert("RGBA")
    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    for size, source in SOURCES.items():
        svg_path = ICONS / source
        if not svg_path.exists():
            raise SystemExit(f"SVGが見つかりません: {svg_path}")
        out = ICONS / f"icon{size}.png"
        render(svg_path, size).save(out, "PNG", optimize=True)
        print(f"{out.relative_to(ROOT)} ({source} から生成)")


if __name__ == "__main__":
    main()
