#!/usr/bin/env python3
"""Generate Chrome extension PNG icons for FolderPath Memo."""

from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "icons"
SIZES = (16, 32, 48, 128)
SCALE = 4
CANVAS = 128 * SCALE


def clamp(value):
    return max(0, min(255, int(round(value))))


def mix(a, b, t):
    return a + (b - a) * t


def rgba_over(dst, src):
    sr, sg, sb, sa = src
    if sa <= 0:
        return dst
    dr, dg, db, da = dst
    alpha = sa / 255
    inv = 1 - alpha
    return (
        clamp(sr * alpha + dr * inv),
        clamp(sg * alpha + dg * inv),
        clamp(sb * alpha + db * inv),
        255,
    )


def in_round_rect(px, py, x, y, width, height, radius):
    if px < x or px >= x + width or py < y or py >= y + height:
        return False
    cx = min(max(px, x + radius), x + width - radius)
    cy = min(max(py, y + radius), y + height - radius)
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2


def draw_shape(pixels, predicate, color):
    for y in range(CANVAS):
        for x in range(CANVAS):
            if predicate((x + 0.5) / SCALE, (y + 0.5) / SCALE):
                pixels[y][x] = rgba_over(pixels[y][x], color)


def draw_gradient_round_rect(pixels):
    start = (57, 132, 255)
    end = (18, 73, 200)
    for y in range(CANVAS):
        for x in range(CANVAS):
            ux = (x + 0.5) / SCALE
            uy = (y + 0.5) / SCALE
            if in_round_rect(ux, uy, 8, 8, 112, 112, 30):
                t = min(1, max(0, ((ux - 18) + (uy - 12)) / (90 + 106)))
                pixels[y][x] = (clamp(mix(start[0], end[0], t)), clamp(mix(start[1], end[1], t)), clamp(mix(start[2], end[2], t)), 255)


def draw_rect(pixels, x, y, width, height, color):
    draw_shape(pixels, lambda px, py: x <= px < x + width and y <= py < y + height, color)


def draw_folder(pixels):
    stroke = (255, 255, 255, 255)
    fill = (255, 255, 255, 46)
    draw_shape(pixels, lambda px, py: in_round_rect(px, py, 25, 39, 79, 62, 9), fill)
    draw_shape(pixels, lambda px, py: 34 <= px < 58 and 39 <= py < 49, fill)
    draw_shape(pixels, lambda px, py: 58 <= px < 68 and 39 + (px - 58) <= py < 49 + (px - 58), fill)
    draw_shape(pixels, lambda px, py: (25 <= px <= 104 and 48 <= py <= 101 and (min(abs(px - 25), abs(px - 104), abs(py - 48), abs(py - 101)) < 3)), stroke)
    draw_shape(pixels, lambda px, py: 34 <= px <= 58 and 39 <= py <= 45, stroke)
    draw_shape(pixels, lambda px, py: 58 <= px <= 68 and abs(py - (39 + px - 58)) < 3, stroke)
    draw_shape(pixels, lambda px, py: 68 <= px <= 95 and 48 <= py <= 54, stroke)


def draw_letter_f(pixels):
    white = (255, 255, 255, 255)
    draw_rect(pixels, 48, 57, 9, 31, white)
    draw_rect(pixels, 48, 57, 24, 7, white)
    draw_rect(pixels, 48, 70, 22, 7, white)


def draw_badge(pixels):
    draw_shape(pixels, lambda px, py: (px - 101) ** 2 + (py - 27) ** 2 <= 10 ** 2, (255, 190, 61, 255))


def downsample(pixels, size):
    factor = CANVAS // size
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            totals = [0, 0, 0, 0]
            for sy in range(factor):
                for sx in range(factor):
                    r, g, b, a = pixels[y * factor + sy][x * factor + sx]
                    totals[0] += r; totals[1] += g; totals[2] += b; totals[3] += a
            count = factor * factor
            row.append(tuple(clamp(v / count) for v in totals))
        out.append(row)
    return out


def write_png(path, pixels):
    height = len(pixels)
    width = len(pixels[0])
    raw = b"".join(b"\x00" + b"".join(bytes(pixel) for pixel in row) for row in pixels)
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9))
    data += chunk(b"IEND", b"")
    path.write_bytes(data)


def main():
    ICON_DIR.mkdir(exist_ok=True)
    pixels = [[(0, 0, 0, 0) for _ in range(CANVAS)] for _ in range(CANVAS)]
    draw_gradient_round_rect(pixels)
    draw_badge(pixels)
    draw_folder(pixels)
    draw_letter_f(pixels)
    for size in SIZES:
        write_png(ICON_DIR / f"icon{size}.png", downsample(pixels, size))


if __name__ == "__main__":
    main()
