'use strict';
// 探针C：底部钉扎 —— 经 FFI/SetWindowPos(HWND_BOTTOM) 把普通窗口压在所有普通应用之下、盖过壁纸。
// 断言手段：WindowFromPoint 物理探针点（重叠点/仅面板点/仅记事本点）；
// 场景：普通应用（记事本）遮盖、置顶窗（TOPMOST）遮盖、点击/激活是否把面板顶起（回弹）。
const { spawn } = require('child_process');
const { Report } = require('../lib/report');
const H = require('../lib/harness');

const WM_CLOSE = 0x0010;

module.exports = async function probeC() {
  const rep = new Report('c_bottom_pinning');
  const w32 = H.win32;
  const si = H.screenInfo();
  const f = si.factor;
  rep.note(`screen: phys ${si.phys.w}x${si.phys.h} @ factor ${si.factor}`);
  await H.clearDesktop([{ x: 200, y: 520 }, { x: 1360, y: 760 }]);
  await H.sleep(300);

  // 面板（不透明、无边框普通窗）DIP(80,240,520,420) → phys(160,480)-(1200,1320)
  const panel = await H.createWindow({
    file: 'c.html', domChannel: 'c:dom', events: [],
    x: 80, y: 240, width: 520, height: 420,
    transparent: false, frame: false, title: 'PROBE-C-PANEL',
  });
  const hwnd = H.hwndOf(panel);
  const rect = w32.rectOf(hwnd);
  rep.note(`panel hwnd=0x${hwnd.toString(16)} rect(phys)=${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}`);
  panel.showInactive();
  await H.sleep(400);

  const pOnly = { x: 200, y: 520 }; // phys：仅面板覆盖（200,520）
  const hitPOnly = () => w32.windowFromPointRoot(pOnly);
  hitPOnly() === hwnd
    ? rep.pass('未钉扎时 WindowFromPoint(仅面板点)=面板（面板盖过壁纸/桌面层）')
    : rep.fail(`仅面板点命中 0x${hitPOnly().toString(16)}(${w32.className(hitPOnly())})，非面板`);

  // 记事本作为真实普通应用，摆在面板右半 phys(500,700,900,550)（避开屏幕右侧用户窗）
  const app = await H.launchOrdinaryApp(rep, { x: 500, y: 700, w: 900, h: 550 });
  const nhwnd = app.hwnd;
  rep.note(`class=${w32.className(nhwnd)}`);

  const overlap = { x: 900, y: 900 };  // phys：面板∩记事本
  const nOnly = { x: 1360, y: 760 };   // phys：仅记事本
  const wfp = pt => w32.windowFromPointRoot(pt);
  const pinBottom = () => w32.SetWindowPos(hwnd, w32.HWND_BOTTOM, 0, 0, 0, 0,
    w32.SWP_NOMOVE | w32.SWP_NOSIZE | w32.SWP_NOACTIVATE | w32.SWP_NOOWNERZORDER);

  // 激活记事本（真实用户操作：点击其独占区）→ 自然应在面板之上
  w32.clickPhys(nOnly.x, nOnly.y, 'left');
  await H.sleep(400);
  wfp(overlap) === nhwnd
    ? rep.pass('激活后记事本在面板之上（自然 z 序）')
    : rep.fail(`重叠点命中 0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})，非记事本`);

  // 底部钉扎
  const ok = pinBottom();
  await H.sleep(300);
  ok || rep.fail('SetWindowPos(HWND_BOTTOM) 返回失败');
  wfp(overlap) === nhwnd
    ? rep.pass('钉扎后记事本仍盖住面板（重叠点=记事本）')
    : rep.fail(`钉扎后重叠点命中 0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})`);
  wfp(pOnly) === hwnd
    ? rep.pass('钉扎后面板仍在壁纸之上（仅面板点=面板）')
    : rep.fail(`钉扎后仅面板点命中 0x${wfp(pOnly).toString(16)}(${w32.className(wfp(pOnly))})`);
  const exz = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
  rep.note(`钉扎后 EXSTYLE=0x${(exz >>> 0).toString(16)}（TOPMOST 位=${!!(exz & w32.WS_EX_TOPMOST)}）`);
  H.capture({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, 'c-pinned-bottom');

  // 回弹测试：点击面板独占区（无穿透）→ 面板被激活并顶起？
  w32.clickPhys(pOnly.x, pOnly.y, 'left');
  await H.sleep(450);
  const fgAfterClick = w32.GetForegroundWindow();
  const overlapAfterClick = wfp(overlap);
  rep.note(`点击面板后：前台=0x${fgAfterClick.toString(16)}(${w32.className(fgAfterClick)})，重叠点命中=0x${overlapAfterClick.toString(16)}(${w32.className(overlapAfterClick)})`);
  if (overlapAfterClick === hwnd) {
    rep.note('结论：点击激活会把底部钉扎的面板顶起 —— 生产实现须在交互结束后重新钉扎（或用 WS_EX_NOACTIVATE）');
    // 重新钉扎验证可恢复
    pinBottom();
    await H.sleep(300);
    wfp(overlap) === nhwnd
      ? rep.pass('重新钉扎后面板回到普通窗之下（可恢复）')
      : rep.fail('重新钉扎后面板未回底');
  } else {
    rep.pass('点击面板未顶起 z 序（前台与 z 序独立，钉扎稳定）');
    fgAfterClick === hwnd
      ? rep.note('面板点击后获得前台且保持底部（理想生产行为）')
      : rep.note(`点击后前台=0x${fgAfterClick.toString(16)}，非面板`);
  }

  // 纯 SetForegroundWindow 是否顶起 z 序（探针D的强制前台会用到）
  w32.SetForegroundWindow(hwnd);
  await H.sleep(300);
  const fgSF = w32.GetForegroundWindow();
  const overlapSF = wfp(overlap);
  rep.note(`SetForegroundWindow(面板)后：前台匹配=${fgSF === hwnd}，重叠点=0x${overlapSF.toString(16)}(${w32.className(overlapSF)})`);
  if (overlapSF === hwnd) {
    pinBottom();
    await H.sleep(200);
  }

  // 置顶窗场景：记事本 TOPMOST 应仍在底部面板之上
  w32.SetWindowPos(nhwnd, w32.HWND_TOPMOST, 0, 0, 0, 0,
    w32.SWP_NOMOVE | w32.SWP_NOSIZE | w32.SWP_NOACTIVATE);
  await H.sleep(300);
  pinBottom();
  await H.sleep(300);
  wfp(overlap) === nhwnd
    ? rep.pass('置顶窗（TOPMOST）盖住底部钉扎的面板（z 序分带符合预期）')
    : rep.fail(`置顶窗场景重叠点命中 0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})`);
  const exz2 = w32.GetWindowLongW(nhwnd, w32.GWL_EXSTYLE);
  (exz2 & w32.WS_EX_TOPMOST)
    ? rep.note('记事本确认处于 TOPMOST 带')
    : rep.note('记事本 TOPMOST 位未置上（结果按实际 z 序解读）');
  H.capture({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, 'c-topmost-over-panel');

  // 还原记事本非置顶
  w32.SetWindowPos(nhwnd, w32.HWND_NOTOPMOST, 0, 0, 0, 0,
    w32.SWP_NOMOVE | w32.SWP_NOSIZE | w32.SWP_NOACTIVATE);
  await H.sleep(200);

  // 收尾：关记事本
  w32.PostMessageW(nhwnd, WM_CLOSE, 0, 0);
  await H.sleep(400);
  w32.IsWindow(nhwnd) ? rep.note('记事本窗口仍在（WM_CLOSE 后未退，探针收尾用 kill 兜底）') : rep.note('记事本已关闭');

  return rep.verdict('DONE');
};
