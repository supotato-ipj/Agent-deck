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

  // 5) 降级路径实测（ADR-0004 备胎）：窗口级整体 alpha。
  //    同背景（棋盘参照仍在）先后截 opacity=1 / setOpacity(0.45) / 直调
  //    SetLayeredWindowAttributes(LWA_ALPHA, 115)，差分为零即该手段无视觉效果。
  //    注意：GDI CopyFromScreen 抓不到部分 alpha 分层窗时差分也会为零，
  //    故以「opaque 参照窗在同法截图中可见」锚定抓屏通路本身有效。
  const alphaProbe = async (label, apply, revert) => {
    apply();
    await H.sleep(700);
    const s = H.capture(rect, `a-alpha-${label}`);
    const d = H.zoneDiff(shot, s, transparentZone);
    const cardNow = H.whitePixels(s, card);
    rep.log(`alpha[${label}] 透明区差分 mean=${d.mean.toFixed(2)} max=${d.max}；卡区白字 ${cardNow.hit}/${cardNow.n}`);
    revert();
    await H.sleep(400);
    return d.mean;
  };
  const meanOpacity = await alphaProbe(
    'setopacity-045',
    () => panel.setOpacity(0.45),
    () => panel.setOpacity(1));
  const exAfter = (w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE) >>> 0).toString(16);
  rep.note(`setOpacity 后 EXSTYLE=0x${exAfter}（WS_EX_LAYERED=${!!(parseInt(exAfter, 16) & w32.WS_EX_LAYERED)}）`);
  const meanLwa = await alphaProbe(
    'lwa-alpha-115',
    () => w32.SetLayeredWindowAttributes(hwnd, 0, 115, w32.LWA_ALPHA),
    () => w32.SetLayeredWindowAttributes(hwnd, 0, 255, w32.LWA_ALPHA));
  if (meanOpacity > 1) rep.pass(`setOpacity(0.45) 在透明窗口上有视觉效果（差分 mean=${meanOpacity.toFixed(2)}），降级路径可用`);
  else rep.fail('setOpacity(0.45) 与 opacity=1 截图无差——透明窗口上该降级手段无视觉效果（或抓屏盲区），02 勿依赖');
  if (meanLwa > 1) rep.pass(`直调 SetLayeredWindowAttributes(LWA_ALPHA) 有视觉效果（差分 mean=${meanLwa.toFixed(2)}），可作为降级实现`);
  else rep.note('SetLayeredWindowAttributes 直调亦无差分——降级需换实现（如非透明窗+CSS 半透明）');

  // 6) 关参照窗，实拍面板叠真壁纸（开局已清场，此时面板背后就是壁纸+桌面图标）
  backdrop.destroy();
  await H.sleep(800);
  const onWall = H.capture(rect, 'a-on-wallpaper');
  const dWall = H.zoneDiff(bareWallpaper, onWall, transparentZone);
  rep.note(`透明区 vs 壁纸基线 mean=${dWall.mean.toFixed(2)} max=${dWall.max} >40占比=${dWall.over40Pct.toFixed(1)}%（仅记录）`);
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
