/* ============================================================
 * knowledge.js  —  库里大师课原话知识库
 * 来源：B 站 BV1Xw411Z7p6 P2《投篮：姿势、瞄准、方式》
 *       （cid 353132179，全片 864s）
 * 说明：这里只放库里本人说过的原话（中英对照 + 时间戳），
 *       供建议模块引用，让每条建议都有出处、可回看。
 *       原文通过抽 48 帧硬字幕人工校对得到，时间点误差 ±2s。
 *
 * 为什么不 fetch 那个 JSON：file:// 协议下 fetch 本地 JSON
 * 会被 CORS 拦掉，双击打开就白屏。内嵌成 JS 才离线可用。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var META = {
    title: '库里大师课 · 投篮：姿势、瞄准、方式',
    bvid: 'BV1Xw411Z7p6',
    cid: 353132179,
    part: 2,
    duration: 864,
    video: 'media/curry_p2.mp4',   // P2 整集，供弹层内跳转播放
    credit: 'B 站 @内森の日常 中英字幕版'
  };

  /* 库里在 P2 里讲的四个章节 */
  var CHAPTERS = [
    { id: 'feet',    title: '从脚开始投篮', t: 144, end: 460 },
    { id: 'hands',   title: '手的姿势',     t: 460, end: 575 },
    { id: 'aim',     title: '瞄准点',       t: 575, end: 660 },
    { id: 'release', title: '出手点',       t: 660, end: 864 }
  ];

  /*
   * 把库里的原话按「本系统的 8 个维度」归类。
   * 每个维度取 1~2 条最贴切的，quote 用于卡片引用，t 用于跳转视频。
   * 注意 tempo（出手节奏）在 P2 里没有对应讲解——这一点如实标注，
   * 库里是在 P4《接球投篮》才讲节奏的。
   */
  var BY_DIM = {
    releaseAngle: [
      { t: 720, zh: '这才能让你有恰当的弧度。', en: "That's going to give you proper arc", chapter: 'release',
        note: '弧线不是刻意抛高，是出手点与手臂伸展的结果' },
      { t: 630, zh: '只要轻轻一触，有一点弧线。', en: 'over the front of the rim with a little bit of touch,', chapter: 'aim',
        note: '瞄前沿 + 轻触，弧线自然够' },
      { t: 828, zh: '如果大于这个弧度（出手角过高）。', en: 'Anything higher than that, you start', chapter: 'release',
        note: '库里也承认弧度过高会出问题，不是越高越好' }
    ],
    elbowAlign: [
      { t: 558, zh: '把食指放在气孔上，用这个姿势盯着篮筐。', en: 'just staring at the rim doing form shooting with your finger', chapter: 'hands',
        note: '食指对筐 → 肘部自然内收，这是最省事的对位方法' },
      { t: 738, zh: '从臀部到出手位置要呈完美的线条。', en: 'We want to have kind of a perfect line from my hip', chapter: 'release',
        note: '髋—肩—肘—腕一条竖线，是全部对位判据的总纲' }
    ],
    releaseHeight: [
      { t: 666, zh: '出手点是投篮中非常重要的一部分。', en: 'Your release point is a very important part of your shot', chapter: 'release',
        note: '库里把出手点单独拎出来讲，是这一章的核心' },
      { t: 720, zh: '这才能让你有恰当的弧度。', en: "That's going to give you proper arc", chapter: 'release',
        note: '出手点高度和弧线是同一件事的两面' }
    ],
    jump: [
      { t: 162, zh: '因为一切都要从脚下开始。', en: 'because it all starts from the ground up.', chapter: 'feet',
        note: '发力链起点，脚不稳则上肢代偿' },
      { t: 270, zh: '蓄力到我们的臀部、下背部。', en: 'Loading our hips, our backside, and getting', chapter: 'feet',
        note: '下蹲蓄力来自髋，不是膝盖前顶' }
    ],
    balance: [
      { t: 180, zh: '你应该让你的 10 个脚趾全都对着篮筐。', en: 'you should have your 10 toes facing squared up to the rim.', chapter: 'feet',
        note: '10 趾同向 = 身体正对篮筐，决定了肩髋能否水平' },
      { t: 288, zh: '膝盖不要超过脚趾。', en: "And we don't want to have our knees in front of our toes.", chapter: 'feet',
        note: '膝超脚尖 → 重心前倾，躯干必然不稳' },
      { t: 738, zh: '从臀部到出手位置要呈完美的线条。', en: 'We want to have kind of a perfect line from my hip', chapter: 'release',
        note: '躯干要像电梯一样垂直上升' }
    ],
    tempo: [
      { t: 666, zh: '出手点是投篮中非常重要的一部分。', en: 'Your release point is a very important part of your shot', chapter: 'release',
        note: '本集没有专门讲出手节奏（那是 P4《接球投篮》的内容），这条只是相关' }
    ],
    followThrough: [
      { t: 756, zh: '伸出去一点点。', en: "It's just a little bit out.", chapter: 'release',
        note: '跟随动作不用夸张，自然延伸即可' },
      { t: 810, zh: '会让球有从左到右的侧旋。', en: 'the left to right action in side spin.', chapter: 'release',
        note: '跟随动作不对称 → 侧旋 → 球会左右飘' },
      { t: 486, zh: '让球正确地旋转。', en: 'to get proper spin on the ball, and also', chapter: 'hands',
        note: '后旋来自手指拨球，不是手掌推球' }
    ],
    legDrive: [
      { t: 414, zh: '如果你的膝盖向外，你就会损失力量。', en: "If you bend your knees outward, you'll sacrifice power.", chapter: 'feet',
        note: '膝外翻 = 力量泄漏' },
      { t: 342, zh: '所以找到足弓是关键，稳定足弓。', en: 'So finding that arch is key, planting it into the ground,', chapter: 'feet',
        note: '足弓塌陷会让整个发力链向内偏移' },
      { t: 288, zh: '膝盖不要超过脚趾。', en: "And we don't want to have our knees in front of our toes.", chapter: 'feet',
        note: '膝不超脚尖，才能保住后链发力' }
    ]
  };

  /* 按维度取最贴切的一条 */
  function quoteFor(dimKey) {
    var list = BY_DIM[dimKey];
    return list && list.length ? list[0] : null;
  }

  function allFor(dimKey) {
    return BY_DIM[dimKey] || [];
  }

  /* 秒 → mm:ss */
  function timecode(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function chapterOf(t) {
    for (var i = 0; i < CHAPTERS.length; i++) {
      if (t >= CHAPTERS[i].t && t < CHAPTERS[i].end) return CHAPTERS[i];
    }
    return CHAPTERS[0];
  }

  BB.Knowledge = {
    META: META,
    CHAPTERS: CHAPTERS,
    BY_DIM: BY_DIM,
    quoteFor: quoteFor,
    allFor: allFor,
    timecode: timecode,
    chapterOf: chapterOf
  };
})(window.BB);
