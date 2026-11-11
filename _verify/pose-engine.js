/* 测试替身：把 pose-engine 的依赖换成可控的桩。
   只在 _verify 目录里用，不进仓库。 */

let nowT = 0;

export function onEngineProgress() {}
export function engineIsReady() { return true; }

export function acquireTimeBlock(count, gapMs = 40) {
  return 0;
}

export function loadDetector() {
  return Promise.resolve({
    detectForVideo(video /*, ts */) {
      return { landmarks: [video.__landmarksAt(video.currentTime)] };
    }
  });
}

export function seekTo(video, t) {
  nowT = t;
  video.currentTime = t;
  return Promise.resolve();
}

export function preload() { return Promise.resolve(true); }
export function isReady() { return true; }

export function _now() { return nowT; }
