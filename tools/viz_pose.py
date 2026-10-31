#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把已提取的关键点画回视频帧，用于目视校验检测质量。
用法: python viz_pose.py <video> <pose.json> <out.jpg> [--at 787.0,788.0]
"""
import sys, json, argparse
import cv2
import numpy as np

# 骨架连接（BlazePose 33 点）
CONN = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
        (11, 23), (12, 24), (23, 24),
        (23, 25), (25, 27), (24, 26), (26, 28),
        (27, 29), (29, 31), (28, 30), (30, 32), (0, 11), (0, 12)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video'); ap.add_argument('pose'); ap.add_argument('out')
    ap.add_argument('--at', default='')
    ap.add_argument('--cols', type=int, default=4)
    args = ap.parse_args()

    d = json.load(open(args.pose, encoding='utf-8'))
    d.setdefault('frames', d.get('frames'))
    cap = cv2.VideoCapture(args.video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if args.at:
        want = [float(x) for x in args.at.split(',')]
        frames = [min(d['frames'], key=lambda f: abs(f['t'] - t)) for t in want]
    else:
        idxs = np.linspace(0, len(d['frames']) - 1, 16).astype(int)
        frames = [d['frames'][i] for i in idxs]

    imgs = []
    for f in frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, f['f'])
        ok, fr = cap.read()
        if not ok:
            continue
        if f['pts']:
            for a, b in CONN:
                pa, pb = f['pts'][a], f['pts'][b]
                if pa[3] > 0.3 and pb[3] > 0.3:
                    cv2.line(fr, (int(pa[0] * W), int(pa[1] * H)), (int(pb[0] * W), int(pb[1] * H)), (0, 255, 0), 2)
            for i, p in enumerate(f['pts']):
                if p[3] > 0.3:
                    r = 3 if i in (11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28) else 2
                    cv2.circle(fr, (int(p[0] * W), int(p[1] * H)), r, (0, 200, 255), -1)
        m = f['m'] or {}
        txt = 't=%.2f elbow=%.0f knee=%.0f' % (f['t'], m.get('elbow') or -1, m.get('knee') or -1)
        cv2.putText(fr, txt, (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
        imgs.append(fr)

    while len(imgs) % args.cols:
        imgs.append(np.zeros_like(imgs[0]))
    rows = [np.hstack(imgs[i:i + args.cols]) for i in range(0, len(imgs), args.cols)]
    cv2.imwrite(args.out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])
    print('saved', args.out, len(imgs))
    cap.release()


if __name__ == '__main__':
    main()
