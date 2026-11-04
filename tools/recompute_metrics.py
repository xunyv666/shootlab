#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从已提取的 pose json 重新计算指标（不重跑推理），用于算法迭代。
用法: python recompute_metrics.py <in.json> <out.json> [--side r|l]
"""
import sys
import os
import json
import argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_pose import metrics_for


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--side', default='r')
    args = ap.parse_args()
    d = json.load(open(args.inp, encoding='utf-8'))
    n = 0
    for f in d['frames']:
        if f.get('pts'):
            f['m'] = metrics_for(f['pts'], args.side)
            n += 1
    json.dump(d, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False)
    print('recomputed %d frames -> %s' % (n, args.out))


if __name__ == '__main__':
    main()
