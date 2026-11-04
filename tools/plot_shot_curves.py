#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""画库里出手过程的时间序列曲线"""
import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

for cand in ['Microsoft YaHei', 'SimHei', 'DengXian']:
    try:
        font_manager.findfont(cand, fallback_to_default=False)
        plt.rcParams['font.sans-serif'] = [cand]
        break
    except Exception:
        continue
plt.rcParams['axes.unicode_minus'] = False

SEGS = [('media/pose_shot_610.json', '① 10:10 立定出手（手举过顶）'),
        ('media/pose_shot_357.json', '② 05:57 带下蹲的出手')]

fig, axes = plt.subplots(2, 1, figsize=(11, 7.2), dpi=130)
fig.patch.set_facecolor('#12141a')

for ax, (path, title) in zip(axes, SEGS, strict=False):
    d = json.load(open(path, encoding='utf-8'))
    fr = [f for f in d['frames'] if f['pts']]
    t = [f['t'] - fr[0]['t'] for f in fr]
    wr = [f['m']['wristRise'] or 0 for f in fr]
    el = [f['m']['elbow'] or 0 for f in fr]
    kn = [f['m']['knee'] or 0 for f in fr]

    ax.set_facecolor('#171a21')
    ax.plot(t, wr, color='#ffb020', lw=2.4, label='手腕高度（肩-踝归一）')
    ax.set_ylabel('腕高', color='#ffb020', fontsize=10)
    ax.tick_params(axis='y', labelcolor='#ffb020', labelsize=9)
    ax.tick_params(axis='x', colors='#8b93a3', labelsize=9)
    ax.set_ylim(0, 1.6)

    ax2 = ax.twinx()
    ax2.plot(t, el, color='#4ea1ff', lw=2.0, ls='-', label='肘角(°)')
    ax2.plot(t, kn, color='#39d98a', lw=1.6, ls='--', label='膝角(°)')
    ax2.set_ylabel('角度 (°)', color='#8b93a3', fontsize=10)
    ax2.tick_params(axis='y', labelcolor='#8b93a3', labelsize=9)
    ax2.set_ylim(0, 200)

    # 标出腕高峰值 = 出手时刻
    imax = wr.index(max(wr))
    ax.scatter([t[imax]], [wr[imax]], s=70, color='#ff4d4d', zorder=5,
               edgecolor='white', linewidth=1.2)
    ax.annotate('出手 %.0f°' % el[imax], (t[imax], wr[imax]),
                textcoords='offset points', xytext=(10, 6),
                color='#ff8a8a', fontsize=10, fontweight='bold')

    ax.set_title(title, color='white', fontsize=12, loc='left', pad=8)
    ax.grid(alpha=0.13, color='#6b7385')
    for s in ax.spines.values():
        s.set_color('#2b303a')
    for s in ax2.spines.values():
        s.set_color('#2b303a')

    lines = ax.get_lines()[:1] + ax2.get_lines()
    ax.legend(lines, [l.get_label() for l in lines], loc='lower right',
              facecolor='#1c2029', edgecolor='#2b303a',
              labelcolor='#c9ced8', fontsize=9, framealpha=0.9)

axes[-1].set_xlabel('片段内时间 (秒)', color='#8b93a3', fontsize=10)
plt.tight_layout()
plt.savefig('media/_shot_curves.png', facecolor='#12141a')
print('saved media/_shot_curves.png')
