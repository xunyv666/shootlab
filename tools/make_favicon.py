#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成站点图标。

用法：
    python tools/make_favicon.py <图片路径> [zoom]   用一张图做图标
    python tools/make_favicon.py                     用内置绘制的橙色投篮图标

产物：prototype/favicon.ico（16/32/48/64/128/256 六档）、prototype/apple-touch-icon.png
另存一张 .shots/icon-preview.png 用来看各尺寸的实际效果。
"""
import os
import sys
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

S = 1024
ROUND = 235


# ---------------- 内置绘制版（没有给图片时用） ----------------

# 抛物线：起点 -> 控制点 -> 终点（二次贝塞尔）
# 终点不落地而是飞向高处（球是朝篮筐去的），否则两条腿落地会变成拱门
P0 = (349, 627)
CP = (543, 11)
P1 = (893, 457)
LINE_W = 150
BALL_C = (233, 691)
BALL_R = 132


def bez(p0, cp, p1, n=160):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u * u * p0[0] + 2 * u * t * cp[0] + t * t * p1[0]
        y = u * u * p0[1] + 2 * u * t * cp[1] + t * t * p1[1]
        pts.append((x, y))
    return pts


def gradient(size, top=(251, 146, 60), bottom=(234, 88, 12)):
    img = Image.new('RGB', (1, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((size, size), Image.BILINEAR)


def build_drawn():
    ss = 4
    big = Image.new('L', (S * ss, S * ss), 0)
    d = ImageDraw.Draw(big)
    pts = [(x * ss, y * ss) for x, y in bez(P0, CP, P1)]
    # 逐段 line 会在接缝处留下条纹，沿轨迹叠圆点才是无缝的。
    # 半径从起点到末端渐细，视觉上像轨迹甩出去后散开，也能避免「拱门」感。
    n = len(pts)
    for i, (x, y) in enumerate(pts):
        t = i / (n - 1)
        r = (LINE_W * ss // 2) * (1 - 0.58 * t)
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    mask = big.resize((S, S), Image.LANCZOS)

    ball_ss = 4
    bm = Image.new('L', (S * ball_ss, S * ball_ss), 0)
    ImageDraw.Draw(bm).ellipse(
        [(BALL_C[0] - BALL_R) * ball_ss, (BALL_C[1] - BALL_R) * ball_ss,
         (BALL_C[0] + BALL_R) * ball_ss, (BALL_C[1] + BALL_R) * ball_ss], fill=255)
    ball_mask = bm.resize((S, S), Image.LANCZOS)

    card = gradient(S).convert('RGBA')
    corner = Image.new('L', (S, S), 0)
    ImageDraw.Draw(corner).rounded_rectangle([0, 0, S - 1, S - 1], radius=ROUND, fill=255)
    card.putalpha(corner)

    white = Image.new('RGBA', (S, S), (255, 255, 255, 255))
    out = Image.alpha_composite(card, Image.composite(white, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask))
    out = Image.alpha_composite(out, Image.composite(white, Image.new('RGBA', (S, S), (0, 0, 0, 0)), ball_mask))
    return out


# ---------------- 图片版 ----------------

def build_photo(path, zoom=1.0, sharpen=True):
    """把一张图裁成正方形并放大主体。

    小尺寸图标最怕细节杂：整张图缩到 16px 时，背景纹理全变成噪点。
    所以先居中裁方形，再按 zoom 往里收一点（把主体占满画布），
    最后提一点对比度和锐度，让剪影在 16px 下还能立住。
    """
    im = Image.open(path).convert('RGB')
    w, h = im.size

    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    im = im.crop((left, top, left + side, top + side))

    if zoom > 1.0:
        keep = int(side / zoom)
        off = (side - keep) // 2
        im = im.crop((off, off, off + keep, off + keep))

    im = im.resize((S, S), Image.LANCZOS)
    im = ImageEnhance.Color(im).enhance(1.12)
    im = ImageEnhance.Contrast(im).enhance(1.10)
    if sharpen:
        im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=70, threshold=2))

    out = im.convert('RGBA')
    corner = Image.new('L', (S, S), 0)
    ImageDraw.Draw(corner).rounded_rectangle([0, 0, S - 1, S - 1], radius=ROUND, fill=255)
    out.putalpha(corner)
    return out


# ---------------- 输出 ----------------

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proto = os.path.join(root, 'prototype')

    if len(sys.argv) > 1:
        src = sys.argv[1]
        zoom = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
        master = build_photo(src, zoom=zoom)
        tag = 'photo zoom=' + str(zoom)
    else:
        master = build_drawn()
        tag = 'drawn'

    ico = os.path.join(proto, 'favicon.ico')
    master.save(ico, format='ICO',
                sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('written', ico, os.path.getsize(ico), 'bytes')

    touch = os.path.join(proto, 'apple-touch-icon.png')
    master.resize((180, 180), Image.LANCZOS).save(touch, format='PNG', optimize=True)
    print('written', touch, os.path.getsize(touch), 'bytes')

    # 各尺寸实际效果，按 16/32/48/64/128 从左到右摆一排
    preview = os.path.join(root, '.shots', 'icon-preview.png')
    os.makedirs(os.path.dirname(preview), exist_ok=True)
    gap = 36
    widths = [16, 32, 48, 64, 128]
    total_w = sum(widths) + gap * (len(widths) - 1) + 40
    strip = Image.new('RGBA', (total_w, 200), (246, 247, 249, 255))
    x = 20
    for s in widths:
        thumb = master.resize((s, s), Image.LANCZOS)
        strip.paste(thumb, (x, 180 - s - 20), thumb)
        x += s + gap
    strip.save(preview)
    print('written', preview, '(' + tag + ')')


if __name__ == '__main__':
    main()
