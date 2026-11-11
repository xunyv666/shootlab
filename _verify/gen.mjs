/* ============================================================
 * 立定跳远引擎的合成场景校验
 *
 * 思路：自己造一个「已知真值」的侧面视角人体骨架序列 ——
 * 身高、起跳时刻、水平/垂直初速度、腾空时间都是我先写死的，
 * 再让引擎从这些关键点里反算距离与起跳角，和真值对表。
 *
 * 覆盖两种动作：
 *   clean  —— 标准跳：髋膝踝按顺序展开、摆臂到位、落地站住；
 *   fallback —— 落地后重心后移 + 手撑地，用来验证稳定性扣分。
 * ============================================================ */

import { copyFileSync } from 'node:fs';

/* 这里必须跑的是「prototype 里那一份」引擎，不能是抄过来的副本 ——
   手工复制会忘，忘了就会拿旧代码测新代码。
   先把引擎拷到本目录（好让它 import 到同目录的 pose-engine 桩），
   再用动态 import 加载，保证每次跑的都是最新版。 */
copyFileSync(
  new URL('../prototype/js/longjump-engine.js', import.meta.url),
  new URL('./longjump-engine.js', import.meta.url)
);
const { analyze, applyScale, scaleOf, extVerdict } = await import('./longjump-engine.js');

/* ---------------- 场景参数 ---------------- */
const H = 1.78;            // 身高 m
const VW = 1280, VH = 720;
const GROUND = 700;        // 地面在画面里的像素 y
const PX_PER_M = 518 / H;  // 站立时人占 518px 高
const ORIGIN_X = 260;

const G = 9.81;
const T_STAND_END = 1.0;
const T_CROUCH_BOTTOM = 1.75;
const T0 = 2.0;            // 起跳
const VX = 4.0;            // m/s
const VY = 2.6;            // m/s
const T1 = T0 + 2 * VY / G;         // 落地 = 2.5301
const T_LAND_CROUCH = T1 + 0.38;
const DUR = 4.2;

const HIP_STAND = 0.943;   // 站立髋高
const HIP_CROUCH = 0.643;  // 下蹲髋高
const ANKLE_H = 0.142;     // 站立踝高

function smoothstep(u) {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
}

/* ---------------- 轨迹 ---------------- */
function hipY(t, fallback) {
  if (t < T_STAND_END) return HIP_STAND;
  if (t < T_CROUCH_BOTTOM) {
    const u = (t - T_STAND_END) / (T_CROUCH_BOTTOM - T_STAND_END);
    return HIP_STAND - (HIP_STAND - HIP_CROUCH) * smoothstep(u);
  }
  if (t < T0) {
    const u = (t - T_CROUCH_BOTTOM) / (T0 - T_CROUCH_BOTTOM);
    /* 蹬伸是加速的：用 u^1.6 让前段慢、后段快 */
    return HIP_CROUCH + (HIP_STAND - HIP_CROUCH) * Math.pow(u, 1.6);
  }
  if (t < T1) {
    const dt = t - T0;
    return HIP_STAND + VY * dt - 0.5 * G * dt * dt;
  }
  if (t < T_LAND_CROUCH) {
    const u = (t - T1) / (T_LAND_CROUCH - T1);
    return HIP_STAND - 0.22 * Math.sin(Math.PI * u);
  }
  /* 站住的正常跳：髋部回到站立高度略低一点；
     失败跳：整个人往后坐下去，髋部压到 0.35m —— 这才有「手撑地」的空间 */
  if (!fallback) return HIP_STAND - 0.03;
  const u = Math.min(1, (t - T_LAND_CROUCH) / 0.45);
  return HIP_STAND - 0.22 - (HIP_STAND - 0.22 - 0.35) * smoothstep(u);
}

function hipX(t, fallback) {
  if (t < T0) return 0;
  if (t < T1) return VX * (t - T0);
  /* 落地后重心还会往前带一点然后停住；
     fallback 场景额外加一段向后的回撤，用来验证「后退」检测 */
  const dt = t - T1;
  const fwd = 0.10 * (1 - Math.exp(-dt / 0.16));
  const back = fallback ? 0.42 * smoothstep((dt - 0.18) / 0.5) : 0;
  return VX * (T1 - T0) + fwd - back;
}

function legLen(t, fallback) {
  if (t < T0) return Math.max(0.15, hipY(t, fallback) - ANKLE_H);
  if (t < T1) {
    const u = (t - T0) / (T1 - T0);
    /* 腾空中收腿：起跳瞬间伸到最长，中段收起来，落地前再伸出去 */
    return (HIP_STAND - ANKLE_H) - 0.28 * Math.sin(Math.PI * u);
  }
  return Math.max(0.15, hipY(t, fallback) - ANKLE_H);
}

function lean(t) {
  if (t < T0) return 0;
  if (t < T1) {
    const u = (t - T0) / (T1 - T0);
    return 0.25 * u * u;               // 落地前小腿前伸
  }
  const dt = t - T1;
  return 0.25 * Math.max(-0.4, 1 - dt / 0.5);
}

/* 足部朝向：脚掌贴地时脚尖在脚踝前下方；腾空末段勾脚（脚尖抬到脚踝之上），
   落地时脚跟才是最低点 —— 这正是「起跳看脚尖、落地看脚跟」的物理来源。 */
function toePos(ankle, t) {
  let dx = 0.14, dy = -0.11;
  if (t >= T0 && t < T1) {
    const u = (t - T0) / (T1 - T0);
    const k = smoothstep((u - 0.35) / 0.65);
    dy = -0.11 + 0.16 * k;
    dx = 0.14 - 0.04 * k;
  }
  return [ankle[0] + dx, ankle[1] + dy];
}

function armAngle(t, fallback) {
  if (t < T_STAND_END) return 4;
  if (t < T_CROUCH_BOTTOM) return 4 - 44 * smoothstep((t - T_STAND_END) / (T_CROUCH_BOTTOM - T_STAND_END));
  if (t < T0) return -40 + 105 * Math.pow((t - T_CROUCH_BOTTOM) / (T0 - T_CROUCH_BOTTOM), 1.4);
  if (t < T0 + 0.12) return 65 + 45 * ((t - T0) / 0.12);
  if (t < T1) return 110 - 70 * ((t - T0 - 0.12) / (T1 - T0 - 0.12));
  /* 正常落地：手臂在体前稳住；失败落地：手往下放去撑地 */
  if (!fallback) return 40;
  const u = Math.min(1, (t - T1) / 0.5);
  return 40 - 40 * smoothstep(u);
}

/* 两连杆逆解：给定髋、踝，求膝盖位置（取膝向前的解） */
function kneeOf(hip, ankle, thigh, shin) {
  const dx = ankle[0] - hip[0], dy = ankle[1] - hip[1];
  const d = Math.max(1e-6, Math.hypot(dx, dy));
  const dd = Math.min(d, thigh + shin - 1e-6);
  const a = (thigh * thigh - shin * shin + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, thigh * thigh - a * a));
  const ux = dx / d, uy = dy / d;
  let px = -uy, py = ux;
  if (px < 0) { px = -px; py = -py; }      // 膝盖朝画面右侧（跳跃方向）
  return [hip[0] + a * ux + h * px, hip[1] + a * uy + h * py];
}

function toNorm(xm, ym) {
  return [(xm * PX_PER_M + ORIGIN_X) / VW, (GROUND - ym * PX_PER_M) / VH];
}

/* 镜像开关：把画面左右翻转，人往左边跳。
   方向判断（起跳角、后移、脚尖/脚跟谁在前后）最容易写反，
   单独跑一遍向左跳才能确认没有隐含「向右为正」的假设。 */
let MIRROR = false;

function lm(xm, ym, vis) {
  const p = toNorm(xm, ym);
  return { x: MIRROR ? 1 - p[0] : p[0], y: p[1], z: 0, visibility: vis == null ? 0.95 : vis };
}

/* ---------------- 生成一帧 33 点 ---------------- */
function landmarksAt(t, fallback) {
  const hy = hipY(t, fallback), hx = hipX(t, fallback);
  const ll = legLen(t, fallback), ln = lean(t);
  const torso = hy < HIP_STAND - 0.05 ? 0.47 : 0.50;

  const hip = [hx, hy];
  const ankle = [hx + ln, hy - ll];
  const knee = kneeOf(hip, ankle, 0.42, 0.42);
  const toe = toePos(ankle, t);
  const shoulder = [hx - 0.02, hy + torso];
  const nose = [shoulder[0] + 0.03, shoulder[1] + 0.28];

  const a = armAngle(t, fallback) * Math.PI / 180;
  const armLen = 0.62;
  const wrist = [shoulder[0] + armLen * Math.sin(a), shoulder[1] - armLen * Math.cos(a)];
  const elbow = [
    shoulder[0] + 0.31 * Math.sin(a) + 0.02,
    shoulder[1] - 0.31 * Math.cos(a)
  ];

  const out = new Array(33);
  const put = (i, p, vis) => { out[i] = lm(p[0], p[1], vis); };

  put(0, nose);
  put(1, [nose[0] + 0.03, nose[1] - 0.03]);   // 左眼
  put(2, [nose[0] + 0.01, nose[1] - 0.03]);   // 右眼
  put(3, [nose[0] + 0.06, nose[1] - 0.01]);   // 左耳
  put(4, [nose[0] - 0.02, nose[1] - 0.01]);   // 右耳
  put(5, [shoulder[0] + 0.06, shoulder[1] - 0.02]);  // 左肩（远侧）
  put(6, [shoulder[0] - 0.06, shoulder[1] - 0.02]);
  put(7, [elbow[0] + 0.05, elbow[1]]);
  put(8, [elbow[0] - 0.05, elbow[1]]);
  put(9, [wrist[0] + 0.05, wrist[1]]);
  put(10, [wrist[0] - 0.05, wrist[1]]);

  /* 左右两侧在侧视图里几乎重合，只差几厘米，用来验证「取平均」不会出错 */
  put(11, [shoulder[0] + 0.03, shoulder[1]]);
  put(12, [shoulder[0] - 0.03, shoulder[1]]);
  put(13, [elbow[0] + 0.03, elbow[1]]);
  put(14, [elbow[0] - 0.03, elbow[1]]);
  put(15, [wrist[0] + 0.03, wrist[1]]);
  put(16, [wrist[0] - 0.03, wrist[1]]);
  put(17, [wrist[0] + 0.03, wrist[1]]);   // 小指
  put(18, [wrist[0] - 0.03, wrist[1]]);
  put(19, [wrist[0] + 0.05, wrist[1] - 0.01]);
  put(20, [wrist[0] - 0.05, wrist[1] - 0.01]);
  put(21, [wrist[0] + 0.01, wrist[1]]);
  put(22, [wrist[0] - 0.01, wrist[1]]);

  put(23, [hip[0] + 0.03, hip[1]]);
  put(24, [hip[0] - 0.03, hip[1]]);
  put(25, [knee[0] + 0.03, knee[1]]);
  put(26, [knee[0] - 0.03, knee[1]]);
  put(27, [ankle[0] + 0.03, ankle[1]]);
  put(28, [ankle[0] - 0.03, ankle[1]]);
  put(29, [ankle[0] + 0.03, ankle[1] + 0.02]);   // 脚跟
  put(30, [ankle[0] - 0.03, ankle[1] + 0.02]);
  put(31, [toe[0] + 0.02, toe[1]]);
  put(32, [toe[0] - 0.02, toe[1]]);

  return out;
}

/* ---------------- 假 video ---------------- */
function makeVideo(fallback) {
  const v = {
    duration: DUR,
    videoWidth: VW,
    videoHeight: VH,
    currentTime: 0,
    src: 'synthetic://longjump',
    currentSrc: 'synthetic://longjump',
    __landmarksAt(t) { return landmarksAt(t, fallback); }
  };
  return v;
}

/* ---------------- DOM 桩 ---------------- */
globalThis.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext() { return { drawImage() {} }; }
    };
  }
};

/* ---------------- 真值（独立于引擎，自己按几何算） ---------------- */
function truth(fallback) {
  /* 起跳点 = 起跳帧脚尖 x；落地点 = 落地帧脚跟 x */
  const toeX = (t) => {
    const hy = hipY(t, fallback), hx = hipX(t, fallback), ll = legLen(t, fallback), ln = lean(t);
    const ankle = [hx + ln, hy - ll];
    return toePos(ankle, t)[0];
  };
  const heelX = (t) => {
    const hy = hipY(t, fallback), hx = hipX(t, fallback), ll = legLen(t, fallback), ln = lean(t);
    return hx + ln;
  };
  return {
    distM: heelX(T1) - toeX(T0),
    angleDeg: Math.atan2(VY, VX) * 180 / Math.PI,
    flightS: T1 - T0,
    flightPeakM: VY * VY / (2 * G)
  };
}

/* ---------------- 跑 ---------------- */
const CASES = [
  { name: 'clean（标准跳）', fallback: false },
  { name: 'fallback（落地后移+手撑地）', fallback: true },
  { name: 'mirror（画面翻转，向左跳）', fallback: false, mirror: true }
];

let failed = 0;
function check(label, got, want, tol, unit) {
  const ok = got != null && Math.abs(got - want) <= tol;
  if (!ok) failed++;
  const g = got == null ? 'null' : (Math.round(got * 100) / 100);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: 实测 ${g}${unit} / 真值 ${Math.round(want * 100) / 100}${unit} (容差 ±${tol})`);
  return ok;
}

for (const c of CASES) {
  console.log('\n=== ' + c.name + ' ===');
  MIRROR = !!c.mirror;
  const v = makeVideo(c.fallback);
  const res = await analyze(v, { heightCm: H * 100, subject: 'synthetic' });
  const tr = truth(c.fallback);

  console.log(`  识别 ${res.detected}/${res.total} 帧 · 检出 ${res.jumps.length} 次腾空 · 比例尺 ${res.meta.scaleMethod}`);
  if (!res.jumps.length) { console.log('  FAIL  没有检出腾空段'); failed++; continue; }

  const j = res.jumps[res.primary];
  console.log(`  主跳: 起跳 ${j.t0}s → 落地 ${j.t1}s`);

  check('跳跃距离', j.distCm / 100, tr.distM, tr.distM * 0.045, 'm');
  check('起跳角', j.takeoffAngle, tr.angleDeg, 2.5, '°');
  check('腾空时间', j.dur, tr.flightS, 0.035, 's');
  check('腾空最高点', j.flightHCm / 100, tr.flightPeakM, 0.06, 'm');
  check('等效重力自检', j.impliedG, 981, 120, 'cm/s²');

  console.log(`  蹬伸顺序: ${j.extOrder}（间隔 ${j.extSpread}ms${j.extTie ? ' · 判为几乎同时' : ''}）` +
    ` · 摆臂峰值 ${j.armLag}ms · 最低膝角 ${j.minKnee}° · 后移 ${j.backCm}cm · 手撑地 ${j.handTouch}`);

  /* 合成动作的三段伸展是同时发生的（髋、踝位置由同一个 2 连杆模型解出来），
     所以这里真正要验的是「引擎有没有编造顺序」：
     间隔 < 20ms 时必须老实报 extTie，且不能同时标记 extOk。 */
  if (!c.fallback) {
    if (j.extTie) {
      if (!j.extOk) console.log(`  PASS  三段峰值间隔 ${j.extSpread}ms < 20ms → 不报顺序（extTie）`);
      else { console.log('  FAIL  extTie 与 extOk 同时为真，自相矛盾'); failed++; }
    } else if (j.extOk) {
      console.log('  PASS  蹬伸顺序 髋→膝→踝');
    } else {
      console.log('  FAIL  顺序应为 髋→膝→踝，实际 ' + j.extOrder); failed++;
    }
    if (Math.abs(j.armLag) <= 250) console.log(`  PASS  摆臂峰值在起跳附近 (${j.armLag}ms)`);
    else { console.log(`  FAIL  摆臂峰值偏离起跳 ${j.armLag}ms`); failed++; }
    if (!j.handTouch) console.log('  PASS  未误判手撑地');
    else { console.log('  FAIL  误判手撑地'); failed++; }
    /* 落地后还在往前带，不该被判成「后退」 */
    if (j.backCm == null || j.backCm < 3) console.log(`  PASS  未误判后退 (${j.backCm}cm)`);
    else { console.log(`  FAIL  误判后退 ${j.backCm}cm`); failed++; }
    /* 向左跳时 dir 必须是 -1，否则距离会算成负的 */
    if (!c.mirror || j.dir === -1) console.log(`  PASS  跳跃方向 dir=${j.dir}`);
    else { console.log(`  FAIL  向左跳的 dir 应为 -1，实际 ${j.dir}`); failed++; }
  } else {
    if (j.backCm > 3) console.log(`  PASS  检出落地后移 ${j.backCm}cm`);
    else { console.log(`  FAIL  应检出后移，实际 ${j.backCm}cm`); failed++; }
    if (j.handTouch) console.log('  PASS  检出手撑地');
    else { console.log('  FAIL  应检出手撑地'); failed++; }
  }
}

/* 把 clean 场景的完整结果导出一份，供界面排版自检使用 */
{
  const v2 = makeVideo(false);
  MIRROR = false;
  const r = await analyze(v2, { heightCm: H * 100, subject: 'synthetic' });
  const fs = await import('node:fs');
  fs.writeFileSync(new URL('./res-clean.json', import.meta.url), JSON.stringify(r));
  console.log('\n已导出 res-clean.json（' + Math.round(JSON.stringify(r).length / 1024) + ' KB）');
}

/* 比例尺换算的独立性：手动标尺应当覆盖身高法 */
console.log('\n=== 标尺校准 ===');
{
  const meta = {
    videoW: VW, videoH: VH, spanStand: 0.64, heightCm: 178,
    ruler: { p0: [0.2, 0.9], p1: [0.2 + (1 * PX_PER_M) / VW, 0.9], lenCm: 100 }
  };
  const sc = scaleOf(meta);
  const pxPerCm = PX_PER_M / 100;
  const ok = Math.abs(sc.cmPerPx - 1 / pxPerCm) < 0.01 && sc.method === 'ruler';
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  100cm 标尺 → cmPerPx ${sc.cmPerPx.toFixed(4)}（应 ${(1 / pxPerCm).toFixed(4)}）· 方法 ${sc.method}`);
}

/* 蹬伸顺序判定：三条分支 + 评分映射。
   合成动作里三段是同时伸展的，测不到「顺序正确 / 顺序反了」这两条，
   所以用构造的 ext 数组直接把分支打一遍。 */
console.log('\n=== 蹬伸顺序判定分支 ===');
{
  const E = [{ name: '髋', tRel: -40 }, { name: '膝', tRel: 40 }, { name: '踝', tRel: 120 }];
  const probes = [
    ['顺序正确 髋→膝→踝', { ext: E, extOk: true, extTie: false, extSpread: 160 }, 'ok'],
    ['顺序反了', { ext: E, extOk: false, extTie: false, extSpread: 160 }, 'reversed'],
    ['采样精度内同时', { ext: E, extOk: false, extTie: true, extSpread: 8 }, 'tie'],
    ['关节不全', { ext: E.slice(0, 2), extOk: false, extTie: false }, null]
  ];
  probes.forEach(([label, j, want]) => {
    const got = extVerdict(j);
    if (got === want) console.log(`  PASS  ${label} → ${got}`);
    else { console.log(`  FAIL  ${label} → ${got}（应 ${want}）`); failed++; }
  });

  /* 评分映射：tie 必须给中性分，不能按「顺序错」扣到 55 */
  const res = {
    meta: { heightCm: 178, spanStand: 0.64, videoW: VW, videoH: VH },
    jumps: probes.slice(0, 3).map(p => Object.assign({ distN: null, dur: 0.55 }, p[1]))
  };
  applyScale(res);
  const got = res.jumps.map(j => j.scores.ext);
  const want = [100, 55, 70];
  if (got.join() === want.join()) console.log(`  PASS  评分映射 ${got.join(' / ')}（顺序对 / 反 / 同时）`);
  else { console.log(`  FAIL  评分映射 ${got.join(' / ')}（应 ${want.join(' / ')}）`); failed++; }
}

console.log('\n' + (failed ? `❌ ${failed} 项未通过` : '✅ 全部通过'));
process.exit(failed ? 1 : 0);
