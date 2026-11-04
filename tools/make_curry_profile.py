#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成库里标准姿势档案图：关键帧 + 骨骼 + 指标标注"""
import json
import os
import cv2
from PIL import Image, ImageDraw, ImageFont

VIDEO = 'media/curry_p2_360p.mp4'
POSE = 'media/pose_full_m.json'
OUT = 'media/_curry_profile.jpg'
TS = [357.5, 454.1, 610.5, 726.5]

CONN = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24),
        (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (27, 29), (29, 31),
        (28, 30), (30, 32), (0, 11), (0, 12)]

FONT = 'C:/Windows/Fonts/msyh.ttc'
FB = 'C:/Windows/Fonts/msyhbd.ttc'
if not os.path.exists(FONT):
    FONT = 'C:/Windows/Fonts/simhei.ttf'
    FB = FONT


def font(sz, bold=False):
    try:
        return ImageFont.truetype(FB if bold else FONT, sz)
    except Exception:
        return ImageFont.load_default()


d = json.load(open(POSE, encoding='utf-8'))
frames = [f for f in d['frames'] if f['pts']]
cap = cv2.VideoCapture(VIDEO)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

CELL_W, CELL_H = 560, 315
PAD_T, PAD_B = 86, 96
cols, rows = 2, 2
IMG_W = cols * CELL_W
IMG_H = rows * (PAD_T + CELL_H + PAD_B)

canvas = Image.new('RGB', (IMG_W, IMG_H), (18, 20, 24))
dr = ImageDraw.Draw(canvas)

for i, t in enumerate(TS):
    f = min(frames, key=lambda x: abs(x['t'] - t))
    cap.set(cv2.CAP_PROP_POS_FRAMES, f['f'])
    ok, fr = cap.read()
    if not ok:
        continue
    for a, b in CONN:
        pa, pb = f['pts'][a], f['pts'][b]
        if pa[3] > 0.4 and pb[3] > 0.4:
            cv2.line(fr, (int(pa[0] * W), int(pa[1] * H)), (int(pb[0] * W), int(pb[1] * H)), (0, 235, 120), 2, cv2.LINE_AA)
    for j, p in enumerate(f['pts']):
        if p[3] > 0.4:
            r = 4 if j in (11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28) else 2
            cv2.circle(fr, (int(p[0] * W), int(p[1] * H)), r, (0, 210, 255), -1, cv2.LINE_AA)
    fr = cv2.resize(fr, (CELL_W, CELL_H), interpolation=cv2.INTER_LANCZOS4)

    cx = (i % cols) * CELL_W
    cy = (i // cols) * (PAD_T + CELL_H + PAD_B)
    canvas.paste(Image.fromarray(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)), (cx, cy + PAD_T))

    m = f['m']
    dr.text((cx + 14, cy + 16), '库里 %02d:%02d' % (int(f['t']) // 60, int(f['t']) % 60),
            font=font(24, True), fill=(255, 255, 255))
    dr.text((cx + 14, cy + 48), '大师课 P2 · 全身机位 · 手举至 %s' % ('头顶' if (m['wristRise'] or 0) > 1.3 else '肩上'),
            font=font(16), fill=(150, 158, 170))

    items = [
        ('肘角', '%.0f°' % (m['elbow'] or 0)),
        ('膝角', '%.0f°' % (m['knee'] or 0)),
        ('肩线倾斜', '%.1f°' % (m['shoulderTilt'] or 0)),
        ('腕高/肩-踝', '%.2f' % (m['wristRise'] or 0)),
    ]
    by = cy + PAD_T + CELL_H + 12
    for k, (lab, val) in enumerate(items):
        bx = cx + 14 + k * 136
        dr.text((bx, by), lab, font=font(15), fill=(130, 138, 150))
        dr.text((bx, by + 22), val, font=font(24, True), fill=(255, 200, 70))

cap.release()
dr.rectangle([0, 0, IMG_W - 1, IMG_H - 1], outline=(45, 50, 58), width=2)
canvas.save(OUT, quality=92)
print('saved', OUT, canvas.size)
