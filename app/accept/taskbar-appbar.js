'use strict';
// 工单51 任务栏 AppBar 工作区占位 + 全屏让位验收：控制器以 --accept-taskbar-appbar
// 身份运行，拉起 --panel-accept 面板子进程（绕单实例锁），逐项验收：
//   P1 AppBar 占位生效：taskbar-appbar-registered 存证 + SPI_GETWORKAREA 底边
//      = 屏底 - 64DIP（物理像素口径；工单158 栏高升档），条带几何与占位同矩形
//   P2 最大化让位：控制器自开参照窗 maximize → 底边停在栏上方不被遮挡
//   P3 分辨率变化重算：切到另一受支持分辨率 → taskbar-appbar-setpos
//      （reason=display-metrics-changed）存证 + 条带与工作区随新分辨率重算 → 还原
//   P4 全屏让位：控制器自开全屏参照窗并置前台 → 条带隐藏（taskbar-yield 存证 +
//      视图事实）；销毁全屏窗 → 1 秒内恢复（taskbar-yield-lifted 存证 + 时延断言）
//   P5 卸载归还：面板正常退出（WM_CLOSE）→ AppBar 注销（taskbar-appbar-removed
//      存证）+ 工作区归还全屏
// 运行：npm run accept:taskbar-appbar（= electron . --accept-taskbar-appbar）。
// 与其他验收同一铁律：必须经 accept-guard 托管（真机分辨率切换与前台注入，互斥）。
const { app, screen, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const win32 = require('./lib/win32');
const { Report } = require('./lib/report');
// config 读写/还原共通 helper（工单124）：缺位读不抛、缺位落桩、三态还原——四电池单点维护
const { readConfigRaw, patchTaskbar, restoreConfig } = require('./lib/battery-config');
// 工单210：事件磁带（app/accept/lib/event-tape）——等待/读事件收口到一份正典实现；
// 超时档 8000（taskbar 族五块档，母票 #201 决策 8）
const { createEventTape } = require('./lib/event-tape');
// 工单211：面板句柄（app/accept/lib/panel-control 的 createPanelHandle）——发射/就绪/
// 重启/清场四段样板归句柄；清场走**验证强退**（优雅终止 → 整树强杀 → 有界等待并验证消失）
const { createPanelHandle } = require('./lib/panel-control');

const APP_ROOT = path.resolve(__dirname, '..');
const EVENTS_FILE = path.join(__dirname, 'evidence', '51-taskbar-appbar-events.jsonl');
const tape = createEventTape(EVENTS_FILE, { defaultTimeoutMs: 8000 });
// 工单211：句柄装配——发射形态 accept（['.','--panel-accept']；本电池不注入 CDP 端口，
// 与现行 spawn 的 env 逐字同形）；证据档按电池注入专属档名（裁决 10）
const handle = createPanelHandle({
  execPath: process.execPath, appRoot: APP_ROOT, eventLogPath: EVENTS_FILE,
  archivePath: path.join(__dirname, 'evidence', '51-taskbar-appbar-panel-handle-child.log'),
});
const TASKBAR_TITLE = 'DECK-TASKBAR';
const PANEL_TITLE = 'AGENT DECK';
const TASKBAR_HEIGHT_DIP = 64; // src/main/taskbar/window.ts TASKBAR_HEIGHT（工单158 起 64）
const WM_CLOSE = 0x0010;
const SPI_GETWORKAREA = 0x0030;
const ENUM_CURRENT_SETTINGS = -1;
const DISP_CHANGE_SUCCESSFUL = 0;
// DEVMODEW 字段偏移（220 字节定长布局）：dmSize@68, dmPelsWidth@172, dmPelsHeight@176
const DEVMODE_SIZE = 220;
const OFF_PELS_WIDTH = 172;
const OFF_PELS_HEIGHT = 176;

const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
const SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, _Out_ RECT *pvParam, uint32 fWinIni)');
const EnumDisplaySettingsW = user32.func('bool __stdcall EnumDisplaySettingsW(void *lpszDeviceName, int32 iModeNum, void *lpDevMode)');
const ChangeDisplaySettingsW = user32.func('int32 __stdcall ChangeDisplaySettingsW(void *lpDevMode, uint32 dwFlags)');

const { nativeTaskbarVisible, ensureNativeTaskbarVisible } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hwndOf(win) {
  const v = koffi.decode(win.getNativeWindowHandle(), 'uintptr_t');
  return typeof v === 'bigint' ? Number(v) : v;
}

/** 强制前台（前台锁下 focus() 会静默失败）：AttachThreadInput 链到当前前台线程再 SetForegroundWindow */
function forceForeground(hwnd) {
  const fg = Number(win32.GetForegroundWindow());
  const curTid = win32.GetCurrentThreadId();
  const fgTid = fg ? win32.threadIdOf(fg).tid : 0;
  if (fgTid && fgTid !== curTid) win32.AttachThreadInput(curTid, fgTid, true);
  try {
    win32.SetForegroundWindow(hwnd);
    win32.BringWindowToTop(hwnd);
  } finally {
    if (fgTid && fgTid !== curTid) win32.AttachThreadInput(curTid, fgTid, false);
  }
}

/** 当前工作区（物理像素）：AppBar 占位的系统侧事实 */
function workArea() {
  const r = {};
  if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, r, 0)) return null;
  return r;
}

/** 主屏物理尺寸（GetWindowRect/AppBar 同口径） */
function primaryPhys() {
  const d = screen.getPrimaryDisplay();
  return {
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
    scale: d.scaleFactor,
  };
}

/** 等谓词成立，返回达成时刻距起点的毫秒；超时返回 -1 */
async function waitMs(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await sleep(60);
  }
  return -1;
}

/** 当前主屏模式快照（ENUM_CURRENT_SETTINGS，完整 DEVMODE 原文供还原） */
function currentDisplayMode() {
  const buf = Buffer.alloc(DEVMODE_SIZE);
  if (!EnumDisplaySettingsW(null, ENUM_CURRENT_SETTINGS, buf)) return null;
  return buf;
}

/** 枚举一个与当前分辨率不同的受支持模式（供 P3 切换）；找不到返回 null */
function alternateDisplayMode(cur) {
  const curW = cur.readUInt32LE(OFF_PELS_WIDTH);
  const curH = cur.readUInt32LE(OFF_PELS_HEIGHT);
  const buf = Buffer.alloc(DEVMODE_SIZE);
  for (let i = 0; EnumDisplaySettingsW(null, i, buf); i++) {
    const w = buf.readUInt32LE(OFF_PELS_WIDTH);
    const h = buf.readUInt32LE(OFF_PELS_HEIGHT);
    if (w !== curW && h !== curH) return { buf: Buffer.from(buf), width: w, height: h };
  }
  return null;
}

function setDisplayMode(buf) {
  return ChangeDisplaySettingsW(buf, 0) === DISP_CHANGE_SUCCESSFUL;
}

/** 电池主体（工单214 导出归一：原 main 改名 runSegments，导出面收归 main） */
async function runSegments() {
  const rep = new Report('51-taskbar-appbar');
  const originalConfig = readConfigRaw();
  const originalMode = currentDisplayMode();
  let panelPid = 0;
  let modeSwitched = false;
  const refWins = [];
  const finish = () => {
    const v = rep.verdict(rep.fails === 0 ? 'PASS' : 'FAIL');
    app.exit(v.fails === 0 ? 0 : 1);
  };

  try {
    fs.writeFileSync(EVENTS_FILE, '', 'utf8');
    patchTaskbar({ enabled: true });
    // guard 拿槽时会强杀常驻面板，其藏下的原生任务栏由还原守护在数秒内翻回——
    // 先等守护/兜底把现场收干净，再校验出发态（不从不属于自己的隐藏态出发）。
    await waitMs(() => nativeTaskbarVisible(), 10000);
    ensureNativeTaskbarVisible();
    await sleep(500);
    if (!nativeTaskbarVisible()) {
      throw new Error('开跑前原生任务栏已隐藏（他方现场，等待+兜底后仍未还原）——先人工核查再跑');
    }
    // 工作区基线（原生任务栏可见、我方未占位的出发态）：P5 归还断言对标它——
    // 可见的原生任务栏自身就占底边一档，「归还」= 回到基线而非满屏。
    const waBaseline = workArea();
    if (!waBaseline) throw new Error('开跑前读不到工作区（SPI_GETWORKAREA）');
    if (!originalMode) throw new Error('读取当前显示模式失败（EnumDisplaySettingsW）');

    // —— P1：AppBar 占位生效 ——
    rep.beginSegment('P1');
    // 工单211：发射归面板句柄（mode='accept' ＝ ['.','--panel-accept']，本电池不带 CDP 端口）
    handle.launch({ mode: 'accept', stdio: 'ignore' });
    const boot = await tape.wait('boot', null, { timeoutMs: 20000 });
    if (!boot) throw new Error('P1 面板未上报 boot');
    panelPid = boot.pid;
    const tbHwnd = await handle.waitWindow({ title: TASKBAR_TITLE, timeoutMs: 12000 });
    if (!tbHwnd) throw new Error('P1 任务栏条带窗未出现');
    const regEv = await tape.wait('taskbar-appbar-registered', null, { timeoutMs: 5000 });
    const setposEv = await tape.wait('taskbar-appbar-setpos', (e) => e.reason === 'create', { timeoutMs: 5000 });
    // 工作区收缩有生效时延，轮询到期望值
    const phys0 = primaryPhys();
    const expectBottom0 = phys0.height - Math.round(TASKBAR_HEIGHT_DIP * phys0.scale);
    const waMs = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - expectBottom0) <= 2;
    }, 5000);
    const wa1 = workArea();
    const stripRect = win32.rectOf(tbHwnd);
    const stripOk = stripRect && Math.abs(stripRect.bottom - phys0.height) <= 2;
    if (regEv && setposEv && waMs >= 0 && stripOk) {
      rep.pass(`P1 AppBar 占位生效：工作区底边 ${wa1.bottom}/${phys0.height}（让出 ${phys0.height - wa1.bottom}px ≈ ${TASKBAR_HEIGHT_DIP}DIP×${phys0.scale}），条带底边 ${stripRect.bottom} 贴屏底`);
    } else {
      rep.fail(`P1 注册存证=${!!regEv} setpos=${!!setposEv} 工作区=${JSON.stringify(wa1)} 期望底=${expectBottom0} 条带=${JSON.stringify(stripRect)} 屏高=${phys0.height}`);
    }

    // —— P2：最大化让位（参照窗 maximize → 底边停在栏上方）——
    rep.beginSegment('P2');
    const maxWin = new BrowserWindow({ width: 800, height: 600, title: 'DECK-ACCEPT-MAX', backgroundColor: '#203040' });
    refWins.push(maxWin);
    await maxWin.loadURL('about:blank');
    maxWin.maximize();
    await sleep(1200); // 等最大化落定
    const maxRect = win32.rectOf(hwndOf(maxWin));
    const stripTop = win32.rectOf(tbHwnd).top;
    const waP2 = workArea();
    const maxOk = maxRect && Math.abs(maxRect.bottom - stripTop) <= 8 && maxRect.bottom < phys0.height - 8;
    if (maxOk && waP2 && Math.abs(maxRect.bottom - waP2.bottom) <= 8) {
      rep.pass(`P2 最大化让位：参照窗底边 ${maxRect.bottom} 停在栏上沿 ${stripTop}（屏底 ${phys0.height}，未被遮挡）`);
    } else {
      rep.fail(`P2 参照窗=${JSON.stringify(maxRect)} 栏上沿=${stripTop} 工作区底=${waP2 && waP2.bottom} 屏高=${phys0.height}`);
    }

    // —— P3：分辨率变化重算（切到另一受支持模式 → setpos 存证 + 几何重算 → 还原）——
    rep.beginSegment('P3');
    const alt = alternateDisplayMode(originalMode);
    if (!alt) {
      rep.fail('P3 找不到与当前不同的受支持分辨率（本机显示模式枚举异常）');
    } else {
      const sinceP3 = Date.now();
      if (!setDisplayMode(alt.buf)) {
        rep.fail(`P3 ChangeDisplaySettingsW 切到 ${alt.width}x${alt.height} 被拒`);
      } else {
        modeSwitched = true;
        await sleep(1500); // 等显示器重同步 + display-metrics-changed 投递
        const reposEv = await tape.wait('taskbar-appbar-setpos',
          (e) => e.reason === 'display-metrics-changed', { since: sinceP3, timeoutMs: 8000 });
        const phys1 = primaryPhys();
        const expectBottom1 = phys1.height - Math.round(TASKBAR_HEIGHT_DIP * phys1.scale);
        const waMs1 = await waitMs(() => {
          const wa = workArea();
          return wa && wa.bottom === expectBottom1;
        }, 5000);
        const waAfter = workArea();
        const stripAfter = await waitMs(() => {
          const r = win32.rectOf(tbHwnd);
          return r && Math.abs(r.bottom - phys1.height) <= 2;
        }, 5000);
        const stripRect1 = win32.rectOf(tbHwnd);
        if (reposEv && waMs1 >= 0 && stripAfter >= 0 && phys1.height === alt.height) {
          rep.pass(`P3 分辨率变化重算：${alt.width}x${alt.height} 下工作区底 ${waAfter.bottom}、条带底 ${stripRect1.bottom} 随新分辨率重算（setpos 存证在流）`);
        } else {
          rep.fail(`P3 setpos存证=${!!reposEv} 工作区=${JSON.stringify(waAfter)} 期望=${expectBottom1} 条带=${JSON.stringify(stripRect1)} 物理=${JSON.stringify(phys1)} 目标=${alt.width}x${alt.height}`);
        }
        if (setDisplayMode(originalMode)) {
          modeSwitched = false;
          await sleep(1500);
          rep.note('P3 分辨率已还原');
        } else {
          rep.note('P3 分辨率还原失败（finally 再试）');
        }
      }
    }

    // —— P4：全屏让位（全屏参照窗前台 → 条带隐藏；退出 → 1 秒内恢复）——
    // 最大化参照窗先还原，避免它 fullscreen 退出后占前台干扰让位判定（它不覆盖
    // 全屏，判定本就为否——还原只为现场干净）。
    rep.beginSegment('P4');
    maxWin.restore();
    const sinceP4 = Date.now();
    const fsWin = new BrowserWindow({ fullscreen: true, frame: false, title: 'DECK-ACCEPT-FULLSCREEN', backgroundColor: '#101820' });
    refWins.push(fsWin);
    await fsWin.loadURL('about:blank');
    fsWin.show();
    fsWin.focus();
    forceForeground(hwndOf(fsWin)); // 前台锁下 focus() 静默失败（第3轮实证），强制链入
    const fgMs = await waitMs(() => Number(win32.GetForegroundWindow()) === hwndOf(fsWin), 4000);
    if (fgMs < 0) rep.note(`P4 前台强制未达（fg=${Number(win32.GetForegroundWindow())} fsHwnd=${hwndOf(fsWin)}），让位判定以前台事实为准`);
    const hideMs = await waitMs(() => !win32.IsWindowVisible(tbHwnd), 5000);
    const yieldEv = await tape.wait('taskbar-yield', undefined, { since: sinceP4, timeoutMs: 3000 });
    if (hideMs >= 0 && yieldEv) {
      rep.pass(`P4a 全屏让位：前台全屏参照窗 ${fgMs}ms 落位前台后 ${hideMs}ms 条带隐藏（taskbar-yield 存证 + 视图事实）`);
    } else {
      rep.fail(`P4a 隐藏时延=${hideMs}ms yield存证=${!!yieldEv} 前台落位=${fgMs}ms 条带可见=${win32.IsWindowVisible(tbHwnd)}`);
    }
    const t0 = Date.now();
    fsWin.destroy();
    refWins.pop();
    const liftMs = await waitMs(() => win32.IsWindowVisible(tbHwnd), 5000);
    const liftedEv = await tape.wait('taskbar-yield-lifted', undefined, { since: t0, timeoutMs: 3000 });
    if (liftMs >= 0 && liftMs <= 1000 && liftedEv) {
      rep.pass(`P4b 退出全屏恢复：${liftMs}ms 内条带恢复（≤1 秒口径，taskbar-yield-lifted 存证）`);
    } else {
      rep.fail(`P4b 恢复时延=${liftMs}ms lifted存证=${!!liftedEv} 条带可见=${win32.IsWindowVisible(tbHwnd)}`);
    }

    // —— P5：卸载归还（面板正常退出 → AppBar 注销 + 工作区归还全屏）——
    rep.beginSegment('P5');
    const sinceP5 = Date.now();
    const panelHwnd = await handle.waitWindow({ title: PANEL_TITLE, timeoutMs: 8000 });
    if (!panelHwnd) throw new Error('P5 面板主窗未找到');
    win32.PostMessageW(panelHwnd, WM_CLOSE, 0, 0);
    const removeEv = await tape.wait('taskbar-appbar-removed', undefined, { since: sinceP5, timeoutMs: 8000 });
    // 归还判据 = 回到开跑前基线（原生任务栏还原后自身占底边一档，不是满屏）
    const restoreMs = await waitMs(() => {
      const wa = workArea();
      return wa && Math.abs(wa.bottom - waBaseline.bottom) <= 2 && Math.abs(wa.top - waBaseline.top) <= 2;
    }, 8000);
    const waEnd = workArea();
    if (removeEv && restoreMs >= 0) {
      rep.pass(`P5 卸载归还：面板退出即注销 AppBar（存证在流），工作区归还基线（底边 ${waEnd.bottom}/基线 ${waBaseline.bottom}）`);
    } else {
      rep.fail(`P5 removed存证=${!!removeEv} 归还时延=${restoreMs}ms 工作区=${JSON.stringify(waEnd)} 基线=${JSON.stringify(waBaseline)}`);
    }
  } catch (err) {
    rep.fail(`电池异常: ${err && err.stack || err}`);
  } finally {
    // 清场（容错同 carry 电池：任何抛错都不能拦住 finish()）：关参照窗 → 杀面板 →
    // 还原分辨率 → --icon-restore 自救 → 还原 config。
    try {
      for (const w of refWins) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* 尽力 */ } }
      // 工单211：面板清场归句柄**验证强退**（优雅终止 → 整树强杀 → 有界等待并验证消失；
      // gone=false 只入环境降责账、**不中止**——清场段抛错会拦住 finish() → 控制器不退）
      const cleared = await handle.stop();
      if (cleared && cleared.gone === false) {
        rep.exclude(`清场核验：面板强退失败：强杀后有界等待内仍存活（pid=${cleared.pidsLeft.join(', ')}）——需重启清障`,
          '清场后仍有面板进程存活', 'panel-forcekill');
      }
      await sleep(800);
      if (modeSwitched) {
        try { if (setDisplayMode(originalMode)) rep.note('清场：分辨率已还原'); } catch { /* 尽力 */ }
      }
      try {
        require('child_process').spawnSync(process.execPath, ['.', '--icon-restore'], {
          cwd: APP_ROOT, env: { ...process.env, DECK_EVENT_LOG: EVENTS_FILE }, stdio: 'ignore', timeout: 20000,
        });
      } catch { /* 尽力 */ }
      await sleep(500);
      try { ensureNativeTaskbarVisible(); } catch { /* 兜底中的兜底也不许抛 */ }
      try { restoreConfig(originalConfig); } catch { /* 尽力（三态还原，工单124） */ }
      try {
        (await waitMs(() => nativeTaskbarVisible(), 5000)) >= 0
          ? rep.note('清场核验：原生任务栏可见')
          : rep.note('清场核验：原生任务栏仍隐藏（ensure 兜底已尝试，需人工核查）');
      } catch (e) { rep.note(`清场核验异常: ${e && e.message || e}`); }
    } catch (e) {
      rep.note(`清场段异常（不拦截收尾）: ${e && e.message || e}`);
    }
  }

  finish();
}

/**
 * 导出归一（工单214，spec #203 决策 6）：控制器已在 whenReady 内调起 → 直接导出 main
 * （消双重 whenReady 包装）；崩溃兜底在此收口，机械等价于原 wrapper 的 catch。
 */
async function main() {
  try {
    await runSegments();
  } catch (e) {
    console.error('APPBAR BATTERY CRASH:', e && e.stack || e);
    app.exit(2);
  }
}

module.exports = main;
