#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成站点图标。一次性脚本，产物是 prototype/favicon.ico + apple-touch-icon.png。

设计：橙色圆角底（品牌色 #f97316）+ 白色投篮抛物线 + 起点处的球。
小尺寸只保留这三个元素，16px 下也认得出。
用法: python tools/make_favicon.py
"""
import os
from PIL import Image, ImageDraw

S = 1024
ROUND = 235

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


def build_master():
    # 4x 超采样画弧线，保证边缘干净
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

    # 球
    ball_ss = 4
    bm = Image.new('L', (S * ball_ss, S * ball_ss), 0)
    ImageDraw.Draw(bm).ellipse(
        [(BALL_C[0] - BALL_R) * ball_ss, (BALL_C[1] - BALL_R) * ball_ss,
         (BALL_C[0] + BALL_R) * ball_ss, (BALL_C[1] + BALL_R) * ball_ss], fill=255)
    ball_mask = bm.resize((S, S), Image.LANCZOS)

    # 圆角底
    card = gradient(S).convert('RGBA')
    corner = Image.new('L', (S, S), 0)
    ImageDraw.Draw(corner).rounded_rectangle([0, 0, S - 1, S - 1], radius=ROUND, fill=255)
    card.putalpha(corner)

    white = Image.new('RGBA', (S, S), (255, 255, 255, 255))
    out = Image.alpha_composite(card, Image.composite(white, Image.new('RGBA', (S, S), (0, 0, 0, 0)), mask))
    out = Image.alpha_composite(out, Image.composite(white, Image.new('RGBA', (S, S), (0, 0, 0, 0)), ball_mask))
    return out


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proto = os.path.join(root, 'prototype')
    master = build_master()

    ico = os.path.join(proto, 'favicon.ico')
    master.save(ico, format='ICO',
                sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('written', ico, os.path.getsize(ico), 'bytes')

    touch = os.path.join(proto, 'apple-touch-icon.png')
    master.resize((180, 180), Image.LANCZOS).save(touch, format='PNG', optimize=True)
    print('written', touch, os.path.getsize(touch), 'bytes')

    preview = os.path.join(root, '.shots', 'icon-preview.png')
    os.makedirs(os.path.dirname(preview), exist_ok=True)
    strip = Image.new('RGBA', (16 + 32 + 48 + 64 + 128 + 40 * 5 + 20, 160), (255, 255, 255, 255))
    x = 10
    for s in (16, 32, 48, 64, 128):
        strip.paste(master.resize((s, s), Image.LANCZOS), (x, 150 - s - 8), master.resize((s, s), Image.LANCZOS))
        x += s + 40
    strip.save(preview)
    print('written', preview)


if __name__ == '__main__':
    main()
