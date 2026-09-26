'use strict';
// 探针B：鼠标穿透 + 事件转发 —— 默认点击直达桌面/下层窗口，光标进入热区临时接收。
// 方法：透明面板窗默认 setIgnoreMouseEvents(true,{forward:true})；
//       主进程按 spec 以 GetCursorPos 轮询做热区命中（渲染层声明热区矩形）；
//       用真实 SendInput 点击验证三条通路：穿透到下层 Electron 哨兵窗、
//       穿透到系统桌面（前台翻转）、热区内面板接收；离开热区恢复穿透。
const { Report } = require('../lib/report');
const H = require('../lib/harness');

const DESKTOP_CLASSES = ['WorkerW', 'Progman', 'SHELLDLL_DefView', 'SysListView32'];

module.exports = async function probeB() {
  const rep = new Report('b_clickthrough');
  const w32 = H.win32;
  const si = H.screenInfo();
  const f = si.factor;
  rep.note(`screen: phys ${si.phys.w}x${si.phys.h} @ factor ${si.factor}`);
  H.clearDesktop([{ x: 560 * f, y: 300 * f }, { x: 260 * f, y: 560 * f }]); // 用户窗口全部最小化，保证探针点位之下就是桌面/壁纸
  await H.sleep(300);

  // 布局（DIP）：面板 (80,240,520,420)，热区 rel(40,40,300,180)；
  // 哨兵 (110,470,300,180)（面板之下、不与热区重叠）；
  // 桌面直落点 (560,300)（面板内、热区与哨兵之外）。
  const panelEvents = [], sentinelEvents = [];
  const sentinel = await H.createWindow({
    file: 'sentinel.html', domChannel: 's:dom', events: sentinelEvents,
    x: 110, y: 470, width: 300, height: 180,
    transparent: false, frame: false, title: 'PROBE-B-SENTINEL',
  });
  const panel = await H.createWindow({
    file: 'b.html', domChannel: 'b:dom', events: panelEvents,
    x: 80, y: 240, width: 520, height: 420,
    transparent: true, frame: false, title: 'PROBE-B',
  });
  const hwnd = H.hwndOf(panel);
  const hwndS = H.hwndOf(sentinel);
  const rect = w32.rectOf(hwnd);
  rep.note(`panel hwnd=0x${hwnd.toString(16)}, sentinel hwnd=0x${hwndS.toString(16)}`);

  // 渲染层声明热区
  const zoneEvt = await H.waitForEvent(panelEvents, e => e.type === 'zone', 5000);
  if (!zoneEvt) { rep.fail('渲染层未声明热区'); return rep.verdict('ERROR'); }
  const zone = zoneEvt; // client CSS px（= DIP）
  rep.note(`热区声明: rel(${zone.x},${zone.y}) ${zone.w}x${zone.h}`);

  // 光标先挪开，避免起始位置落在面板上
  const savedCursor = w32.cursor();
  w32.moveMousePhys(40, si.phys.h - 40);

  // 初始穿透态（showInactive 均不改 z 序：panel 后创建，天然在哨兵之上）
  panel.setIgnoreMouseEvents(true, { forward: true });
  panel.showInactive();
  sentinel.showInactive();
  await H.sleep(600);

  // 主进程热区命中轮询（spec 拟定机制）
  let ignore = true;
  let transitions = 0;
  const poller = setInterval(() => {
    if (panel.isDestroyed()) return;
    const cur = w32.cursor();
    const rel = { x: (cur.x - rect.left) / f, y: (cur.y - rect.top) / f };
    const inside = rel.x >= zone.x && rel.x <= zone.x + zone.w && rel.y >= zone.y && rel.y <= zone.y + zone.h;
    if (inside && ignore) {
      panel.setIgnoreMouseEvents(false); ignore = false; transitions++;
      rep.note('热区进入 → setIgnoreMouseEvents(false)');
    } else if (!inside && !ignore) {
      panel.setIgnoreMouseEvents(true, { forward: true }); ignore = true; transitions++;
      rep.note('热区离开 → setIgnoreMouseEvents(true, forward)');
    }
  }, 25);
  H.onCleanup(() => clearInterval(poller));

  const ex = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
  rep.log(`穿透态 EXSTYLE=0x${(ex >>> 0).toString(16)} WS_EX_TRANSPARENT=${!!(ex & w32.WS_EX_TRANSPARENT)} WS_EX_LAYERED=${!!(ex & w32.WS_EX_LAYERED)}`);
  (ex & w32.WS_EX_TRANSPARENT) && (ex & w32.WS_EX_LAYERED)
    ? rep.pass('穿透态窗口样式含 WS_EX_TRANSPARENT|WS_EX_LAYERED')
    : rep.fail('穿透态窗口样式缺少预期位');

  const panelHits = () => panelEvents.filter(e => ['mousedown', 'click', 'contextmenu'].includes(e.type)).length;
  const sentinelHits = () => sentinelEvents.filter(e => ['mousedown', 'click', 'contextmenu'].includes(e.type)).length;

  // 1) 左键穿透到下层哨兵窗（哨兵中心 (260,560) DIP）
  let s0 = sentinelHits(), p0 = panelHits();
  w32.clickPhys(260 * f, 560 * f, 'left');
  await H.sleep(450);
  const sHit = sentinelHits() > s0, pHit = panelHits() > p0;
  (sHit && !pHit)
    ? rep.pass('穿透态点击落到面板下层的哨兵窗（面板未拦截）')
    : rep.fail(`穿透失败: sentinel新增=${sentinelHits() - s0} panel新增=${panelHits() - p0}`);
  const fg1 = w32.GetForegroundWindow();
  fg1 === hwndS
    ? rep.pass('点击穿透后哨兵窗获得前台')
    : rep.note(`点击穿透后前台=0x${fg1.toString(16)}(${w32.className(fg1)})，非哨兵`);
  H.capture(rect, 'b-pass-through');

  // 2) 左键穿透到系统桌面（前台翻转为 explorer 桌面类）
  s0 = sentinelHits(); p0 = panelHits();
  w32.clickPhys(560 * f, 300 * f, 'left');
  await H.sleep(450);
  const fg2 = w32.GetForegroundWindow();
  const cls2 = w32.className(fg2);
  DESKTOP_CLASSES.includes(cls2)
    ? rep.pass(`穿透态点击直达桌面（前台翻转为 ${cls2}）`)
    : rep.fail(`点击未直达桌面：前台=0x${fg2.toString(16)}(${cls2})`);
  (panelHits() === p0 && sentinelHits() === s0)
    ? rep.pass('桌面直落点无任何面板/哨兵拦截事件')
    : rep.fail(`桌面点击被拦截: panel新增=${panelHits() - p0} sentinel新增=${sentinelHits() - s0}`);

  // 3) 右键穿透：先把面板抬回哨兵之上，保证点击真正先落在面板透明区
  panel.moveTop();
  await H.sleep(300);
  s0 = sentinelHits(); p0 = panelHits();
  w32.clickPhys(260 * f, 560 * f, 'right');
  await H.sleep(450);
  const rHit = sentinelEvents.some(e => e.type === 'contextmenu') && sentinelHits() > s0;
  rHit && panelHits() === p0
    ? rep.pass('右键穿透：面板透明区放行，哨兵收到 contextmenu')
    : rep.fail(`右键未正确穿透: sentinel新增=${sentinelHits() - s0} panel新增=${panelHits() - p0}`);

  // 4) 热区接收：光标进热区 → 轮询解除穿透 → 点击由面板接收
  panel.moveTop(); // 哨兵第3步被右键顶起，先复位
  await H.sleep(200);
  w32.moveMousePhys(270 * f, 370 * f);
  await H.sleep(450);
  const ex2 = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
  !(ex2 & w32.WS_EX_TRANSPARENT)
    ? rep.pass('光标进入热区后 WS_EX_TRANSPARENT 已移除（面板恢复接收）')
    : rep.fail('进入热区后窗口仍处于穿透样式');
  p0 = panelHits(); s0 = sentinelHits();
  w32.clickPhys(270 * f, 370 * f, 'left');
  await H.sleep(450);
  const newPanel = panelEvents.filter(e => ['mousedown', 'click'].includes(e.type)).slice(panelHits() >= 2 ? -2 : -panelHits());
  (panelHits() - p0) >= 2
    ? rep.pass(`热区内点击由面板接收（${newPanel.map(e => `${e.type}@${Math.round(e.x)},${Math.round(e.y)}`).join(' / ')}）`)
    : rep.fail(`热区内点击未被面板接收: panel新增=${panelHits() - p0}`);
  (sentinelHits() === s0) || rep.fail('热区点击泄漏到哨兵');
  const fg4 = w32.GetForegroundWindow();
  fg4 === hwnd
    ? rep.pass('热区点击后面板获得前台（可激活）')
    : rep.note(`热区点击后前台=0x${fg4.toString(16)}(${w32.className(fg4)})`);
  H.capture(rect, 'b-hotzone-click');

  // 5) 离开热区 → 恢复穿透
  w32.moveMousePhys(560 * f, 300 * f);
  await H.sleep(450);
  const ex3 = w32.GetWindowLongW(hwnd, w32.GWL_EXSTYLE);
  (ex3 & w32.WS_EX_TRANSPARENT)
    ? rep.pass('离开热区后恢复 WS_EX_TRANSPARENT（穿透回归）')
    : rep.fail('离开热区后未恢复穿透样式');
  p0 = panelHits();
  w32.clickPhys(560 * f, 300 * f, 'left');
  await H.sleep(450);
  panelHits() === p0
    ? rep.pass('恢复穿透后热区外点击不再被面板接收')
    : rep.fail('恢复穿透后面板仍拦截点击');
  const fg5 = w32.GetForegroundWindow();
  rep.note(`收尾前台=0x${fg5.toString(16)}(${w32.className(fg5)})`);

  w32.SetCursorPos(savedCursor.x, savedCursor.y);
  return rep.verdict(transitions >= 2 ? 'PASS' : 'PARTIAL');
};
