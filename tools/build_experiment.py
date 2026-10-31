#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一次实验的完整构建：切片 -> 骨骼包 -> 指标 -> 球轨迹 -> 前端数据。

产物（全部给原型直接用）：
  prototype/media/exp_shot.webm     切片（浏览器可直接播）
  prototype/js/pose_exp.js          逐帧 33 点骨骼（叠在真实视频上）
  prototype/js/experiment.js        实验数据（8 维原始值 + 逐帧曲线 + 球轨迹）

用法:
  python build_experiment.py --video media/xutao_case_720p.mp4 --pose media/pose_xt_188.json \
      --seg 188.6 192.4 --release 190.62 --stand-cm 148 --height-cm 180
"""
import json, os, sys, argparse
import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiment as E
import ball_track as BT

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def cut_clip(video, t0, t1, out, fourcc='VP90', scale=1.0):
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    f0, f1 = int(round(t0 * fps)), int(round(t1 * fps))
    w = int(cap.get(3) * scale); h = int(cap.get(4) * scale)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*fourcc), fps, (w, h))
    cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
    n = 0
    for _ in range(f1 - f0):
        ok, fr = cap.read()
        if not ok:
            break
        if scale != 1.0:
            fr = cv2.resize(fr, (w, h), interpolation=cv2.INTER_AREA)
        vw.write(fr)
        n += 1
    vw.release()
    cap.release()
    return n, round(n / fps, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--pose', required=True)
    ap.add_argument('--seg', nargs=2, type=float, required=True)
    ap.add_argument('--release', type=float, required=True)
    ap.add_argument('--stand-cm', type=float, default=0.0,
                    help='肩-髋-踝路径长度(cm)；0 表示按 0.76×身高 自动推算')
    ap.add_argument('--height-cm', type=float, default=180.0)
    ap.add_argument('--subject', default='实验样本')
    ap.add_argument('--source', default='')
    ap.add_argument('--tag', default='exp')
    a = ap.parse_args()

    t0, t1 = a.seg
    R = E.run(a.pose, t0 - 2.0, t1)          # 多取 2 秒给窗口留余量
    t = R['t']; C = R['C']; stand = R['stand']; ground = R['ground']
    rel = float(a.release)

    # 局部基准：人物在固定机位里会前后移动，脚在画面中的位置随之改变。
    # 用整段的 95 分位当"地面"会把远处/近处的脚混在一起，
    # 高度类指标会系统性偏低。所以只在出手前后 ±1 秒内取局部地面与站立足长。
    loc = (t >= rel - 1.0) & (t <= rel + 0.8)
    stand_l = float(np.nanpercentile(C['bodyLen'][loc], 90))
    ground_l = float(np.nanpercentile(C['ank_y'][loc], 95))
    print('局部站立基准 %.3f / 地面 %.3f（整段 %.3f / %.3f）'
          % (stand_l, ground_l, stand, ground))
    stand, ground = stand_l, ground_l

    # —— 1. 切片 ——
    clip = os.path.join(ROOT, 'prototype', 'media', 'exp_shot.webm')
    n, dur = cut_clip(a.video, t0, t1, clip)
    print('切片 %d 帧 %.2fs -> %s (%.1f MB)' % (n, dur, clip, os.path.getsize(clip) / 1e6))

    # —— 2. 像素尺度：用「鼻尖→踝」当身高标尺 ——
    # 之前用 bodyLen(肩→髋 + 髋→踝) × 0.76×身高 换算，实测低估 10% 以上：
    # 侧向机位有透视，2D 链长比人体真实比例偏长，拿它当尺子会把所有高度压扁。
    # 换成鼻尖(y) → 踝(y) 的跨度：Drillis & Contini 人体比例里鼻尖≈0.930H、
    # 踝≈0.039H，两点相差 0.891H，反推 cm/单位，全程自洽、可用画面复核。
    # 站立参照要挑「脚在地面上、身体最直」的一帧：
    # 只取 bodyLen 最大会挑到起跳后双腿并拢的画面，鼻→踝反而变长，
    # 尺度被放大约 3%。先用地面上（踝点接近地面基准）作为硬门槛。
    loc_i = np.flatnonzero(loc)
    on_ground = loc_i[C['ank_y'][loc_i] > ground - 0.03 * stand]
    cand = on_ground if len(on_ground) >= 5 else loc_i
    upright = int(cand[np.nanargmax(C['bodyLen'][cand])])
    fu = [x for x in R['fr'] if abs(x['t'] - t[upright]) < 1e-6][0]['pts']
    nose_y = fu[0][1]
    ank_y_u = max(fu[27][1], fu[28][1])
    if a.stand_cm:
        # 已知肩-髋-踝路径长度时直接用它定标（更准，但要人肉量过）
        cm_per_unit = a.stand_cm / stand
        print('尺度：用 --stand-cm %.1f 定标 -> %.2f cm/单位' % (a.stand_cm, cm_per_unit))
    else:
        cm_per_unit = a.height_cm / ((ank_y_u - nose_y) / 0.891)
        print('尺度参照 t=%.2f  鼻→踝 %.4f  -> %.2f cm/单位（等效站立 %.1f cm）'
              % (t[upright], ank_y_u - nose_y, cm_per_unit, cm_per_unit * stand))

    # —— 2b. 手腕归一化高度（地面 + 站立足长）——
    wrist_h = (ground - C['wrist_y']) / stand
    pi = int(np.argmin(np.abs(t - rel)))

    # 下蹲点：出手前 1.2 秒内的膝角最小值（不能用整窗最小值，
    # 否则会把「两秒前弯腰捡球」当成下蹲起点，得出 2.1 秒的假节奏）
    win = (t >= rel - 1.2) & (t <= rel)
    idx = np.flatnonzero(win)
    knee = C['knee'][win]
    j_dip_local = int(np.nanargmin(knee)) if not np.isnan(knee).all() else 0
    j_dip = int(idx[j_dip_local])
    t_dip = float(t[j_dip])

    def at(key, j):
        v = C[key][j]
        return None if v != v else float(v)

    # —— 3. 球轨迹 -> 出手角度 ——
    wr = 16 if R['side'] == 'r' else 15
    frs = [f for f in R['fr'] if abs(f['t'] - rel) < 0.05]
    wx, wy = (frs[0]['pts'][wr][0], frs[0]['pts'][wr][1]) if frs else (0.5, 0.3)
    bt = BT.track(a.video, rel, wx, wy)

    # —— 4. 指标汇总 ——
    # 高度一律走像素尺度（cm_per_unit），不再用 0.76×身高 的粗估
    stand_cm = round(cm_per_unit * stand, 1)
    release_h_cm = round((ground - C['wrist_y'][pi]) * cm_per_unit, 1)
    jump_cm = round((ground - C['ank_y'][pi]) * cm_per_unit, 1)
    elbow = at('elbow', pi)
    lean = at('lean', pi)
    knee_flex = at('knee', j_dip)
    lean = None if lean is None else round(lean, 1)
    t_crouch = round(rel - t_dip, 2)

    # 随球保持：出手后手腕仍高于「峰值 0.9 倍」的时长（秒）
    # 以前换算成百分制（hold/1.2×100），那个 1.2 秒封顶没有依据，
    # 结果几乎所有样本都是 100 分、没有区分度。现在只输出秒数。
    dt = float(np.median(np.diff(t)))
    hold = 0.0
    pk = float(np.nanmax(wrist_h[(t >= rel - 0.1) & (t <= rel + 1.2)])) if True else 0
    for k in range(pi, len(t)):
        if wrist_h[k] >= pk * 0.9:
            hold += dt
        else:
            break

    raw = {
        'heightCm': a.height_cm,
        'releaseAngle': bt.get('angle') if bt and bt.get('ok') else None,
        'elbowAngle': None if elbow is None else round(elbow, 1),
        'releaseHeight': release_h_cm,
        'jumpHeight': jump_cm,
        'torsoLean': lean,
        'releaseTime': t_crouch,
        'followHold': round(min(hold, 1.2), 2),
        'kneeFlex': None if knee_flex is None else round(knee_flex, 1),
    }
    print('\n出手时刻 %.2fs（下蹲 %.2fs，蹲→出 %.2fs）' % (rel, t_dip, t_crouch))
    for k, v in raw.items():
        print('  %-14s %s' % (k, v))
    print('  球轨迹: %s' % (bt,))

    # —— 5. 逐帧曲线（给趋势图用）——
    # 只做显示用的 3 点中值滤波：MediaPipe 的逐帧角度有 1-3° 抖动，
    # 直接画出来像毛刺；但指标计算仍用原始值，不用平滑后的数。
    def med(v):
        out = v.copy()
        for i in range(1, len(v) - 1):
            w3 = [v[i - 1], v[i], v[i + 1]]
            w3 = [x for x in w3 if x == x]
            if w3:
                out[i] = float(np.median(w3))
        return out
    el_s, kn_s = med(C['elbow']), med(C['knee'])
    curve = []
    for k in range(len(t)):
        if t[k] < t0 - 1e-6 or t[k] > t1 + 1e-6:
            continue
        curve.append([
            round(float(t[k] - t0), 3),
            round(float(wrist_h[k]), 3) if wrist_h[k] == wrist_h[k] else None,
            None if el_s[k] != el_s[k] else round(float(el_s[k]), 1),
            None if kn_s[k] != kn_s[k] else round(float(kn_s[k]), 1),
        ])

    # —— 6. 骨骼包 ——
    pb = []
    for f in R['fr']:
        if f['t'] < t0 - 1e-6 or f['t'] > t1 + 1e-6:
            continue
        pb.append([round(f['t'] - t0, 3),
                   [round(v, 4) for i in range(33) for v in (f['pts'][i][0], f['pts'][i][1])]])
    js = ('/* 自动生成：%s 真实骨骼点（MediaPipe PoseLandmarker full），%d 帧，勿手改 */\n'
          'window.BB=window.BB||{};BB.poseBundle=BB.poseBundle||{};\n'
          'BB.poseBundle["%s"]={"n":%d,"pts":%s};\n') % (
        a.subject, len(pb), a.tag, len(pb), json.dumps([p[1] for p in pb], separators=(',', ':')))
    p1 = os.path.join(ROOT, 'prototype', 'js', 'pose_exp.js')
    open(p1, 'w', encoding='utf-8').write(js)
    print('\n骨骼包 -> %s (%.0f KB)' % (p1, len(js) / 1024))

    exp = {
        'meta': {
            'subject': a.subject,
            'source': a.source,
            'tag': a.tag,
            'video': 'media/exp_shot.webm',
            'clip': [round(t0, 2), round(t1, 2)],
            'duration': dur,
            'fps': 30,
            'releaseAt': round(rel - t0, 2),
            'releaseAtAbs': rel,
            'side': R['side'],
            'standCm': stand_cm,
            'heightCm': a.height_cm,
            'ballTrack': {k: bt[k] for k in ('ok', 'angle', 'n_points', 't_span')} if bt else None,
            'curveNote': '角度曲线显示用 3 点中值滤波；指标计算用原始值',
        },
        'shots': [{
            'id': 1,
            'tRel': round((rel - t0) / dur, 4),
            'tAbs': round(rel, 2),
            'made': None,
            'raw': raw,
        }],
        'curve': curve,
        'dipAt': round(t_dip - t0, 3),
    }
    p2 = os.path.join(ROOT, 'prototype', 'js', 'experiment.js')
    open(p2, 'w', encoding='utf-8').write(
        '/* 自动生成，勿手改 —— 真实实验数据\n'
        '   视频 %s  区段 %.1f-%.1f s  出手 %.2f s\n'
        '   MediaPipe PoseLandmarker(full) + HSV 球轨迹 */\n'
        'window.BB=window.BB||{};BB.Experiment=%s;\n' % (
            a.source or a.video, t0, t1, rel,
            json.dumps(exp, ensure_ascii=False, separators=(',', ':'))))
    print('实验数据 -> %s (%.0f KB)' % (p2, os.path.getsize(p2) / 1024))


if __name__ == '__main__':
    main()
