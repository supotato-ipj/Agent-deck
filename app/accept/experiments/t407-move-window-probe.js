'use strict';
/**
 * 工单407 真机探针（迁移面）：跨进程把窗口移动到目标虚拟桌面的可用路径取证。
 *
 * 背景：t407-title-drag-probe 已证 MOVESIZE 观察面成立；工单407 生产首轮
 * （375 P10）实证公开 IVirtualDesktopManager::MoveWindowToDesktop 对**他进程窗**
 * 返回 E_ACCESSDENIED（0x80070005）——公开面迁移不可用。本探针按 MScholtes
 * VirtualDesktop11-24H2 接口布局（与 t371 已实证的 VDMI 槽位同源推导：
 * GetCount=3 / MoveViewToDesktop=4 / GetCurrent=6 / GetDesktops=7 / Switch=9 /
 * Create=11 / Remove=13）证明内部路径：
 *
 *   IApplicationViewCollection（IID 1841C6D7-4F9D-42C0-AF41-8747538F10E5，
 *   QueryService 双参同 IID）::GetViewForHwnd（槽 6）→ IApplicationView，
 *   VDMI::MoveViewToDesktop（槽 4，view + desktop 指针）→ 公开
 *   GetWindowDesktopId 回读确认。
 *
 * 断言面（前拖动后前台窗——生产拖入事务的实况形态）：
 *   ① GetViewForHwnd 对他进程顶层窗可取 view；
 *   ② MoveViewToDesktop 受理（hr=0）且公开回读 = 目标桌面（迁移真发生）；
 *   ③ 收尾零残留：临时桌面删除、注册表集合与基线相等。
 *
 * 用法（**必须经 accept-guard 托管**）：
 *   node D:\test-folder\.accept-guard\guard.mjs hold --as zcode --purpose selftest -- \
 *     node app\accept\experiments\t407-move-window-probe.js
 *
 * 退出码：0 = 断言全过；1 = 有断言不成立；2 = 环境/时序问题。
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const win32 = require('../lib/win32');
const { SetForegroundWindow, BringWindowToTop } = win32;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(desc, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${desc}${detail ? ' —— ' + detail : ''}`;
  console.log(line);
  if (!ok) failures.push(desc);
}

// —— Win32/COM 绑定（T407M_ 前缀具名单登） ——
const koffi = win32.koffi;
const ole32 = koffi.load('ole32.dll');
koffi.struct('T407M_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)');
const CLSIDFromString = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T407M_GUID *clsid)');
const CoCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(const T407M_GUID *clsid, void *outer, uint32 clsCtx, const T407M_GUID *iid, _Out_ void **outObj)');
const user32 = koffi.load('user32.dll');
koffi.struct('T407M_POINT', { x: 'long', y: 'long' });
const GetCursorPosM = user32.func('bool __stdcall GetCursorPos(_Out_ T407M_POINT *pt)');

const protoQS = koffi.proto('__stdcall', 'T407M_QueryService', 'int32', ['void *', 'const T407M_GUID *', 'const T407M_GUID *', koffi.out('void **')]);
const protoCreate = koffi.proto('__stdcall', 'T407M_Create', 'int32', ['void *', koffi.out('void **')]);
const protoRemove = koffi.proto('__stdcall', 'T407M_Remove', 'int32', ['void *', 'void *', 'void *']);
const protoGetId = koffi.proto('__stdcall', 'T407M_GetId', 'int32', ['void *', koffi.out('T407M_GUID *')]);
const protoArrCount = koffi.proto('__stdcall', 'T407M_ArrCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoArrGet = koffi.proto('__stdcall', 'T407M_ArrGet', 'int32', ['void *', 'int32', 'const T407M_GUID *', koffi.out('void **')]);
const protoMoveView = koffi.proto('__stdcall', 'T407M_MoveView', 'int32', ['void *', 'void *', 'void *']);
const protoGetViewForHwnd = koffi.proto('__stdcall', 'T407M_GetViewForHwnd', 'int32', ['void *', 'uintptr_t', koffi.out('void **')]);
const protoGetDesktops = koffi.proto('__stdcall', 'T407M_GetDesktops', 'int32', ['void *', koffi.out('void **')]);
const protoWinDesktopId = koffi.proto('__stdcall', 'T407M_WinDesktopId', 'int32', ['void *', 'uintptr_t', koffi.out('T407M_GUID *')]);
const protoRel = koffi.proto('__stdcall', 'T407M_Rel', 'uint32', ['void *']);

const CLSID = {
  immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239',
  vdmi: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B',
  vdm: 'AA509086-5CA9-4C25-8F95-589D3C07B48A',
  serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA',
  viewCollection: '1841C6D7-4F9D-42C0-AF41-8747538F10E5',
};
const IID = {
  vdmi_24H2: '53F5CA0B-158F-4124-900C-057158060B27',
  vdm: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B',
  virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C',
};

const PS = 8;
const slot = (o, i) => koffi.decode(koffi.decode(o, 'void *'), i * PS, 'void *');
const g = (s) => { const o = [null]; if (CLSIDFromString('{' + s + '}', o) !== 0) throw new Error(`CLSIDFromString(${s}) 失败`); return o[0]; };
const gs = (q) => {
  if (!q || !q.d4) return '';
  const p = (n, w) => n.toString(16).padStart(w, '0');
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i]);
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`;
};
const rel = (o) => { try { if (o) koffi.call(slot(o, 2), protoRel, o); } catch { /* 尽力 */ } };

function regDesktopFacts() {
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops'], { encoding: 'utf8' });
    const idsM = out.match(/VirtualDesktopIDs\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    const hexIds = idsM ? idsM[1].toUpperCase() : '';
    const ids = [];
    for (let off = 0; off + 32 <= hexIds.length; off += 32) {
      const b = [];
      for (let i = 0; i + 2 <= 32; i += 2) b.push(parseInt(hexIds.slice(off + i, off + i + 2), 16));
      const p = (n) => n.toString(16).padStart(2, '0');
      const swap = (arr) => arr.slice().reverse().map((x) => p(x)).join('');
      ids.push(`${swap(b.slice(0, 4))}-${swap(b.slice(4, 6))}-${swap(b.slice(6, 8))}-${b.slice(8, 10).map((x) => p(x)).join('')}-${b.slice(10, 16).map((x) => p(x)).join('')}`);
    }
    return ids.filter(Boolean);
  } catch { return []; }
}

async function main() {
  let probe = null;
  let probeChild = null;
  let exitCode = 0;
  try {
    const hrInit = CoInitializeEx(null, 0);
    if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx 失败 hr=${hrInit}`);
    const shell = [null];
    if (CoCreateInstance(g(CLSID.immersiveShell), null, 1 | 4, g(CLSID.serviceProvider), shell) !== 0 || !shell[0]) throw new Error('ImmersiveShell 创建失败');
    const vdmi = [null];
    const hrVdmi = koffi.call(slot(shell[0], 3), protoQS, shell[0], g(CLSID.vdmi), g(IID.vdmi_24H2), vdmi);
    const viewColl = [null];
    const hrViewColl = koffi.call(slot(shell[0], 3), protoQS, shell[0], g(CLSID.viewCollection), g(CLSID.viewCollection), viewColl);
    rel(shell[0]);
    if (hrVdmi !== 0 || !vdmi[0]) throw new Error(`VDMI QueryService 失败 hr=0x${(hrVdmi >>> 0).toString(16)}（IID 漂移）`);
    if (hrViewColl !== 0 || !viewColl[0]) throw new Error(`ApplicationViewCollection QueryService 失败 hr=0x${(hrViewColl >>> 0).toString(16)}`);
    const vdm = [null];
    if (CoCreateInstance(g(CLSID.vdm), null, 1, g(IID.vdm), vdm) !== 0 || !vdm[0]) throw new Error('公开 VDM 创建失败');

    const desktops = () => {
      const arr = [null];
      if (koffi.call(slot(vdmi[0], 7), protoGetDesktops, vdmi[0], arr) !== 0 || !arr[0]) return [];
      try {
        const n = [0];
        koffi.call(slot(arr[0], 3), protoArrCount, arr[0], n);
        const out = [];
        for (let i = 0; i < n[0]; i++) {
          const d = [null];
          if (koffi.call(slot(arr[0], 4), protoArrGet, arr[0], i, g(IID.virtualDesktop), d) !== 0 || !d[0]) continue;
          const gid = [null];
          if (koffi.call(slot(d[0], 4), protoGetId, d[0], gid) === 0) out.push({ ptr: d[0], id: gs(gid[0]) });
          else rel(d[0]);
        }
        return out;
      } finally { rel(arr[0]); }
    };
    const desktopOf = (hwnd) => {
      const gid = [null];
      if (koffi.call(slot(vdm[0], 4), protoWinDesktopId, vdm[0], hwnd, gid) !== 0) return null;
      const id = gs(gid[0]);
      return id && !/^0{8}-/.test(id) ? id : null;
    };

    // 夹具：csc WinForms 探针窗（他进程真实窗口，前置前台——生产拖入实况形态）
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const csc = path.join(sysRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    if (!fs.existsSync(csc)) throw new Error('csc.exe 缺失（.NET Framework4.x）——环境问题');
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'deck-t407m-'));
    const csFile = path.join(tmpDir, 'probe.cs');
    fs.writeFileSync(csFile, `
using System;
using System.Drawing;
using System.Windows.Forms;
static class Probe {
  [STAThread]
  static void Main() {
    Form f = new Form();
    f.Text = "t407 move-window probe";
    f.StartPosition = FormStartPosition.Manual;
    f.Bounds = new Rectangle(100, 100, 360, 240);
    Application.Run(f);
  }
}
`, 'utf8');
    const exe = path.join(tmpDir, 'DECK-T407M-PROBE.exe');
    const built = spawnSync(csc, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', `/out:${exe}`, csFile], { encoding: 'utf8' });
    if (built.status !== 0 || !fs.existsSync(exe)) throw new Error(`探针编译失败 status=${built.status}`);
    probe = { tmpDir, exe };
    probeChild = spawn(exe, [], { stdio: 'ignore' });
    let hwnd = 0;
    const target = String(exe).replace(/\//g, '\\').toLowerCase();
    for (let i = 0; i < 50 && !hwnd; i++) {
      for (const h of win32.topLevelWindows()) {
        if (!win32.IsWindowVisible(h)) continue;
        const wExe = String(win32.exeOfPid(win32.threadIdOf(h).pid) || '').replace(/\//g, '\\').toLowerCase();
        if (wExe === target) { hwnd = h; break; }
      }
      if (!hwnd) await sleep(120);
    }
    if (!hwnd) throw new Error('探针窗未出现——环境问题');
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    await sleep(400);

    // 临时目标桌面（CreateDesktop=槽 11；收尾 RemoveDesktop=槽 13 零残留）
    const baseIds = regDesktopFacts();
    const tmpPtr = [null];
    const hrCreate = koffi.call(slot(vdmi[0], 11), protoCreate, vdmi[0], tmpPtr);
    if (hrCreate !== 0 || !tmpPtr[0]) throw new Error(`CreateDesktop 失败 hr=0x${(hrCreate >>> 0).toString(16)}`);
    const gidT = [null];
    koffi.call(slot(tmpPtr[0], 4), protoGetId, tmpPtr[0], gidT);
    const tmpId = gs(gidT[0]);

    // ① GetViewForHwnd（IApplicationViewCollection 槽 6）
    const view = [null];
    const hrView = koffi.call(slot(viewColl[0], 6), protoGetViewForHwnd, viewColl[0], hwnd, view);
    check('① GetViewForHwnd 对他进程顶层窗可取 view', hrView === 0 && !!view[0],
      `hr=0x${(hrView >>> 0).toString(16)} view=${view[0] ? '在场' : '缺席'}`);

    // ② MoveViewToDesktop（VDMI 槽 4）→ 公开 GetWindowDesktopId 回读 = 目标
    let moved = false;
    if (view[0]) {
      const target2 = desktops().find((d) => d.id === tmpId);
      const hrMove = koffi.call(slot(vdmi[0], 4), protoMoveView, vdmi[0], view[0], target2 ? target2.ptr : null);
      if (target2) rel(target2.ptr);
      rel(view[0]);
      let after = desktopOf(hwnd);
      for (let i = 0; i < 15 && after !== tmpId; i++) { await sleep(120); after = desktopOf(hwnd); }
      moved = after === tmpId;
      check('② MoveViewToDesktop 受理且公开回读 = 目标桌面（跨进程移动路径成立）',
        hrMove === 0 && moved,
        `hr=0x${(hrMove >>> 0).toString(16)} 回读=${after ? after.slice(0, 8) : 'null'} 目标=${tmpId.slice(0, 8)}`);
    }

    // ③ 收尾零残留：删临时桌面（RemoveDesktop 传桌面对象指针 + 回退桌面指针）
    const allNow = desktops();
    const tmpObj = allNow.find((d) => d.id === tmpId);
    const fb = allNow.find((d) => d.id !== tmpId);
    const hrRemove = koffi.call(slot(vdmi[0], 13), protoRemove, vdmi[0], tmpObj ? tmpObj.ptr : null, fb ? fb.ptr : null);
    if (tmpObj) rel(tmpObj.ptr);
    if (fb) rel(fb.ptr);
    await sleep(300);
    const afterIds = regDesktopFacts();
    const zeroResidue = hrRemove === 0 && afterIds.length === baseIds.length
      && baseIds.every((x) => afterIds.includes(x));
    check('③ 收尾零残留：临时桌面删除（注册表集合与基线相等）', zeroResidue,
      `hr=0x${(hrRemove >>> 0).toString(16)} 集合=${afterIds.length}/${baseIds.length}`);
    rel(tmpPtr[0]);
    rel(vdmi[0]); rel(viewColl[0]); rel(vdm[0]);
    exitCode = failures.length === 0 ? 0 : 1;
  } catch (err) {
    console.log(`探针异常（本轮未取到证据，按环境问题处理）: ${err && err.stack || err}`);
    exitCode = 2;
  } finally {
    if (probeChild) spawnSync('taskkill', ['/PID', String(probeChild.pid), '/T', '/F'], { stdio: 'ignore' });
    if (probe) { try { fs.rmSync(probe.tmpDir, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  }
  console.log(`—— t407-move-window 探针结论：${exitCode === 0 ? 'GO（内部移动路径成立）' : exitCode === 1 ? 'NO-GO（有断言不成立）' : '环境问题（未取证）'} ——`);
  return exitCode;
}

Promise.resolve(main()).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
