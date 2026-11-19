// 夹具窗清扫收口（工单486）：WM_CLOSE → 有界等窗消失 → 未消失按宿主 pid 强杀兜底。
// 背景：Win11 打包版记事本/画图是存根-宿主分裂模型——spawn pid 是存根（<1s 自退），
// 真窗宿主另有其人，child.kill() 够不着宿主；优雅关闭失灵时（保存模态框、关停卡死、
// Store 更新改行为——notepad 是 Store 自动更新的行为移动靶）残留无人清也无人知。
// 本模块把 agent-tiling P6（按窗反查宿主 pid 强杀）与 t484 closeWindow（有界等+兜底）
// 的语义收口成库。纪律：只碰调用方登记的夹具（spawn 前窗集合 / 记录到的 hwnd），
// 绝不按类名全机扫杀（用户自己的窗一律不碰）；多扇新窗无法认领时宁可不杀只注记。
'use strict';
const { spawnSync } = require('child_process');
const win32lib = require('./win32');

const WM_CLOSE = 0x0010;

function defaultPidAlive(pid) {
  if (!pid) return false;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').includes(`"${pid}"`);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function exeBaseOf(exe) {
  return String(exe || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
}

function windowMatches(win32, h, fixture) {
  let exe = '', cls = '';
  try {
    exe = String(win32.exeNameOfWindow(h) || '').toLowerCase();
    cls = String(win32.className(h) || '').toLowerCase();
  } catch { return false; }
  if (!win32.IsWindowVisible(h)) return false;
  if (fixture.windowClass && cls === String(fixture.windowClass).toLowerCase()) return true;
  return exe.startsWith(fixture.exeBase);
}

/** 夹具启动：spawn 别名应用并追认新出窗（宿主 pid）。纪律同 launchNotepad：
 * 按「spawn 前不存在的窗」匹配，绝不认领存量窗。窗未出现返回 hwnd=0（断言面处置），不抛。 */
async function launchAppFixture(opts = {}, deps = {}) {
  const {
    exe = 'notepad.exe',
    windowClass = '',
    timeoutMs = 3000,
  } = opts;
  const {
    win32 = win32lib,
    spawnFn = require('child_process').spawn,
    sleep = defaultSleep,
  } = deps;
  const fixture = {
    exeBase: exeBaseOf(exe),
    windowClass,
    child: spawnFn(exe, [], { stdio: 'ignore' }),
    hwnd: 0,
    hostPid: 0,
    preSet: new Set(win32.topLevelWindows()),
    spawnedAt: Date.now(),
  };
  await attachFixtureWindow(fixture, { timeoutMs }, { win32, sleep });
  return fixture;
}

/** 追认夹具窗：在 preSet 之外找唯一匹配的新窗，回填 hwnd/hostPid。多扇新窗无法认领时
 * 不动（注记进 fixture.attachNote）——宁可漏认不误认领用户窗。返回是否追认成功。 */
async function attachFixtureWindow(fixture, opts = {}, deps = {}) {
  const { timeoutMs = 1500 } = opts;
  const { win32 = win32lib, sleep = defaultSleep } = deps;
  if (fixture.hwnd && win32.IsWindow(Number(fixture.hwnd))) return true;
  const t0 = Date.now();
  for (;;) {
    const news = win32.topLevelWindows().filter((h) => !fixture.preSet.has(h) && windowMatches(win32, h, fixture));
    if (news.length === 1) {
      fixture.hwnd = news[0];
      try { fixture.hostPid = win32.threadIdOf(Number(news[0])).pid; } catch { fixture.hostPid = 0; }
      return true;
    }
    if (news.length > 1) {
      fixture.attachNote = `新窗 ${news.length} 扇无法唯一认领（可能混入用户窗），不追认不强杀`;
      return false;
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(200);
  }
}

/** 夹具清扫工厂（deps 可注入假 win32/spawn 做单测）。返回 { close }：
 * close(fixture) ① 窗在场发 WM_CLOSE；② 有界等窗消失（graceMs）；③ 窗未消失或宿主 pid
 * 仍存活（无窗残留=关停卡死形态）→ taskkill 宿主/存根 pid /T /F，再有界等（killWaitMs）。
 * 返回 { closed, forced, hostPid, windowStill, hostAlive, notes[] }。 */
function createFixtureClose(deps = {}) {
  const {
    win32 = win32lib,
    spawnFn = spawnSync,
    sleep = defaultSleep,
    pidAlive = defaultPidAlive,
    graceMs = 5000, // t484 closeWindow 同口径：WM_CLOSE 后 5s 有界等
    killWaitMs = 3000,
  } = deps;
  return {
    async close(fixture = {}) {
      const notes = [];
      const hwnd = fixture.hwnd ? Number(fixture.hwnd) : 0;
      // 宿主 pid 入账优先级：夹具登记 > 现场反查（窗还活着才有得反查）> 追认（记录过 preSet 才做）
      let hostPid = fixture.hostPid || 0;
      let windowStill = !!(hwnd && win32.IsWindow(hwnd) && win32.IsWindowVisible(hwnd));
      if (!hostPid && hwnd && win32.IsWindow(hwnd)) {
        try { hostPid = win32.threadIdOf(hwnd).pid; } catch { /* 窗刚销毁 */ }
      }
      if (!hwnd && fixture.preSet) {
        const claimed = await attachFixtureWindow(fixture, { timeoutMs: 0 }, { win32, sleep });
        if (claimed) {
          notes.push(`清扫时追认到夹具窗（启动期未出窗）宿主=${fixture.hostPid}`);
          hostPid = fixture.hostPid || hostPid;
          windowStill = !!(fixture.hwnd && win32.IsWindow(Number(fixture.hwnd)) && win32.IsWindowVisible(Number(fixture.hwnd)));
        } else if (fixture.attachNote) notes.push(fixture.attachNote);
      }
      const childPid = fixture.child && fixture.child.pid ? fixture.child.pid : 0;
      // ① 优雅关闭
      if (windowStill) {
        try { win32.PostMessageW(Number(fixture.hwnd), WM_CLOSE, 0, 0); } catch (e) { notes.push(`WM_CLOSE 异常:${e.message}`); }
      }
      // ② 有界等窗消失
      const t0 = Date.now();
      while (windowStill && Date.now() - t0 < graceMs) {
        await sleep(200);
        windowStill = !!(hwnd && win32.IsWindow(hwnd) && win32.IsWindowVisible(hwnd));
      }
      // ③ 兜底强杀：窗未消失，或登记的宿主 pid 仍存活（无窗残留=关停卡死形态）；
      // 宿主 pid 未知（夹具从未出窗）时存根仍存活也触发——存根可能就是宿主（非分裂模型）
      let forced = false;
      let hostAlive = hostPid ? pidAlive(hostPid) : false;
      let childAlive = (!hostPid && childPid) ? pidAlive(childPid) : false;
      if (windowStill || hostAlive || childAlive) {
        forced = true;
        for (const pid of [hostPid, childPid].filter(Boolean)) {
          spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        }
        const t1 = Date.now();
        do {
          await sleep(200);
          windowStill = !!(hwnd && win32.IsWindow(hwnd) && win32.IsWindowVisible(hwnd));
          hostAlive = hostPid ? pidAlive(hostPid) : false;
          childAlive = (!hostPid && childPid) ? pidAlive(childPid) : false;
        } while ((windowStill || hostAlive || childAlive) && Date.now() - t1 < killWaitMs);
      }
      if (forced) notes.push(`强杀兜底已执行（宿主=${hostPid || 'n/a'} 存根=${childPid || 'n/a'}）`);
      return { closed: !windowStill && !hostAlive && !childAlive, forced, hostPid, windowStill, hostAlive, notes };
    },
  };
}

const fixtureClose = createFixtureClose();

module.exports = { launchAppFixture, attachFixtureWindow, createFixtureClose, fixtureClose };
