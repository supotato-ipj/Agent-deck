'use strict';
// 探针D：低 z 序窗口的键盘聚焦 —— 底部钉扎的面板强制前台后，输入框可输入、中文输入法可用。
// 先验证「前台与 z 序独立」：win.focus() 可前台化但会顶起 z 序（探针C 已证
// SetForegroundWindow 不顶起），故生产配方为 focus→立即重钉；
// 再在「底部+前台」状态下验证 ASCII 键入（先关 IME 避免数字被候选吃掉）
// 与 IME 拼音合成（整串 nihao + 空格上屏）。
// 附测 WS_EX_NOACTIVATE：点击热区不夺取前台、不顶起 z 序（02 备选交互设计）。
const { Report } = require('../lib/report');
const H = require('../lib/harness');

const VK = { D: 0x44, E: 0x45, C: 0x43, K: 0x4B, N: 0x4E, I: 0x49, H: 0x48, A: 0x41, O: 0x4F, DIGIT0: 0x30, DIGIT1: 0x31, SPACE: 0x20 };

module.exports = async function probeD() {
  const rep = new Report('d_focus_ime');
  const w32 = H.win32;
  const si = H.screenInfo();
  const f = si.factor;
  rep.note(`screen: phys ${si.phys.w}x${si.phys.h} @ factor ${si.factor}`);
  await H.clearDesktop([{ x: 530, y: 620 }, { x: 1360, y: 760 }]);
  await H.sleep(300);

  // 布局：面板 DIP(80,240,520,420) phys(160,480)-(1200,1320)；
  // 输入卡 rel(40,40,300,120) → 输入框中心 phys(530,620)；
  // 记事本 phys(500,700,900,550) → 重叠点(900,900)、独占点(1360,760)。
  const events = [];
  const panel = await H.createWindow({
    file: 'd.html', domChannel: 'd:dom', events,
    x: 80, y: 240, width: 520, height: 420,
    transparent: true, frame: false, title: 'PROBE-D',
  });
  const hwnd = H.hwndOf(panel);
  const rect = w32.rectOf(hwnd);
  panel.showInactive();
  await H.sleep(400);
  rep.note(`panel hwnd=0x${hwnd.toString(16)} rect(phys)=${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}`);

  const app = await H.launchOrdinaryApp(rep, { x: 500, y: 700, w: 900, h: 550 });
  const nhwnd = app.hwnd;

  const overlap = { x: 900, y: 900 };
  const nOnly = { x: 1360, y: 760 };
  const inputPt = { x: 530, y: 620 };
  const wfp = pt => w32.windowFromPointRoot(pt);
  const pinBottom = () => w32.SetWindowPos(hwnd, w32.HWND_BOTTOM, 0, 0, 0, 0,
    w32.SWP_NOMOVE | w32.SWP_NOSIZE | w32.SWP_NOACTIVATE | w32.SWP_NOOWNERZORDER);
  const fgIsPanel = () => w32.GetForegroundWindow() === hwnd;
  const lastValue = () => [...events].reverse().find(e => e.type === 'value');
  const has = type => events.some(e => e.type === type);

  // 场景就位：记事本激活置前，面板钉扎到底
  w32.clickPhys(nOnly.x, nOnly.y, 'left');
  await H.sleep(400);
  pinBottom();
  await H.sleep(300);
  w32.GetForegroundWindow() === nhwnd || rep.note('记事本未获前台（继续，不影响 z 序断言）');
  wfp(overlap) === nhwnd
    ? rep.pass('场景就位：记事本在面板之上，面板已钉扎底部')
    : rep.fail('场景未就位：重叠点命中异常');

  // —— 强制前台：四种方法逐试，记录哪种可用 ——
  let method = null;
  panel.focus();
  await H.sleep(300);
  if (fgIsPanel()) method = 'Electron win.focus()';
  if (!method) {
    w32.SetForegroundWindow(hwnd);
    await H.sleep(300);
    if (fgIsPanel()) method = 'SetForegroundWindow 直接调用';
  }
  if (!method) {
    w32.send([w32.keyInput(0x12, w32.KEYDOWN), w32.keyInput(0x12, w32.KEYUP)]);
    w32.SetForegroundWindow(hwnd);
    await H.sleep(300);
    if (fgIsPanel()) method = 'ALT 解锁 + SetForegroundWindow';
  }
  if (!method) {
    const fg = w32.GetForegroundWindow();
    const { tid: fgThread } = w32.threadIdOf(fg);
    const my = w32.GetCurrentThreadId();
    const at1 = w32.AttachThreadInput(my, fgThread, true);
    w32.SetForegroundWindow(hwnd);
    const at2 = w32.AttachThreadInput(my, fgThread, false);
    await H.sleep(300);
    if (fgIsPanel()) method = `AttachThreadInput(at1=${at1},at2=${at2})`;
  }
  method
    ? rep.pass(`低 z 序窗口可强制前台：${method}`)
    : rep.fail('四种强制前台方法均失败（记录为 02 的关键风险）');

  // win.focus() 会顺带顶起 z 序（探针C 已证纯 SetForegroundWindow 不会）——
  // 生产配方：focus 后立即重钉。重钉后断言「前台仍是面板、z 序回底」。
  pinBottom();
  await H.sleep(300);
  (fgIsPanel() && wfp(overlap) === nhwnd)
    ? rep.pass('重钉后面板保持前台且回到普通窗之下（前台与 z 序独立，可共存）')
    : rep.fail(`重钉后状态异常: 前台=${fgIsPanel()} 重叠点=0x${wfp(overlap).toString(16)}(${w32.className(wfp(overlap))})`);

  // 输入框聚焦（JS 内聚焦，不动窗口状态）
  const focusOk = await panel.webContents.executeJavaScript('window.focusInput()');
  focusOk
    ? rep.pass('输入框经渲染层 JS 获得焦点（窗口保持底部钉扎）')
    : rep.fail('输入框未能聚焦');
  (await H.waitForEvent(events, e => e.type === 'focus', 2000)) || rep.note('渲染层未上报 focus 事件');

  // —— ASCII 键入（先关 IME：数字会被候选选词吃掉）——
  const imeBefore = w32.imeStatus(hwnd);
  if (imeBefore.available && imeBefore.gotContext && imeBefore.open) {
    w32.imeSetOpen(hwnd, false);
    await H.sleep(200);
  }
  rep.note(`ASCII 测试前 IME open=${(w32.imeStatus(hwnd) || {}).open}`);
  w32.tapKeys([VK.D, VK.E, VK.C, VK.K, VK.DIGIT0, VK.DIGIT1]);
  await H.sleep(500);
  const v1 = lastValue();
  (/deck01/i.test(v1 ? v1.value : ''))
    ? rep.pass(`底部前台窗口输入框收到 ASCII 键入: "${v1.value}"`)
    : rep.fail(`ASCII 键入异常: ${v1 ? v1.value : '(无 value 事件)'}`);
  (fgIsPanel() && wfp(overlap) === nhwnd)
    ? rep.note('键入过程中面板保持底部 + 前台（钉扎未被输入破坏）')
    : rep.fail(`键入后状态漂移: 前台=${fgIsPanel()} 重叠点=0x${wfp(overlap).toString(16)}`);
  H.capture({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, 'd-typed-ascii');

  // —— 中文输入法（整串拼音 + 空格上屏）——
  const hkl = w32.GetKeyboardLayout(0);
  rep.note(`键盘布局 langid=0x${((Number(hkl) >> 16) & 0xffff).toString(16)}`);
  let ime = w32.imeStatus(hwnd);
  rep.note(`Imm32 状态: ${JSON.stringify(ime)}`);
  if (ime.available && ime.gotContext && !ime.open) {
    w32.imeSetOpen(hwnd, true);
    await H.sleep(200);
    ime = w32.imeStatus(hwnd);
    rep.note(`ImmSetOpenStatus(TRUE) 后 open=${ime.open}`);
  }

  w32.tapKeys([VK.N, VK.I, VK.H, VK.A, VK.O]);
  await H.sleep(900);
  const compStart = has('compositionstart');
  const compStr = w32.imeString(hwnd, w32.GCS_COMPSTR);
  rep.note(`键入 nihao 后: compositionstart=${compStart}, GCS_COMPSTR="${compStr}", 输入值="${(lastValue() || {}).value}"`);
  H.capture({ left: Math.max(0, rect.left - 100), top: rect.top, right: Math.min(si.phys.w, rect.right + 300), bottom: Math.min(si.phys.h, rect.bottom + 300) }, 'd-ime-composition');

  if (compStart) {
    w32.tapKeys([VK.SPACE]);
    await H.sleep(800);
    const v2 = lastValue();
    const cjk = /[\u4e00-\u9fff]/.test(v2 ? v2.value : '');
    rep.log(`空格上屏后输入值: "${v2 ? v2.value : ''}"`);
    cjk
      ? rep.pass('中文输入法合成上屏：输入框收到 IME 提交的汉字（拼音 composition 事件 + 上屏值均实证）')
      : rep.fail(`IME 合成后输入值无汉字: "${v2 ? v2.value : ''}"`);
    rep.note(`composition 类事件总数: ${events.filter(e => e.type.startsWith('composition')).length}（候选次序因输入法个性化可能不同，以上屏值实证为准）`);
    H.capture({ left: Math.max(0, rect.left - 100), top: rect.top, right: Math.min(si.phys.w, rect.right + 300), bottom: Math.min(si.phys.h, rect.bottom + 300) }, 'd-ime-committed');
  } else {
    rep.note('未捕获 composition 事件（IME 可能未激活）——降级验证 unicode 直注');
    w32.sendUnicode('你好');
    await H.sleep(500);
    const v2 = lastValue();
    /[\u4e00-\u9fff]/.test(v2 ? v2.value : '')
      ? rep.pass('KEYEVENTF_UNICODE 直注汉字到达输入框（IME 合成项转人工复验，见截图）')
      : rep.fail('unicode 直注亦未到达');
  }

  // —— 附测：WS_EX_NOACTIVATE 点击不夺前台、不顶起 z 序 ——
  w32.clickPhys(nOnly.x, nOnly.y, 'left'); // 前台先交给记事本
  await H.sleep(400);
  const ex = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
  w32.SetWindowLongW(hwnd, w32.GWL_EXSTYLE, ex | w32.WS_EX_NOACTIVATE);
  pinBottom();
  await H.sleep(300);
  const fgBefore = w32.GetForegroundWindow();
  const mdCount = () => events.filter(e => e.type === 'mousedown').length;
  const md0 = mdCount();
  w32.clickPhys(inputPt.x, inputPt.y, 'left');
  await H.sleep(450);
  const fgAfter = w32.GetForegroundWindow();
  const noRaise = wfp(overlap) === nhwnd;
  const panelGotClick = mdCount() > md0;
  rep.note(`NOACTIVATE 点击输入区: 前台 ${fgBefore === nhwnd ? '记事本' : '其他'}→${fgAfter === nhwnd ? '记事本' : '其他'}，面板收到 mousedown=${panelGotClick}，重叠点仍=记事本:${noRaise}`);
  (fgAfter === nhwnd && noRaise && panelGotClick)
    ? rep.pass('WS_EX_NOACTIVATE：热区点击被面板接收但不夺取前台、不顶起 z 序（02 备选交互方案成立）')
    : rep.note('WS_EX_NOACTIVATE 行为与预期不符，02 仍按「交互后重钉」设计');
  w32.SetWindowLongW(hwnd, w32.GWL_EXSTYLE, ex); // 还原

  return rep.verdict('DONE');
};
