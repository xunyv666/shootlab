#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成「库里 vs 普通球友」出手对比卡"""
import json, os
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

CONN = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24),
        (23, 24), (23, 25), (25, 27), (24, 26), (26, 28), (27, 29), (29, 31),
        (28, 30), (30, 32), (0, 11), (0, 12)]

FONT = 'C:/Windows/Fonts/msyh.ttc'
FB = 'C:/Windows/Fonts/msyhbd.ttc'


def font(sz, bold=False):
    try:
        return ImageFont.truetype(FB if bold else FONT, sz)
    except Exception:
        return ImageFont.load_default()


def grab(video, pose, t):
    """取某时刻的帧 + 骨骼，返回 RGB ndarray"""
    d = json.load(open(pose, encoding='utf-8'))
    fr = [f for f in d['frames'] if f['pts']]
    f = min(fr, key=lambda x: abs(x['t'] - t))
    cap = cv2.VideoCapture(video)
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.set(cv2.CAP_PROP_POS_FRAMES, f['f'])
    ok, img = cap.read()
    cap.release()
    if not ok:
        return None, None
    for a, b in CONN:
        pa, pb = f['pts'][a], f['pts'][b]
        if pa[3] > 0.4 and pb[3] > 0.4:
            cv2.line(img, (int(pa[0] * W), int(pa[1] * H)), (int(pb[0] * W), int(pb[1] * H)), (0, 235, 120), 2, cv2.LINE_AA)
    for j, p in enumerate(f['pts']):
        if p[3] > 0.4:
            r = 4 if j in (11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28) else 2
            cv2.circle(img, (int(p[0] * W), int(p[1] * H)), r, (0, 210, 255), -1, cv2.LINE_AA)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB), f


def stats(shots_path, drop_bad=True):
    d = json.load(open(shots_path, encoding='utf-8'))
    ss = d['shots']
    if drop_bad:
        ss = [s for s in ss if s['shoulder_tilt_abs'] is None or s['shoulder_tilt_abs'] < 45]
    def med(k):
        v = [s[k] for s in ss if s.get(k) is not None]
        return float(np.median(v)) if v else None
    return {
        'n': len(ss),
        'wrist': med('wrist_peak'),
        'elbow': med('elbow_at_release'),
        'dip': med('dip'),
        'shoulder': med('shoulder_tilt_abs'),
    }


curry = stats('media/shots_curry_610.json') 
curry2 = stats('media/shots_curry_357.json')
am = stats('media/shots_am.json')

# 库里两段合并取中位（共 2 次有效出手）
cw = [curry['wrist'], curry2['wrist']]
ce = [curry['elbow'], curry2['elbow']]
cd = [curry['dip'], curry2['dip']]
cs = [curry['shoulder'], curry2['shoulder']]
CUR = {'n': 2, 'wrist': float(np.mean(cw)), 'elbow': float(np.mean(ce)),
       'dip': float(np.mean(cd)), 'shoulder': float(np.mean(cs))}

img_c, f_c = grab('media/curry_p2_360p.mp4', 'media/pose_shot_610.json', 610.36)
img_a, f_a = grab('media/amateur_185p.mp4', 'media/pose_am_0_60.json', 2.70)

CELL_W, CELL_H = 520, 372
W = 1180
H = 792
canvas = Image.new('RGB', (W, H), (16, 18, 22))
dr = ImageDraw.Draw(canvas)

# 顶部标题
dr.text((36, 26), '库里 vs 普通球友 · 出手瞬间对比', font=font(30, True), fill=(255, 255, 255))
dr.text((36, 68), '同一套 MediaPipe 提取 · 同一套指标口径 · 高度已用「肩-踝跨度」归一',
        font=font(15), fill=(138, 146, 160))

# 两张图
for i, (img, name, sub, col) in enumerate([
        (img_c, '斯蒂芬·库里', '大师课 P2 · 10:10 · 斜前方机位', (78, 161, 255)),
        (img_a, '普通球友', 'B 站投篮记录 · 00:02 · 侧后方机位', (255, 159, 67))]):
    x = 36 + i * (CELL_W + 60)
    y = 132
    if img is not None:
        im = Image.fromarray(img).resize((CELL_W, CELL_H), Image.LANCZOS)
        canvas.paste(im, (x, y))
        dr.rectangle([x, y, x + CELL_W - 1, y + CELL_H - 1], outline=col, width=2)
    dr.text((x, y - 30), name, font=font(18, True), fill=col)
    dr.text((x + 132, y - 26), sub, font=font(12), fill=(120, 128, 142))

# 中间对比条
BX = 36
BY = 580
BW = W - 72
items = [
    ('出手点高度', '腕高 / 肩-踝跨度', CUR['wrist'], am['wrist'], 1.6, '%.2f'),
    ('出手时肘角', '手臂伸展度', CUR['elbow'], am['elbow'], 190, '%.0f°'),
    ('下蹲深度', '膝角变化量', CUR['dip'], am['dip'], 60, '%.0f°'),
    ('肩线倾斜', '越小越正（理想<5°）', CUR['shoulder'], am['shoulder'], 30, '%.1f°'),
]
colw = BW / len(items)
for i, (name, sub, cv_, av, vmax, fmt) in enumerate(items):
    cx = BX + i * colw
    dr.text((cx, BY - 8), name, font=font(14, True), fill=(228, 232, 240))
    dr.text((cx, BY + 14), sub, font=font(11), fill=(110, 118, 132))
    for j, (val, col, lab) in enumerate([(cv_, (78, 161, 255), '库'), (av, (255, 159, 67), '你')]):
        by = BY + 36 + j * 26
        dr.text((cx, by - 2), lab, font=font(11), fill=col)
        barw = max(2, int((val or 0) / vmax * (colw - 90)))
        dr.rounded_rectangle([cx + 22, by, cx + 22 + barw, by + 14], radius=7, fill=col)
        dr.text((cx + 22 + barw + 8, by - 1), fmt % (val or 0), font=font(13, True), fill=col)

NOTE1 = '样本：库里 n=2（大师课讲解演示，两段性质不同：一段立定、一段带下蹲）· 普通球友 n=6（训练录像）'
NOTE2 = '机位：斜前方 vs 侧后方。角度类指标（肘角 / 肩线）受视角影响，存在系统偏差，只作量级参照，不能当裁判。'
NOTE3 = '高度类指标已按「肩-踝跨度」归一，可跨机位比较；这是本图唯一可直接横比的一组数。'
for i, n in enumerate([NOTE1, NOTE2, NOTE3]):
    dr.text((36, 700 + i * 26), ('注 ' if i == 0 else '   ') + n, font=font(13), fill=(122, 130, 146 if i else 160))

canvas.save('media/_compare.jpg', quality=93)
print('saved media/_compare.jpg')
print('库里', {k: (round(v, 2) if isinstance(v, float) else v) for k, v in CUR.items()})
print('普通', {k: (round(v, 2) if isinstance(v, float) else v) for k, v in am.items()})
