'use strict';
// 一次性诊断：当前桌面 z 序快照 + 探针点位命中情况（不开任何窗口）
const { Report } = require('../lib/report');
const H = require('../lib/harness');

module.exports = async function diagZ() {
  const rep = new Report('diag_z');
  const w32 = H.win32;
  const f = H.screenInfo().factor;

  const GA_ROOT = 2, GA_ROOTOWNER = 3;
  const GetAncestor = w32.user32?.GetAncestor;
  void GetAncestor;

  const tops = w32.topLevelWindows();
  rep.note(`可见顶层窗口数: ${tops.length}（自顶向下）`);
  tops.slice(0, 12).forEach((h, i) => {
    const ex = w32.GetWindowLongW(h, w32.GWL_EXSTYLE);
    rep.log(`#${i} hwnd=0x${h.toString(16)} class=${w32.className(h)} TOPMOST=${!!(ex & w32.WS_EX_TOPMOST)}`);
  });

  const pts = {
    pOnly_200_520: { x: 200, y: 520 },
    nOnly_1360_760: { x: 1360, y: 760 },
    input_530_620: { x: 530, y: 620 },
    桌面点_1120_600: { x: 560 * f, y: 300 * f },
  };
  for (const [name, pt] of Object.entries(pts)) {
    const h = w32.WindowFromPoint(pt);
    rep.log(`${name} → 0x${h.toString(16)} class=${w32.className(h)}`);
  }
  return rep.verdict('DONE');
};
