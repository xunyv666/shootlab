#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""侧向机位投篮实验：骨骼序列 -> 出手切分 -> 逐次指标 -> 八维映射。

为什么不能复用 segment_shots.py 的口径（三个坑，都在这份脚本里修掉）：

1) 归一化基准。旧法用「瞬时肩-踝竖直跨度」做分母，人一下蹲分母就缩，
   手腕高度会被放大到 2 倍以上（实测出现过 wristRise=2.1）。
   这里改用「身体长度」= 肩-髋 + 髋-踝 的二维距离之和，并取该次出手窗口内
   的 90 分位作为常数基准 —— 站立时的身长，与蹲不蹲无关。
2) 地面参考。跳跃高度需要地面。以该镜头内踝点最低位置（95 分位）当作地面，
   出手瞬间踝点相对地面的抬升就是起跳高度。用瞬时踝点做基准会把跳跃消掉。
3) 出手节奏。素材是慢动作，视频秒数不等于真实秒数，没有放慢倍率就不能报
   "出手节奏 0.9s"。所以这里只报「下蹲到出手」的视频时长，并明确标注不可换算。

侧向机位的能力边界（写进报告，别糊弄）：
  可信 —— 肘角、前臂角（出手角代理）、膝角、出手高度、起跳高度、躯干前倾
  失效 —— 肩线/髋线倾角、双手高度差、肘部外展（侧向下这些点几乎重合在投影里）

用法:
  python experiment.py media/pose_booker.json --seg 0.6 5.4 --label booker_shot1
"""
import json
import os
import sys
import argparse
import numpy as np

L_SH, R_SH = 11, 12
L_EL, R_EL = 13, 14
L_WR, R_WR = 15, 16
L_HIP, R_HIP = 23, 24
L_KN, R_KN = 25, 26
L_AN, R_AN = 27, 28

KEY = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN]


def ang(a, b, c):
    ax, ay = a[0] - b[0], a[1] - b[1]
    cx, cy = c[0] - b[0], c[1] - b[1]
    n1, n2 = np.hypot(ax, ay), np.hypot(cx, cy)
    if n1 < 1e-9 or n2 < 1e-9:
        return np.nan
    v = np.clip((ax * cx + ay * cy) / (n1 * n2), -1, 1)
    return float(np.degrees(np.arccos(v)))


def ang_h(a, b):
    """a->b 与水平线的夹角，归一化到 (-90, 90]。用于上臂这类需要区分左右的量。"""
    dx, dy = b[0] - a[0], b[1] - a[1]
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return np.nan
    d = -np.degrees(np.arctan2(dy, dx))
    while d > 90:
        d -= 180
    while d <= -90:
        d += 180
    return float(d)


def elev(a, b):
    """a->b 的仰角（始终为正，与人物朝向无关）。
    投篮可能朝左也可能朝右，若直接用带符号的水平角，
    同一个动作会因为朝向不同得到 +57° 和 -45° 两个值 —— 这就是 bug。
    用 |dx| 消除朝向：elev = atan2(-dy, |dx|)。"""
    dx, dy = b[0] - a[0], b[1] - a[1]
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return np.nan
    return float(np.degrees(np.arctan2(-dy, abs(dx))))


def frame_raw(pts, side, ar=1.0):
    """一帧的原始几何量。

    ar = 视频宽/高。MediaPipe 的 x 按画宽归一、y 按画高归一，
    竖屏视频直接拿 (x,y) 算角度，等于把横向压扁了 720/1280=0.56 倍，
    肘角会系统性偏小（实测 162° vs 校正后 168°）。
    所以先把 x 乘上 ar，换算到「以画高为单位」的各向同性坐标再算几何量。
    """
    def P(i):
        return (pts[i][0] * ar, pts[i][1])
    if side == 'r':
        s, e, w, h, k, a = R_SH, R_EL, R_WR, R_HIP, R_KN, R_AN
    else:
        s, e, w, h, k, a = L_SH, L_EL, L_WR, L_HIP, L_KN, L_AN
    sh = ((pts[L_SH][0] + pts[R_SH][0]) / 2 * ar, (pts[L_SH][1] + pts[R_SH][1]) / 2)
    hp = ((pts[L_HIP][0] + pts[R_HIP][0]) / 2 * ar, (pts[L_HIP][1] + pts[R_HIP][1]) / 2)
    an = ((pts[L_AN][0] + pts[R_AN][0]) / 2 * ar, (pts[L_AN][1] + pts[R_AN][1]) / 2)
    torso = float(np.hypot(sh[0] - hp[0], sh[1] - hp[1]))
    leg = float(np.hypot(hp[0] - an[0], hp[1] - an[1]))
    dx, dy = sh[0] - hp[0], sh[1] - hp[1]
    return {
        'elbow': ang(P(s), P(e), P(w)),
        'forearm': elev(P(e), P(w)),
        'upper': ang_h(P(s), P(e)),
        'knee': ang(P(h), P(k), P(a)),
        'wrist_y': pts[w][1],
        'ank_y': an[1],
        'hip_y': hp[1],
        'sh_y': sh[1],
        'bodyLen': torso + leg,
        'lean': float(np.degrees(np.arctan2(dx, abs(dy)))) if abs(dy) > 1e-6 else np.nan,
        'vis': min(pts[i][3] for i in KEY),
    }


def pick_side(frames):
    """投篮手判定：手腕竖直行程更大的一侧"""
    best, best_v = 'r', -1.0
    for sd in ('r', 'l'):
        ys = [frame_raw(f['pts'], sd)['wrist_y'] for f in frames]
        rng = max(ys) - min(ys)
        if rng > best_v:
            best, best_v = sd, rng
    return best, best_v


def load(path, t0=None, t1=None):
    d = json.load(open(path, encoding='utf-8'))
    fr = [f for f in d['frames'] if f.get('pts')]
    if t0 is not None:
        fr = [f for f in fr if f['t'] >= t0 - 1e-6]
    if t1 is not None:
        fr = [f for f in fr if f['t'] <= t1 + 1e-6]
    if len(fr) < 15:
        sys.exit('可用帧不足（%.1f 帧）' % len(fr))
    side, rng = pick_side(fr)
    m = d.get('meta') or {}
    ar = (float(m['w']) / float(m['h'])) if m.get('w') and m.get('h') else 1.0
    t = np.array([f['t'] for f in fr], float)
    raw = [frame_raw(f['pts'], side, ar) for f in fr]

    def col(key):
        return np.array([r[key] for r in raw], float)

    C = {k: col(k) for k in ('elbow', 'forearm', 'upper', 'knee', 'wrist_y',
                             'ank_y', 'hip_y', 'sh_y', 'bodyLen', 'lean', 'vis')}
    # 站立足长基准：整段 90 分位（蹲下会缩短 hip-ankle 距离，取高分位=站直时）
    stand = float(np.nanpercentile(C['bodyLen'], 90))
    # 地面：踝点最低处（数值最大），取 95 分位避免个别误检
    ground = float(np.nanpercentile(C['ank_y'], 95))
    return d, fr, t, side, rng, C, stand, ground


def detect(t, wrist_h, min_peak=1.05, min_gap=1.2, min_rise=0.22):
    """在归一化手腕高度序列上找出手峰值"""
    w = wrist_h.copy()
    n = np.isnan(w)
    if n.any():
        idx = np.arange(len(w))
        w[n] = np.interp(idx[n], idx[~n], w[~n])
    if len(w) > 5:                      # 5 帧滑动平均（25fps 下 0.2s）
        w = np.convolve(w, np.ones(5) / 5, mode='same')
    peaks = []
    for i in range(1, len(w) - 1):
        if not (w[i] >= w[i - 1] and w[i] >= w[i + 1] and w[i] > min_peak):
            continue
        lo = max(0, i - int(1.5 / max(np.median(np.diff(t)), 1e-3)))
        if w[i] - np.nanmin(w[lo:i + 1]) < min_rise:
            continue
        if peaks and t[i] - t[peaks[-1]] < min_gap:
            if w[i] > w[peaks[-1]]:
                peaks[-1] = i
            continue
        peaks.append(i)
    return peaks, w


def shot_metrics(pi, t, C, wk, stand, ground, pre=2.2, post=1.2):
    tp = t[pi]
    m = (t >= tp - pre) & (t <= tp + post)
    ts = t[m]
    np.flatnonzero(m)
    seg = {k: C[k][m] for k in C}
    knee = seg['knee']
    if np.isnan(knee).all():
        j_dip = int(np.argmax(seg['ank_y']))       # 无膝角时退化为踝点最低
    else:
        j_dip = int(np.nanargmin(knee))
    t_dip = float(ts[j_dip])

    def v(key, j):
        x = seg[key][j]
        return None if x != x else float(x)

    dt = float(np.median(np.diff(t))) if len(t) > 1 else 0.04
    after = ts >= tp
    float(after.sum() * dt) if after.any() else 0.0
    # 随球保持：出手后手腕仍在峰值 0.85 倍以上的时长
    pk = np.nanmax(seg['wrist_y'])
    hold = 0.0
    for j in range(int(np.argmin(np.abs(ts - tp))), len(ts)):
        h = (ground - seg['wrist_y'][j]) / stand
        if h >= pk * 0.9:
            hold += dt
        else:
            break
    return {
        't_release': round(tp, 3),
        't_dip': round(t_dip, 3),
        't_crouch': round(tp - t_dip, 3),          # 下蹲到出手（视频秒，慢动作不可换算）
        'elbow_release': None if v('elbow', np.argmin(np.abs(ts - tp))) is None else round(v('elbow', np.argmin(np.abs(ts - tp))), 1),
        'forearm_release': None if v('forearm', np.argmin(np.abs(ts - tp))) is None else round(v('forearm', np.argmin(np.abs(ts - tp))), 1),
        'wrist_h_release': round((ground - seg['wrist_y'][np.argmin(np.abs(ts - tp))]) / stand, 3),
        'knee_min': None if np.isnan(knee).all() else round(float(np.nanmin(knee)), 1),
        'lean_release': v('lean', np.argmin(np.abs(ts - tp))),
        'jump_h': round((ground - seg['ank_y'][np.argmin(np.abs(ts - tp))]) / stand, 3),
        'hip_rise': round((seg['hip_y'][np.argmin(np.abs(ts - tp))] - seg['hip_y'][j_dip]) * -1 / stand, 3),
        'follow_hold': round(hold, 2),
        'window': [round(float(ts[0]), 2), round(float(ts[-1]), 2)],
        'vis': round(float(np.nanmean(seg['vis'])), 2),
    }


def run(pose, t0=None, t1=None, stand_cm=0.0, h_cm=0.0):
    d, fr, t, side, rng, C, stand, ground = load(pose, t0, t1)
    wrist_h = (ground - C['wrist_y']) / stand
    peaks, wk = detect(t, wrist_h)
    shots = [shot_metrics(pi, t, C, wk, stand, ground) for pi in peaks]
    return dict(d=d, fr=fr, t=t, side=side, rng=rng, C=C, stand=stand,
                ground=ground, shots=shots, wrist_h=wrist_h, peaks=peaks)


def summarize(R, stand_cm):
    shots = R['shots']

    def agg(key):
        v = [s[key] for s in shots if s[key] is not None]
        if not v:
            return None
        return {'mean': round(float(np.mean(v)), 2), 'sd': round(float(np.std(v)), 2),
                'n': len(v), 'min': round(min(v), 2), 'max': round(max(v), 2)}

    A = {k: agg(k) for k in ('elbow_release', 'forearm_release', 'wrist_h_release',
                             'knee_min', 'lean_release', 'jump_h', 'hip_rise',
                             't_crouch', 'follow_hold')}
    # 换算成 cm（需要知道身体长度对应的实际长度）
    if stand_cm and A['wrist_h_release']:
        A['release_cm'] = {'mean': round(A['wrist_h_release']['mean'] * stand_cm, 1)}
    if stand_cm and A['jump_h']:
        A['jump_cm'] = {'mean': round(A['jump_h']['mean'] * stand_cm, 1)}
    return A


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pose')
    ap.add_argument('--seg', nargs=2, type=float, default=None, help='限定时间范围（秒）')
    ap.add_argument('--label', default='')
    ap.add_argument('--video', default='')
    ap.add_argument('--stand-cm', type=float, default=0.0, help='站立时肩-踝长度(cm)，用于换算')
    ap.add_argument('--out', default='')
    ap.add_argument('--export-kp', default='')
    ap.add_argument('--t-offset', type=float, default=0.0, help='导出骨骼点时减掉的时间偏移')
    a = ap.parse_args()

    t0, t1 = (a.seg if a.seg else (None, None))
    R = run(a.pose, t0, t1, a.stand_cm)
    A = summarize(R, a.stand_cm)

    print('== %s ==' % (a.label or os.path.basename(a.pose)))
    print('帧 %d   投篮手 %s（腕部行程 %.2f）  站立足长 %.3f  地面 y=%.3f'
          % (len(R['fr']), R['side'], R['rng'], R['stand'], R['ground']))
    print('检出出手 %d 次\n' % len(R['shots']))
    print(' t出手   t下蹲  蹲→出   肘角  前臂   蹲深  躯干倾  起跳   随球')
    for s in R['shots']:
        print('%6.2f %6.2f %6.2f %6.1f %6.1f %6.1f %6.1f %6.3f %6.2f' % (
            s['t_release'], s['t_dip'], s['t_crouch'],
            s['elbow_release'] or 0, s['forearm_release'] or 0,
            s['knee_min'] or 0, s['lean_release'] or 0,
            s['jump_h'], s['follow_hold']))
    print()
    for k, v in A.items():
        print('  %-17s %s' % (k, v))

    if a.out:
        os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
        json.dump({
            'meta': {'label': a.label, 'video': a.video, 'segment': [t0, t1],
                     'side': R['side'], 'stand_norm': round(R['stand'], 4),
                     'stand_cm': a.stand_cm or None},
            'agg': A, 'shots': R['shots'],
        }, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('->', a.out)

    if a.export_kp:
        off = a.t_offset
        rec = [[round(f['t'] - off, 3),
                [round(v, 4) for i in range(33) for v in (f['pts'][i][0], f['pts'][i][1])]]
               for f in R['fr']]
        js = ('/* 自动生成：%s 真实骨骼点（MediaPipe PoseLandmarker full）\n'
              '   %d 帧，每帧 33 点 x/y 归一化坐标，t 为相对视频起点秒数 */\n'
              'window.BB = window.BB || {};\nBB.poseBundle = BB.poseBundle || {};\n'
              'BB.poseBundle["%s"] = {"t0": %s, "n": %d, "pts": %s};\n') % (
            a.label, len(rec), a.label, rec[0][0] if rec else 0, len(rec),
            json.dumps([r[1] for r in rec], separators=(',', ':')))
        open(a.export_kp, 'w', encoding='utf-8').write(js)
        print('-> %s (%.0f KB)' % (a.export_kp, len(js) / 1024))


if __name__ == '__main__':
    main()
