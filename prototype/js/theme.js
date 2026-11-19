/* ============================================================
 * 图形层主题常量
 * 与 css/style.css 的 v2 设计令牌一一对应，禁止在画布代码里另写色值。
 * ============================================================ */
(function () {
  var T = {
    brand: '#2563EB',
    brand2: '#1D4ED8',
    brand3: '#3B82F6',
    brandInk: '#1E40AF',
    brandSoft: '#EAF1FF',
    brandLine: '#BFD3FE',
    lime: '#C6F24E',
    limeSoft: '#F2FCD9',
    limeInk: '#3F6212',
    cyan: '#22D3EE',
    cyanInk: '#0E7490',
    green: '#16A34A',
    greenInk: '#15803D',
    amber: '#F59E0B',
    amberInk: '#B45309',
    red: '#E11D48',
    redInk: '#BE123C',
    dark: '#0B1220',
    dark2: '#111A2B',
    slate: '#94A3B8',
    text: '#0B1220',
    text2: '#475467',
    text3: '#64748B',
    line: '#E2E8F0',
    lineStrong: '#CBD5E1',
    lineSoft: '#EEF2F7',
    white: '#FFFFFF'
  };

  /* 画布需要 rgba 时统一走这里，避免散落的 rgb 三元组 */
  T.rgba = function (hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
  };

  window.BB = window.BB || {};
  window.BB.THEME = T;
})();
