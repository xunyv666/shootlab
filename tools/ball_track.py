#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""球轨迹跟踪 -> 真实出手角度。

为什么必须单独做这一步：
  原型里原来拿「小臂与水平线的夹角」当出手角代理，实测出来是 60-80°，
  而真实出手角在 45-55°。前臂指向上方不等于球往上飞，这个代理是错的，
  而且错得很系统 —— 会让每个用户都被判成「弧度过高」。

做法：
  1. HSV 橙色分割 + 圆度/尺寸过滤，得到每帧的球候选
  2. 从「出手帧 + 腕点位置」播种，用常速预测 + 距离门限做前向关联
     （场上还有橙色球鞋、地板标记等干扰物，必须靠连续性排除）
  3. 取出手后前 0.45 秒做直线拟合，斜率即初速度方向 -> 仰角
     用 |dx| 消除朝向，保证朝左朝右都得到同一个仰角

用法:
  python ball_track.py <video> --t 190.6 --wx 0.36 --wy 0.28
  python ball_track.py <video> --shots media/shots.json --pose media/pose.json
"""
import json, sys, argparse
import numpy as np
import cv2


def detect_ball(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # 球在阴天/树荫下会掉饱和度，橙棕色的 H 也能到 30 左右，
    # 所以阈值放宽，靠下游的「运动一致性」去排除静止的竹叶、木纹、橙色篮筐
    m = cv2.bitwise_or(cv2.inRange(hsv, (0, 55, 45), (30, 255, 255)),
                       cv2.inRange(hsv, (160, 55, 45), (180, 255, 255)))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cnts:
        a = cv2.contourArea(c)
        if a < 90:
            continue
        (x, y), r = cv2.minEnclosingCircle(c)
        if r < 5 or r > 34:
            continue
        if a / (np.pi * r * r + 1e-6) < 0.36:
            continue
        out.append({'x': float(x), 'y': float(y), 'r': float(r), 'a': float(a)})
    return out


# 一次真实投篮出手后，球在画面里的移动速度远大于此（720p 下典型 400-900 px/s）。
# 低于这个值说明跟到的是静止的橙色物体（篮筐、地板标线、橙色球鞋）。
SPEED_MIN = 150.0
# 出手角低于 22° 或高于 76° 在物理上不可能来自一次正常投篮，属于误跟
ANGLE_MIN, ANGLE_MAX = 22.0, 76.0


def _follow(pts, i0, seed, H):
    """从前向关联一条轨迹：常速预测 + 距离门限 + 半径连续"""
    seq = [(pts[i0][0], seed['x'], seed['y'], seed['r'])]
    vx = vy = 0.0
    for i in range(i0 + 1, len(pts)):
        tt, cands, _ = pts[i]
        if not cands:
            break
        dt = tt - seq[-1][0]
        pxp, pyp = seq[-1][1] + vx * dt, seq[-1][2] + vy * dt
        gate = max(50.0, 0.16 * H * (1 + len(seq) * 0.2))
        c = min(cands, key=lambda z: np.hypot(z['x'] - pxp, z['y'] - pyp))
        if np.hypot(c['x'] - pxp, c['y'] - pyp) > gate:
            break
        # 半径不应突变（球在近处大、远处小的变化是连续的）
        if abs(c['r'] - seq[-1][3]) > 0.45 * seq[-1][3] + 4:
            break
        if len(seq) >= 2:
            dt2 = tt - seq[-2][0]
            if dt2 > 1e-6:
                vx = (c['x'] - seq[-2][1]) / dt2
                vy = (c['y'] - seq[-2][2]) / dt2
        seq.append((tt, c['x'], c['y'], c['r']))
    return seq


def _fit(seq, t_rel):
    """对出手后 0.45 秒内的轨迹做二次拟合，返回 (angle, speed, n, span, disp) 或 None"""
    if len(seq) < 4:
        return None
    t = np.array([s[0] for s in seq]); x = np.array([s[1] for s in seq]); y = np.array([s[2] for s in seq])
    # 出手前的球还在手里，静止帧会把拟合拖偏
    m = (t >= t_rel - 0.02) & (t - t_rel <= 0.45)
    t, x, y = t[m], x[m], y[m]
    if len(t) < 4:
        return None
    cx = np.polyfit(t, x, 2); cy = np.polyfit(t, y, 2)
    tref = float(t[0])
    vx0 = 2 * cx[0] * tref + cx[1]
    vy0 = 2 * cy[0] * tref + cy[1]
    speed = float(np.hypot(vx0, vy0))
    if speed < 1e-6:
        return None
    angle = float(np.degrees(np.arctan2(-vy0, abs(vx0))))
    disp = float(np.hypot(x[-1] - x[0], y[-1] - y[0]))
    return angle, speed, int(len(t)), round(float(t[-1] - t[0]), 3), disp


def track(video, t_rel, wx, wy, look=0.75, pre=0.15):
    """从出手帧播种，向前跟踪球。wx/wy 为归一化腕点坐标"""
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    H = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    px, py = wx * W, wy * H

    f0 = int(max(0, (t_rel - pre)) * fps)
    f1 = int((t_rel + look) * fps)
    pts = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
    for fi in range(f0, f1):
        ok, fr = cap.read()
        if not ok:
            break
        pts.append((fi / fps, detect_ball(fr), fr.shape))
    cap.release()
    if not pts:
        return None

    # 播种：腕点附近的所有候选都当种子试一遍，谁能跟出「又快又长」的轨迹就用谁。
    # 只看距离会被篮筐、球鞋这些静止橙块骗走（它们离手更近但一动不动）。
    seeds = []
    for i, (tt, cands, _) in enumerate(pts):
        if not (-0.10 <= tt - t_rel <= 0.14):
            continue
        for c in cands:
            d = np.hypot(c['x'] - px, c['y'] - py)
            if d < 0.20 * H:
                seeds.append((d, i, c))
    if not seeds:
        return {'ok': False, 'reason': '出手点附近没找到球'}
    seeds.sort(key=lambda z: z[0])

    best, best_score, tries = None, -1.0, []
    for d, i, c in seeds[:10]:
        seq = _follow(pts, i, c, H)
        f = _fit(seq, t_rel)
        if not f:
            continue
        angle, speed, n, span, disp = f
        tries.append({'d': round(float(d), 1), 'n': n, 'speed': round(speed, 1),
                      'angle': round(angle, 1), 'disp': round(disp)})
        if speed < SPEED_MIN or not (ANGLE_MIN <= angle <= ANGLE_MAX):
            continue
        # 球在空中要走出一段距离才算「跟住了」：只挪了几十个像素的多半是手边杂色
        if disp < 0.12 * H:
            continue
        # 又长又快者优先：点数是主要依据，速度做二级排序
        score = n + min(speed, 1200) / 2000.0
        if score > best_score:
            best_score, best = score, (angle, speed, n, span, disp, seq)

    if best is None:
        if not tries:
            return {'ok': False, 'reason': '跟踪点不足'}
        # 有轨迹但全被物理校验否掉：说清楚是哪种原因
        fast = [x for x in tries if x['speed'] >= SPEED_MIN]
        if fast:
            return {'ok': False, 'reason': '轨迹不成立(%s°)' % fast[0]['angle'], 'tries': tries}
        return {'ok': False, 'reason': '只跟到静止目标(%.0fpx/s)' % max(x['speed'] for x in tries), 'tries': tries}

    angle, speed, n, span, disp, seq = best
    return {
        'ok': True,
        'angle': round(angle, 1),
        'n_points': n,
        't_span': span,
        'speed_px': round(speed, 1),
        'disp_px': round(disp),
        'track': [[round(float(a), 3), round(float(b), 1), round(float(c), 1)]
                  for a, b, c in [(s[0], s[1], s[2]) for s in seq]],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--t', type=float, required=True, help='出手时刻（该视频内的绝对秒数）')
    ap.add_argument('--wx', type=float, required=True)
    ap.add_argument('--wy', type=float, required=True)
    ap.add_argument('--look', type=float, default=0.55)
    a = ap.parse_args()
    r = track(a.video, a.t, a.wx, a.wy, a.look)
    print(json.dumps(r, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
