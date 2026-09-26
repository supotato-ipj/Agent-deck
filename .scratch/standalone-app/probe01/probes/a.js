'use strict';
// 探针A：WebView2/Chromium 透明合成 —— 透明窗口悬浮于壁纸之上、壁纸可见。
// 方法：以不透明棋盘格参照窗垫底（免受动态壁纸动画干扰做像素级判定），
//       再叠透明面板窗（moveTop 保证面板在参照窗之上）；透明区应透出棋盘格，
//       卡片区应为实色绘制。随后关掉参照窗实拍面板叠真壁纸的观感图；
//       最后实测窗口级整体 alpha 降级路径。
// 几何避开屏幕右侧（用户工作窗常驻区），全部压在左半屏。
const { Report } = require('../lib/report');
const H = require('../lib/harness');

module.exports = async function probeA() {
  const rep = new Report('a_transparency');
  const w32 = H.win32;
  const si = H.screenInfo();
  rep.note(`screen: phys ${si.phys.w}x${si.phys.h} @ factor ${si.factor}`);
  await H.clearDesktop(); // 最小化用户窗口，探针全程在裸桌面上跑，结束自动还原
  await H.sleep(300);

  // 布局（DIP）：面板 (80,240,520,420)，参照窗四周外扩 10
  const PX = 80, PY = 240, PW = 520, PH = 420;
  const f = si.factor;

  const panelEvents = [];
  const panel = await H.createWindow({
    file: 'a.html', domChannel: 'a:dom', events: panelEvents,
    x: PX, y: PY, width: PW, height: PH,
    transparent: true, frame: false, title: 'PROBE-A',
  });
  const hwnd = H.hwndOf(panel);
  const rect = w32.rectOf(hwnd);
  rep.note(`panel hwnd=0x${hwnd.toString(16)} rect(phys)=${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}`);

  // 1) 真壁纸基线（面板隐藏时截面板矩形，供观感对照）
  const bareWallpaper = H.capture(rect, 'a-wallpaper-baseline');

  // 2) 棋盘格参照窗垫底（面板之下、壁纸之上）
  const backdrop = await H.createWindow({
    file: 'checker.html', domChannel: 'ck:dom', events: [],
    x: PX - 10, y: PY - 10, width: PW + 20, height: PH + 20,
    transparent: false, frame: false, title: 'PROBE-A-BACKDROP',
  });
  backdrop.showInactive();
  await H.sleep(400);
  panel.showInactive();
  panel.moveTop(); // 面板创建在先，必须抬回参照窗之上
  await H.sleep(1200);

  const shot = H.capture(rect, 'a-transparent-on-checker');

  // 判定区域（面板内相对物理坐标）
  const card = { left: 40 * f, top: 40 * f, right: 340 * f, bottom: 220 * f };
  const transparentZone = { left: card.right + 8, top: 8, right: (rect.right - rect.left) - 8, bottom: (rect.bottom - rect.top) - 8 };

  // 3) 透明区像素应命中棋盘两色之一（±30/通道）
  const chk = checkerHitRate(shot, transparentZone);
  rep.log(`透明区棋盘色命中率: ${(chk.rate * 100).toFixed(1)}% (样本 ${chk.n})`);
  const transparencyOk = chk.rate > 0.9;
  transparencyOk
    ? rep.pass('透明区透出参照窗棋盘格（Chromium 透明合成生效）')
    : rep.fail(`透明区未透出参照窗（命中率 ${(chk.rate * 100).toFixed(1)}%，疑似不透明/黑底）`);

  // 4) 卡片区实色 + 白色文字
  const wp = H.whitePixels(shot, card);
  wp.hit > 30
    ? rep.pass(`卡片区白色文字像素 ${wp.hit}/${wp.n}（文字实色清晰）`)
    : rep.fail(`卡片区白色文字像素不足 ${wp.hit}/${wp.n}`);

  // 5) 关参照窗，实拍面板叠真壁纸（开局已清场，此时面板背后就是壁纸+桌面图标）
  backdrop.destroy();
  await H.sleep(800);
  const onWall = H.capture(rect, 'a-on-wallpaper');
  const dWall = H.zoneDiff(bareWallpaper, onWall, transparentZone);
  rep.note(`透明区 vs 壁纸基线 mean=${dWall.mean.toFixed(2)} max=${dWall.max} >40占比=${dWall.over40Pct.toFixed(1)}%（仅记录）`);

  // 6) 降级路径实测：窗口级整体 alpha（ADR-0004 已接受的 no-go 备胎）
  panel.setOpacity(0.45);
  await H.sleep(600);
  const alphaShot = H.capture(rect, 'a-alpha-fallback-045');
  const wpA = H.whitePixels(alphaShot, card);
  rep.note(`窗口级 alpha=0.45：白字像素 ${wpA.hit}/${wpA.n} (${wpA.pct.toFixed(1)}%) vs 全透明合成 ${wp.pct.toFixed(1)}%（白字变虚的量化证据）`);
  panel.setOpacity(1);
  await H.sleep(200);
  panel.destroy();

  return rep.verdict(transparencyOk ? 'GO' : 'NO-GO');
};

// 棋盘两色 #2040c0 / #c04020 的命中率
function checkerHitRate(pngPath, zone) {  const { nativeImage } = require('electron');
  const img = nativeImage.createFromPath(pngPath);
  const s = img.getSize();
  const buf = img.toBitmap();
  const W = s.width;
  let hit = 0, n = 0;
  const tol = 30;
  const colors = [[192, 64, 32], [32, 64, 192]]; // R,G,B
  for (let y = Math.max(0, zone.top); y < Math.min(s.height, zone.bottom); y += 2) {
    for (let x = Math.max(0, zone.left); x < Math.min(W, zone.right); x += 2) {
      const i = (y * W + x) * 4;
      const r = buf[i + 2], g = buf[i + 1], b = buf[i];
      n++;
      for (const [cr, cg, cb] of colors) {
        if (Math.abs(r - cr) <= tol && Math.abs(g - cg) <= tol && Math.abs(b - cb) <= tol) { hit++; break; }
      }
    }
  }
  return { rate: hit / Math.max(1, n), n };
}
