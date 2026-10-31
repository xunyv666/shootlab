#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从骨骼序列里自动切分「一次投篮」，并提取该次出手的关键指标。

切分逻辑：
  1. 找 wristRise 的局部峰值（手举最高 = 出手瞬间）
  2. 峰值需 > 1.15（手举过肩）
  3. 两次出手间隔 > 0.8s
  4. 每次取 [峰值-1.2s, 峰值+0.4s] 作为动作窗口
  5. 窗口内找膝角最小值 = 下蹲最深，用峰值减它 = 下蹲幅度

用法: python segment_shots.py <pose.json> [--min-gap 0.8] [--out shots.json]
"""
import json, sys, argparse
import numpy as np


def load_series(path, side='r'):
    d = json.load(open(path, encoding='utf-8'))
    fr = [f for f in d['frames'] if f.get('pts')]
    t = np.array([f['t'] for f in fr], dtype=float)
    def col(k):
        return np.array([(f['m'].get(k) if f['m'].get(k) is not None else np.nan) for f in fr], dtype=float)
    return d, fr, t, {
        'wrist': col('wristRise'), 'elbow': col('elbow'), 'knee': col('knee'),
        'shoulder': col('shoulderTilt'), 'hip': col('hipTilt'),
        'sym': col('wristSym'), 'forearm': col('forearm'), 'upper': col('upperArm'),
    }


def segment(path, min_gap=0.8, peak_thr=1.15, pre=1.2, post=0.4):
    d, fr, t, S = load_series(path)
    if len(t) < 5:
        return []
    w = S['wrist'].copy()
    # 用 nan 插值补洞
    nans = np.isnan(w)
    if nans.all():
        return []
    if nans.any():
        idx = np.arange(len(w))
        w[nans] = np.interp(idx[nans], idx[~nans], w[~nans])

    dt = float(np.median(np.diff(t))) if len(t) > 1 else 0.033
    # 简单滑动平均，抑制抖动
    k = max(1, int(round(0.1 / dt)))
    if k > 1:
        kern = np.ones(k) / k
        ws = np.convolve(w, kern, mode='same')
    else:
        ws = w

    peaks = []
    for i in range(1, len(ws) - 1):
        if ws[i] >= ws[i - 1] and ws[i] >= ws[i + 1] and ws[i] > peak_thr:
            if peaks and t[i] - t[peaks[-1]] < min_gap:
                if ws[i] > ws[peaks[-1]]:
                    peaks[-1] = i
                continue
            peaks.append(i)

    shots = []
    for pi in peaks:
        tp = t[pi]
        mask = (t >= tp - pre) & (t <= tp + post)
        if mask.sum() < 3:
            continue
        seg = {k: v[mask] for k, v in S.items()}
        tseg = t[mask]

        def at_peak(k):
            v = seg[k]
            if np.isnan(v).all():
                return None
            j = int(np.nanargmin(np.abs(tseg - tp)))
            return None if np.isnan(v[j]) else float(v[j])

        def nanmin(k):
            v = seg[k]
            return None if np.isnan(v).all() else float(np.nanmin(v))

        def nanmax(k):
            v = seg[k]
            return None if np.isnan(v).all() else float(np.nanmax(v))

        def nanmean(k):
            v = seg[k]
            return None if np.isnan(v).all() else float(np.nanmean(v))

        knee_at_release = at_peak('knee')
        knee_min = nanmin('knee')
        wrist_peak = float(ws[pi])

        # 动作幅度校验：必须真的把球从低位举到高位。
        # 否则「保持举球姿势讲解」时的曲线小波动会被误判为一次出手。
        wseg = seg['wrist']
        rise = 0.0 if np.isnan(wseg).all() else float(np.nanmax(wseg) - np.nanmin(wseg))
        if rise < 0.3:
            continue

        shots.append({
            't_release': round(float(tp), 3),
            'wrist_peak': round(wrist_peak, 3),
            'wrist_rise': round(rise, 3),
            'elbow_at_release': None if at_peak('elbow') is None else round(at_peak('elbow'), 1),
            'elbow_max': None if nanmax('elbow') is None else round(nanmax('elbow'), 1),
            'knee_at_release': None if knee_at_release is None else round(knee_at_release, 1),
            'knee_min': None if knee_min is None else round(knee_min, 1),
            'dip': None if (knee_min is None or knee_at_release is None) else round(knee_at_release - knee_min, 1),
            'shoulder_tilt_abs': None if nanmean('shoulder') is None else round(float(np.nanmean(np.abs(seg['shoulder']))), 2),
            'hip_tilt_abs': None if nanmean('hip') is None else round(float(np.nanmean(np.abs(seg['hip']))), 2),
            'wrist_sym_peak': at_peak('sym') if at_peak('sym') is None else round(at_peak('sym'), 3),
            'window': [round(float(tseg[0]), 2), round(float(tseg[-1]), 2)],
        })
    return shots, d['meta'] if 'meta' in d else {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pose')
    ap.add_argument('--min-gap', type=float, default=0.8)
    ap.add_argument('--out', default='')
    a = ap.parse_args()
    shots, meta = segment(a.pose, a.min_gap)
    print('检出 %d 次出手' % len(shots))
    print('  t出手   腕高   肘角  膝角  下蹲  肩倾  ')
    for s in shots:
        print('%7.2f %6.2f %5s %5s %5s %5s' % (
            s['t_release'], s['wrist_peak'],
            s['elbow_at_release'] if s['elbow_at_release'] is not None else '-',
            s['knee_at_release'] if s['knee_at_release'] is not None else '-',
            s['dip'] if s['dip'] is not None else '-',
            s['shoulder_tilt_abs'] if s['shoulder_tilt_abs'] is not None else '-'))
    if a.out:
        json.dump({'meta': meta, 'shots': shots}, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('->', a.out)


if __name__ == '__main__':
    main()
