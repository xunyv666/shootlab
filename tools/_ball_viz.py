import sys
import json
import argparse
import cv2
import numpy as np
sys.path.insert(0, '.')
import ball_track as BT

ap = argparse.ArgumentParser()
ap.add_argument('video'); ap.add_argument('pose'); ap.add_argument('out')
ap.add_argument('--at', default='')
a = ap.parse_args()
d = json.load(open(a.pose, encoding='utf-8'))
cap = cv2.VideoCapture(a.video); fps = cap.get(5)

tiles = []
for t in [float(x) for x in a.at.split(',') if x]:
    f = min(d['frames'], key=lambda z: abs(z['t'] - t))
    r = BT.track(a.video, f['t'], f['pts'][16][0], f['pts'][16][1])
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(f['t'] * fps)))
    ok, img = cap.read()
    if not ok: continue
    if r.get('track'):
        pts = [(int(x), int(y)) for _, x, y in r['track']]
        for i in range(1, len(pts)):
            cv2.line(img, pts[i-1], pts[i], (0, 255, 255), 2)
        for i, p in enumerate(pts):
            cv2.circle(img, p, 4, (0, 0, 255) if i == 0 else (0, 255, 255), -1)
    lbl = '%.1fs ok=%s ang=%s spd=%s' % (f['t'], r['ok'], r.get('angle'), r.get('speed_px'))
    cv2.putText(img, lbl, (8, 28), 0, 0.75, (0, 255, 255), 2)
    tiles.append(cv2.resize(img, (620, 350)))
if tiles:
    while len(tiles) % 2: tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i:i+2]) for i in range(0, len(tiles), 2)]
    cv2.imwrite(a.out, np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])
    print('saved', a.out, len(tiles))
