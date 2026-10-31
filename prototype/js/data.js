/* ============================================================
 * data.js  —  数据层（全局唯一数据源）
 * 归属：我（统筹）+ 臧子涵（指标定义）
 * 说明：真实接入时，只需把 BB.data.shots 换成 MediaPipe 计算结果，
 *       其余模块无需改动。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  /* ---------- 1. 八个动作维度：原始指标 -> 雷达分值 ----------

     评分区间分三种来源，不能再一锅炖：
     · 比值型（ratio）：用「实测值 ÷ 身高」比较，绝对值对身高不同的人无效。
       依据是 5 位 NBA 球员换算出来的分布（见 STARS 各条 note）。
     · 个性化型（dynamic）：目标不是常数，而是按出手条件算出来的。
       出手角用 Brancazio 最优角公式 θ = 45° + ½·atan((篮筐高 − 出手点高)/水平距离)，
       出手点越低的人越需要把弧线抬高，用统一区间会误判。
     · 常数型：有文献或经验依据的直接区间，src 里写清楚出处。
  */
  var HOOP_H = 3.05;          // 标准篮筐高度（米）
  var RAW_DIST = 4.6;         // 默认按罚球线算（米）；UI 可切换 4.6 / 5.8 / 6.75

  var DIMS = [
    { key: 'releaseAngle',  name: '出手角度',   raw: 'releaseAngle',  unit: '°',
      ideal: [45, 52], tol: 4.5, dynamic: 'brancazio',
      src: 'Brancazio 最优角公式；实测研究 44–52° 跨度大（Rojas 2000: 44–47，Knudson 1993: 52）' },

    { key: 'elbowAlign',    name: '肘部对位',   raw: 'elbowAngle',    unit: '°',
      ideal: [152, 172],    tol: 11,
      src: '出手瞬间肩-肘-腕接近伸直；业界口径不统一（部分项目量的是屈肘角 90–120°）' },

    { key: 'releaseHeight', name: '出手点高度', raw: 'releaseHeight', unit: '×身高',
      ideal: [1.15, 1.30],  tol: 0.06, ratio: 'heightCm',
      src: '5 位 NBA 球员换算后集中在 1.21–1.29×身高；下限放到 1.15 容纳业余' },

    { key: 'jump',          name: '起跳弹速',   raw: 'jumpHeight',    unit: '×身高',
      ideal: [0.10, 0.22],  tol: 0.05, ratio: 'heightCm',
      src: '同上，0.20–0.25×身高；下限放到 0.10 以容纳颠投（脚不离地属正常选择）' },

    { key: 'balance',       name: '躯干稳定',   raw: 'torsoLean',     unit: '°',
      ideal: [3, 8],        tol: 5,
      src: '建议值：跳投躯干轻微前倾 3–8°，本项无强文献支撑，按教学经验设定' },

    { key: 'tempo',         name: '出手节奏',   raw: 'releaseTime',   unit: 's',
      ideal: [0.9, 1.15],   tol: 0.2,
      src: '精英两分跳投 1.07–1.23s、三分 0.76–0.83s（塞尔维亚精英样本）；本区间对应两分跳投' },

    { key: 'followThrough', name: '随球保持',   raw: 'followHold',    unit: 's',
      ideal: [0.45, 0.95],  tol: 0.22,
      src: '出手后手腕维持在峰值 90% 以上的时长；原「百分制评分」无物理定义，已废弃' },

    { key: 'legDrive',      name: '下肢发力',   raw: 'kneeFlex',      unit: '°',
      ideal: [104, 124],    tol: 13,
      src: '下蹲最低点膝角；建议值，颠投与跳投会明显不同' }
  ];

  /* 指标卡只展示 6 个核心原始值 */
  var CARD_KEYS = ['releaseAngle', 'elbowAlign', 'releaseHeight', 'jump', 'tempo', 'balance'];

  /* ---------- 2. 球星基准（原始值，便于与用户同口径计算） ---------- */
  var STARS = {
    curry: {
      id: 'curry', name: '库里', en: 'Stephen Curry', team: '勇士',
      raw: { heightCm: 188, releaseAngle: 50.2, elbowAngle: 168, releaseHeight: 241, jumpHeight: 42, torsoLean: 5, releaseTime: 0.92, followHold: 1.18, kneeFlex: 112 },
      tag: '出手最快 · 弧线高',
      note: '单动式出手，接球到出手仅 0.4s，弧度普遍在 50° 以上。'
    },
    klay: {
      id: 'klay', name: '汤普森', en: 'Klay Thompson', team: '勇士',
      raw: { heightCm: 198, releaseAngle: 49.1, elbowAngle: 170, releaseHeight: 245, jumpHeight: 40, torsoLean: 5, releaseTime: 1.02, followHold: 1.15, kneeFlex: 108 },
      tag: '教科书模板',
      note: '下肢稳定、上身笔直，动作可复制度最高，最适合作为入门对照。'
    },
    durant: {
      id: 'durant', name: '杜兰特', en: 'Kevin Durant', team: '太阳',
      raw: { heightCm: 208, releaseAngle: 51.6, elbowAngle: 172, releaseHeight: 268, jumpHeight: 46, torsoLean: 4, releaseTime: 1.0, followHold: 1.13, kneeFlex: 100 },
      tag: '出手点极高',
      note: '身高臂展带来的超高出手点，普通身高球员不宜直接模仿高度。'
    },
    allen: {
      id: 'allen', name: '雷阿伦', en: 'Ray Allen', team: '名人堂',
      raw: { heightCm: 196, releaseAngle: 47.2, elbowAngle: 166, releaseHeight: 238, jumpHeight: 44, torsoLean: 4, releaseTime: 1.05, followHold: 1.19, kneeFlex: 115 },
      tag: '随球动作完美',
      note: '出手后手腕完全下压、手指指向篮筐，随球动作几乎无瑕疵。'
    },
    kobe: {
      id: 'kobe', name: '科比', en: 'Kobe Bryant', team: '名人堂',
      raw: { heightCm: 198, releaseAngle: 48.0, elbowAngle: 165, releaseHeight: 240, jumpHeight: 50, torsoLean: 6, releaseTime: 1.08, followHold: 1.14, kneeFlex: 118 },
      tag: '后仰与滞空',
      note: '强起跳 + 后仰，对核心力量要求高，不适合初学者模仿。'
    }
  };

  /* ---------- 3. 用户出手数据（MediaPipe 输出结构 / 当前为模拟） ---------- */
  /* raw: 原始指标; tRel: 在视频中的相对位置 0~1; made: 是否命中 */
  var SHOTS = [
    { id: 1, tRel: 0.074, made: false, raw: { heightCm: 182, releaseAngle: 43.6, elbowAngle: 148, releaseHeight: 224, jumpHeight: 31, torsoLean: 11.5, releaseTime: 1.31, followHold: 0.84, kneeFlex: 96 } },
    { id: 2, tRel: 0.193, made: false, raw: { heightCm: 182, releaseAngle: 44.8, elbowAngle: 151, releaseHeight: 228, jumpHeight: 33, torsoLean: 10.2, releaseTime: 1.26, followHold: 0.89, kneeFlex: 99 } },
    { id: 3, tRel: 0.312, made: true,  raw: { heightCm: 182, releaseAngle: 46.3, elbowAngle: 155, releaseHeight: 233, jumpHeight: 35, torsoLean: 9.1,  releaseTime: 1.19, followHold: 0.94, kneeFlex: 102 } },
    { id: 4, tRel: 0.431, made: false, raw: { heightCm: 182, releaseAngle: 45.1, elbowAngle: 154, releaseHeight: 231, jumpHeight: 34, torsoLean: 9.6,  releaseTime: 1.22, followHold: 0.91, kneeFlex: 101 } },
    { id: 5, tRel: 0.550, made: true,  raw: { heightCm: 182, releaseAngle: 47.9, elbowAngle: 160, releaseHeight: 238, jumpHeight: 38, torsoLean: 7.4,  releaseTime: 1.12, followHold: 1.01, kneeFlex: 108 } },
    { id: 6, tRel: 0.669, made: true,  raw: { heightCm: 182, releaseAngle: 49.2, elbowAngle: 163, releaseHeight: 241, jumpHeight: 39, torsoLean: 6.6,  releaseTime: 1.07, followHold: 1.06, kneeFlex: 111 } },
    { id: 7, tRel: 0.788, made: true,  raw: { heightCm: 182, releaseAngle: 50.4, elbowAngle: 166, releaseHeight: 244, jumpHeight: 41, torsoLean: 6.1,  releaseTime: 1.02, followHold: 1.09, kneeFlex: 113 } },
    { id: 8, tRel: 0.907, made: false, raw: { heightCm: 182, releaseAngle: 51.1, elbowAngle: 167, releaseHeight: 245, jumpHeight: 40, torsoLean: 5.8,  releaseTime: 1.0,  followHold: 1.10, kneeFlex: 114 } }
  ];

  /* ---------- 4. 建议文案库（杜星延：匹配逻辑取这里的内容） ---------- */
  /* tone: good / warn / bad 三档，按 gap 大小切换措辞强度 */
  var ADVICE = {
    releaseAngle: {
      title: '出手弧度偏低',
      fix: '把瞄准点从篮筐前沿改成“篮筐后沿上方”，出手瞬间想的是把球“放进”筐里，而不是“射向”筐。',
      drill: '篮下 1 米单手托球上举，连续 20 次高弧线出手；再退到罚球线做 3 组 × 10 次。',
      cue: '出手时手腕高于眼睛'
    },
    elbowAlign: {
      title: '肘部夹角不足，力量传导有断点',
      fix: '出手前让肘尖低于篮球、位于球的正下方，出手后肘部完全伸直并指向篮筐。',
      drill: '对墙做“肘贴耳”投篮模仿 3 组 × 15 次；1kg 加重球低位单臂推举 3 组 × 12 次。',
      cue: '肘在球下、肘指向筐'
    },
    releaseHeight: {
      title: '出手点偏低',
      fix: '如果你不是刻意用低出手点换快速释放，可以试在起跳最高点前出手、把球举到额头以上。' +
           '库里是有意压低的，但他出手速度极快——这个组合需要足够的下肢爆发和手感支撑。',
      drill: '篮下高出手擦板 3 组 × 15 次；弹力带辅助纵跳 + 高出手 3 组 × 10 次。',
      cue: '最高点出手，不是落地时出手'
    },
    jump: {
      title: '腿部参与偏少，射程受限',
      fix: '罚球线以内用颠投是合理选择，不必硬改。但三分线外光靠手臂会吃力，' +
           '试试把下蹲做深一点，让力量从地面带上来。',
      drill: '连续纵跳 3 组 × 8 次；深蹲跳 3 组 × 6 次（负重约 20% 体重）。',
      cue: '近距离可颠投，远投要带上腿'
    },
    balance: {
      title: '躯干前倾过大，重心不稳',
      fix: '核心收紧，出手全程身体像电梯一样“垂直上升”，不要向前扑。',
      drill: '背贴墙投篮模仿（背部不离开墙）3 组 × 12 次；死虫式核心训练 3 组 × 15 次。',
      cue: '起跳垂直，落地原位'
    },
    tempo: {
      title: '出手节奏偏慢',
      fix: '建立“接球即蓄力”的节奏，减少持球停顿，把出手前置到接球动作里。',
      drill: '五点计时投篮：5 点各 5 球，要求 60 秒内完成；节拍器 100bpm 跟拍出手。',
      cue: '接球就蓄力，不额外停顿'
    },
    followThrough: {
      title: '随球动作不完整',
      fix: '出手后保持“手在篮筐里”的定格 1 秒，食指和中指最后离球。',
      drill: '每次投篮后保持随球姿势直到球碰筐；对墙做手腕下压 3 组 × 20 次。',
      cue: '定格 1 秒，手腕下压'
    },
    legDrive: {
      title: '下肢发力不连贯',
      fix: '屈膝到 105°—125° 即可，髋膝踝一条线向上发力，不要蹲到 90° 以下。',
      drill: '半蹲起跳 3 组 × 10 次；药球下砸 3 组 × 8 次。',
      cue: '髋膝踝一条线'
    }
  };

  BB.data = {
    DIMS: DIMS,
    CARD_KEYS: CARD_KEYS,
    HOOP_H: HOOP_H,          // 篮筐高 3.05m
    RAW_DIST: RAW_DIST,      // 默认投篮水平距离 4.6m（罚球线）
    SRC_NOTE: '出手角按 Brancazio 最优角公式随出手点自动调整；身高类指标按「÷身高」比较；' +
              '球星数据为公开身高与教学资料换算的估算值，非官方测量',
    STARS: STARS,
    STAR_ORDER: ['curry', 'klay', 'durant', 'allen', 'kobe'],
    shots: SHOTS.slice(),
    ADVICE: ADVICE,
    demoSpan: 8.4,          // 演示模式总时长（秒）
    cycle: 1.0,             // 单次出手动画周期（秒）
    fps: 30,
    activeStar: 'curry'
  };
})(window.BB);
