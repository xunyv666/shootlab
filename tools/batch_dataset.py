#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""批量分析：把一段素材里能识别到的每一次出手都算一遍，汇总成样本库。

和 build_experiment.py 的区别：
  那个是「一次出手做深」（切片 + 骨骼包 + 前端数据），
  这个是「多次出手做广」（只要指标，用来做统计和基线对比）。

用法:
  python batch_dataset.py --case "许涛矫正" --video ../media/xutao_case_720p.mp4 \
      --pose ../media/pose_xt_188.json --seg 188 207
"""
import argparse, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import experiment as E
import ball_track as BT

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
NOSE = 0


def shot_at(R, pi, height_cm):
    """按 build_experiment.py 同一套口径算一次出手的指标"""
    t, C = R['t'], R['C']
    rel = float(t[pi])
    loc = (t >= rel - 1.0) & (t <= rel + 0.8)
    idx = np.flatnonzero(loc)
    if len(idx) < 5:
        return None
    stand = float(np.nanpercentile(C['bodyLen'][idx], 90))
    ground = float(np.nanpercentile(C['ank_y'][idx], 95))

    # 站立参照：脚在地面上、身体最直的一帧
    ong = idx[C['ank_y'][idx] > ground - 0.03 * stand]
    cand = ong if len(ong) >= 5 else idx
    up = int(cand[int(np.nanargmax(C['bodyLen'][cand]))])
    fu = [x for x in R['fr'] if abs(x['t'] - t[up]) < 1e-6][0]['pts']
    span = max(fu[E.L_AN][1], fu[E.R_AN][1]) - fu[NOSE][1]
    if span < 0.08:
        return None
    cm = height_cm / (span / 0.891)

    # 下蹲：出手前 1.2 秒内膝角最小
    win = np.flatnonzero((t >= rel - 1.2) & (t <= rel))
    knee = C['knee'][win]
    jd = int(win[int(np.nanargmin(knee))]) if not np.isnan(knee).all() else pi

    # 随球：出手后手腕高于峰值 0.9 倍的时长
    dt = float(np.median(np.diff(t)))
    wh = (ground - C['wrist_y']) / stand
    pk = float(np.nanmax(wh[max(0, pi - 1):min(len(t), pi + 20)]))
    hold = 0.0
    for k in range(pi, len(t)):
        if wh[k] >= pk * 0.9:
            hold += dt
        else:
            break

    wr = 16 if R['side'] == 'r' else 15
    frs = [f for f in R['fr'] if abs(f['t'] - rel) < 0.05]
    bt = None
    if frs:
        bt = BT.track(R['video'], rel, frs[0]['pts'][wr][0], frs[0]['pts'][wr][1])
    angle = bt.get('angle') if bt and bt.get('ok') else None

    def g(k):
        v = C[k][pi]
        return None if v != v else float(v)

    return {
        't': round(rel, 2),
        'heightCm': height_cm,
        'releaseAngle': angle,
        'elbowAngle': None if g('elbow') is None else round(g('elbow'), 1),
        'releaseHeight': round((ground - C['wrist_y'][pi]) * cm, 1),
        'jumpHeight': round((ground - C['ank_y'][pi]) * cm, 1),
        'torsoLean': None if g('lean') is None else round(g('lean'), 1),
        'releaseTime': round(rel - float(t[jd]), 2),
        'followHold': round(min(hold, 1.2), 2),
        'kneeFlex': None if np.isnan(knee).all() else round(float(np.nanmin(knee)), 1),
        'ballPoints': (bt or {}).get('n_points', 0)
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--case', required=True)
    ap.add_argument('--video', required=True)
    ap.add_argument('--pose', required=True)
    ap.add_argument('--seg', nargs=2, type=float, required=True)
    ap.add_argument('--height', type=float, default=180.0)
    ap.add_argument('--out', default='../prototype/js/dataset.js')
    a = ap.parse_args()

    R = E.run(a.pose, a.seg[0], a.seg[1])
    R['video'] = a.video
    t, C = R['t'], R['C']
    stand = float(np.nanpercentile(C['bodyLen'], 90))
    ground = float(np.nanpercentile(C['ank_y'], 95))
    wh = (ground - C['wrist_y']) / stand
    peaks, _ = E.detect(t, wh)

    shots = []
    for p in peaks:
        s = shot_at(R, p, a.height)
        if not s:
            continue
        # 教学视频里有大量非投篮动作（上篮、摸高、走路），要筛掉：
        # 起跳超过 35cm 或出手点离谱的，基本不是定点投篮
        if s['jumpHeight'] is None or not (-1 <= s['jumpHeight'] <= 35):
            print('  跳过 %.2fs：起跳 %.1fcm 不像定点投篮' % (s['t'], s['jumpHeight']))
            continue
        if s['releaseHeight'] is None or not (175 <= s['releaseHeight'] <= 235):
            print('  跳过 %.2fs：出手点 %.1fcm 不合理' % (s['t'], s['releaseHeight']))
            continue
        if s['kneeFlex'] is None or s['kneeFlex'] < 110:
            print('  跳过 %.2fs：膝角 %.1f° 不像投篮下蹲' % (s['t'], s['kneeFlex'] or 0))
            continue
        if s['elbowAngle'] is None or s['elbowAngle'] < 120:
            print('  跳过 %.2fs：肘角 %.1f° 不像投篮出手' % (s['t'], s['elbowAngle']))
            continue
        s['case'] = a.case
        shots.append(s)
    print('%s：%d 次出手' % (a.case, len(shots)))
    for s in shots:
        print('  %.2fs 出手角 %s 肘角 %s 出手点 %s 跳 %s 膝 %s' % (
            s['t'], s['releaseAngle'], s['elbowAngle'],
            s['releaseHeight'], s['jumpHeight'], s['kneeFlex']))

    path = os.path.join(ROOT, 'prototype', 'js', 'dataset.js')
    old = {}
    if os.path.exists(path):
        try:
            txt = open(path, encoding='utf-8').read()
            # 从 BB.Dataset= 之后开始解析：前面还有 window.BB=window.BB||{}; 的花括号
            i = txt.index('BB.Dataset=')
            old = json.loads(txt[txt.index('{', i):txt.rindex('}') + 1])
        except Exception:
            old = {}
    pool = [s for s in (old.get('shots') or []) if s.get('case') != a.case] + shots
    pool.sort(key=lambda s: (s['case'], s['t']))
    for i, s in enumerate(pool):
        s['id'] = i + 1

    def agg(key):
        v = [s[key] for s in pool if s.get(key) is not None]
        return None if not v else round(float(np.mean(v)), 1)

    def agg_ratio(num, den='heightCm'):
        v = [s[num] / s[den] for s in pool
             if s.get(num) is not None and s.get(den)]
        return None if not v else round(float(np.mean(v)), 3)

    data = {
        'shots': pool,
        'summary': {
            'n': len(pool),
            'cases': len(set(s['case'] for s in pool)),
            'releaseAngle': agg('releaseAngle'),
            'elbowAngle': agg('elbowAngle'),
            'releaseHeight': agg('releaseHeight'),
            'jumpHeight': agg('jumpHeight'),
            'torsoLean': agg('torsoLean'),
            'releaseTime': agg('releaseTime'),
            'followHold': agg('followHold'),
            'kneeFlex': agg('kneeFlex'),
            'releaseRatio': agg_ratio('releaseHeight'),
            'jumpRatio': agg_ratio('jumpHeight')
        }
    }
    open(path, 'w', encoding='utf-8').write(
        '/* 自动生成，勿手改 —— 真实素材批量分析的样本库\n'
        '   每个 case 都是一段真实比赛/教学视频，指标口径同 build_experiment.py */\n'
        'window.BB=window.BB||{};BB.Dataset=%s;\n'
        % json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    print('样本库累积 %d 次出手 / %d 段素材 -> %s' % (data['summary']['n'], data['summary']['cases'], path))


if __name__ == '__main__':
    main()
