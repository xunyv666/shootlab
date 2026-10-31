#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
用 MediaPipe Tasks API 提取视频中的人体关键点，并计算投篮相关指标。

用法:
  python extract_pose.py <video> <out.json> [--start 秒] [--end 秒] [--stride 1] [--model full|heavy]

输出 JSON:
{
  "meta": {...},
  "frames": [
     {"t": 12.34, "pts": [[x,y,z,vis], ... 33 点],
      "m": {"elbow": 152.3, "knee": 148.0, "armSlope": 78.1, ...}}
  ],
  "summary": {...}
}
坐标 x,y 已归一化到 [0,1]，y 向下。
"""
import sys, os, json, math, argparse, time
import numpy as np
import cv2

from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
import mediapipe as mp

# BlazePose 33 点索引
NOSE = 0
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANKLE, R_ANKLE = 27, 28
L_HEEL, R_HEEL = 29, 30
L_FOOT, R_FOOT = 31, 32


def angle(a, b, c):
    """b 为顶点，返回 a-b-c 的夹角（度）"""
    ax, ay = a[0] - b[0], a[1] - b[1]
    cx, cy = c[0] - b[0], c[1] - b[1]
    n1 = math.hypot(ax, ay)
    n2 = math.hypot(cx, cy)
    if n1 < 1e-9 or n2 < 1e-9:
        return None
    cosv = (ax * cx + ay * cy) / (n1 * n2)
    cosv = max(-1.0, min(1.0, cosv))
    return math.degrees(math.acos(cosv))


def seg_angle_from_horizontal(a, b):
    """a->b 连线与水平方向夹角（度）。归一化到 (-90, 90]，
    避免 atan2 在 ±180 附近跳变导致统计失真。"""
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return None
    ang = -math.degrees(math.atan2(dy, dx))
    while ang > 90:
        ang -= 180
    while ang <= -90:
        ang += 180
    return ang


def pick(side):
    """返回该侧的关键点索引组"""
    if side == 'r':
        return R_SHOULDER, R_ELBOW, R_WRIST, R_HIP, R_KNEE, R_ANKLE
    return L_SHOULDER, L_ELBOW, L_WRIST, L_HIP, L_KNEE, L_ANKLE


def body_scale(pts):
    """用肩宽 + 髋-踝高度估计身体尺度，做归一化基准"""
    ls, rs = pts[L_SHOULDER], pts[R_SHOULDER]
    lh, rh = pts[L_HIP], pts[R_HIP]
    la, ra = pts[L_ANKLE], pts[R_ANKLE]
    sh_w = math.hypot(ls[0] - rs[0], ls[1] - rs[1])
    hip_y = (lh[1] + rh[1]) / 2
    ank_y = (la[1] + ra[1]) / 2
    leg = abs(ank_y - hip_y)
    # 髋到脚踝约为身高的 0.48~0.52
    height = leg * 2.05 if leg > 1e-6 else 0
    return sh_w, leg, height


def metrics_for(pts, side):
    """计算一帧的指标。side: 'r'/'l' 投篮手"""
    s, e, w, h, k, a = pick(side)
    m = {}
    # 投篮臂肘角
    m['elbow'] = angle(pts[s][:2], pts[e][:2], pts[w][:2])
    # 前臂与水平夹角（出手角代理量：正面机位下前臂上扬角度）
    m['forearm'] = seg_angle_from_horizontal(pts[e][:2], pts[w][:2])
    # 上臂与水平夹角
    m['upperArm'] = seg_angle_from_horizontal(pts[s][:2], pts[e][:2])
    # 投篮侧膝角
    m['knee'] = angle(pts[h][:2], pts[k][:2], pts[a][:2])
    # 双肩连线倾角（平衡/对称性，正面机位才有意义）
    m['shoulderTilt'] = seg_angle_from_horizontal(pts[L_SHOULDER][:2], pts[R_SHOULDER][:2])
    m['hipTilt'] = seg_angle_from_horizontal(pts[L_HIP][:2], pts[R_HIP][:2])
    # 高度指标：用「肩到脚踝」的竖直跨度做归一，比髋-踝或身高估计稳健得多
    # 1.00 ≈ 手腕与肩同高；>1.25 ≈ 手举过头顶
    ank = (pts[L_ANKLE][1] + pts[R_ANKLE][1]) / 2
    sh_y = (pts[L_SHOULDER][1] + pts[R_SHOULDER][1]) / 2
    span = ank - sh_y
    if span > 0.02:
        m['wristRise'] = (ank - pts[w][1]) / span
        m['elbowRise'] = (ank - pts[e][1]) / span
        m['hipRise'] = (ank - pts[h][1]) / span
        m['bodySpan'] = span
    else:
        m['wristRise'] = m['elbowRise'] = m['hipRise'] = None
        m['bodySpan'] = None
    # 兼容字段
    m['wristH'] = m['wristRise']
    # 手腕是否高于肘（跟随动作 / 出手到位）
    m['wristAboveElbow'] = pts[w][1] < pts[e][1]
    # 左右手腕高度差（双手对称），按身体跨度归一化
    if span > 0.02:
        m['wristSym'] = abs(pts[L_WRIST][1] - pts[R_WRIST][1]) / span
    else:
        m['wristSym'] = None
    # 肘部外展：肘点相对肩-腕连线在水平方向的偏移（正面投射，判断"肘部内收"）
    sx, sy = pts[s][0], pts[s][1]
    wx, wy = pts[w][0], pts[w][1]
    ex, ey = pts[e][0], pts[e][1]
    if abs(wy - sy) > 1e-6:
        t = (ey - sy) / (wy - sy)
        line_x = sx + t * (wx - sx)
        m['elbowOut'] = (ex - line_x) * (1 if side == 'r' else -1)
    else:
        m['elbowOut'] = None
    # 可见度下限
    m['minVis'] = min(pts[i][3] for i in (s, e, w, h, k, a))
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('out')
    ap.add_argument('--start', type=float, default=0)
    ap.add_argument('--end', type=float, default=-1)
    ap.add_argument('--stride', type=int, default=1)
    ap.add_argument('--model', default='full', choices=['full', 'heavy'])
    ap.add_argument('--side', default='r', choices=['r', 'l'])
    ap.add_argument('--complexity', type=int, default=1)
    args = ap.parse_args()

    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              '..', 'media', 'models', 'pose_landmarker_%s.task' % args.model)
    if not os.path.exists(model_path):
        print('model not found:', model_path)
        sys.exit(1)
    # MediaPipe 的 C++ 层无法打开含非 ASCII 字符的路径，
    # 中文目录下必须先把模型复制到纯英文临时路径
    try:
        model_path.encode('ascii')
    except UnicodeEncodeError:
        import tempfile, shutil
        safe_dir = os.path.join(tempfile.gettempdir(), 'bp_models')
        os.makedirs(safe_dir, exist_ok=True)
        safe = os.path.join(safe_dir, os.path.basename(model_path))
        if not os.path.exists(safe) or os.path.getsize(safe) != os.path.getsize(model_path):
            shutil.copy2(model_path, safe)
        model_path = safe
        print('model relocated ->', model_path)

    base = mp_python.BaseOptions(model_asset_path=model_path)
    opts = vision.PoseLandmarkerOptions(
        base_options=base,
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.3,
        min_pose_presence_confidence=0.3,
        min_tracking_confidence=0.3,
        output_segmentation_masks=False,
    )
    landmarker = vision.PoseLandmarker.create_from_options(opts)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print('cannot open video')
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    t_start = args.start
    t_end = args.end if args.end > 0 else total / fps
    f0 = int(t_start * fps)
    f1 = min(total, int(t_end * fps))

    frames = []
    t0 = time.time()
    idx = f0
    cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
    while idx < f1:
        ok, frame = cap.read()
        if not ok:
            break
        if (idx - f0) % args.stride != 0:
            idx += 1
            continue
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        ts_ms = int(idx * 1000 / fps)
        res = landmarker.detect_for_video(mp_img, ts_ms)
        t = idx / fps
        if res.pose_landmarks:
            lm = res.pose_landmarks[0]
            pts = [[round(p.x, 5), round(p.y, 5), round(p.z, 5), round(p.visibility, 3)] for p in lm]
            m = metrics_for(pts, args.side)
            frames.append({'t': round(t, 3), 'f': idx, 'pts': pts, 'm': m})
        else:
            frames.append({'t': round(t, 3), 'f': idx, 'pts': None, 'm': None})
        idx += 1
        if (idx - f0) % 200 == 0:
            print('  %d/%d  %.1fs' % (idx - f0, f1 - f0, time.time() - t0), flush=True)

    cap.release()
    landmarker.close()

    ok_n = sum(1 for f in frames if f['pts'])
    out = {
        'meta': {
            'video': os.path.abspath(args.video),
            'w': w, 'h': h, 'fps': round(fps, 3),
            'start': t_start, 'end': t_end, 'stride': args.stride,
            'model': args.model, 'side': args.side,
            'frames_total': len(frames), 'frames_detected': ok_n,
            'elapsed_s': round(time.time() - t0, 1),
        },
        'frames': frames,
    }
    with open(args.out, 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False)
    print('done: %d frames, %d detected, %.1fs -> %s' % (len(frames), ok_n, time.time() - t0, args.out))


if __name__ == '__main__':
    main()
