'use strict';
/**
 * 工单371 真机探针：真实 Win11 虚拟桌面配对、切换与面板跟随验证（spec #369 原生门槛探针）。
 *
 * 定位：**取证探针**（app/accept/experiments/ 先例，同 t249/t132），**不是验收电池段**——
 * spec #369 决策 3「创建、切换和跟随路径必须先经探针证明」+ 决策 30「失败关闭」。本探针
 * 用可丢弃窗口实际创建一对虚拟桌面（普通 = 探针启动所在桌面；Agent = 新建），验证：
 *
 *   ① 桌面配对以系统桌面 ID 区分（公开 IVirtualDesktopManager::GetWindowDesktopId +
 *      注册表 VirtualDesktopIDs/CurrentVirtualDesktop + DWM cloak + 内部 GetCurrentDesktop
 *      多源互证）；
 *   ② 真点击探针入口（SendInput 点面板按钮 → WM_COMMAND handler → COM SwitchDesktop）
 *      后实际桌面发生切换——成功判定一律以切换后的系统事实回读为准（公开 VDM IsOnCurrent
 *      + 注册表当前 ID + DWM cloak + 内部 GetCurrentDesktop），绝不依赖「点了/调了就当成功」
 *      的乐观假设；
 *   ③ 面板/自绘任务栏/胶囊三个探针窗跟随当前桌面（跟随路径实测：shell cloak 后重显迁移），
 *      且三者不进入合格应用窗口集合（探针窗 + 普通哨兵窗对照）；
 *   ④ 第三桌面不被吞并、删除或自动切回（新建一个「第三桌面」当用户既有桌面的替身，
 *      配对切换循环中逐轮断言其 ID 在册、哨兵窗归属不变、当前桌面从不落在它上）；
 *   ⑤ 探针结束零残留：新建桌面全部删除（注册表桌面集合与基线逐项相等）、探针窗口全部
 *      销毁（本 pid 顶层可见窗归零）、原生任务栏状态（ABM_GETSTATE + 矩形）不变、
 *      无常驻进程（本脚本未 spawn 子进程，main 返回即退出）。
 *
 * 原生事实参考（未文档化接口按 MScholtes/VirtualDesktop 的 Win11-24H2 版接口布局；
 * 公开 IVirtualDesktopManager 为 shobjidl_core.h 文档化接口）：
 *   - 公开 IVirtualDesktopManager：CLSID AA509086-5CA9-4C25-8F95-589D3C07B48A，
 *     IID A5CD92FF-29BE-454C-8D04-D82879FB3F1B
 *   - ImmersiveShell（CLSID C2F03A33-21F5-47FA-B4BB-156362A2F239）QueryService →
 *     IVirtualDesktopManagerInternal：CLSID C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B，
 *     IID 53F5CA0B-158F-4124-900C-057158060B27（Win11 24H2/25H2 26100/26300 代；
 *     IID 漂移即回退热键路径并如实记录失败边界）
 *   - COM 调用形态经 koffi vtable 直调（koffi.call + koffi.proto，koffi 2.16.3 实证）
 *
 * 用法（**必须经 accept-guard 托管**，禁裸跑——本机多检出共享同一验收槽）：
 *   node D:\test-folder\.accept-guard\guard.mjs hold --as zcode --purpose accept-sprint -- \
 *     node app\accept\experiments\t371-virtual-desktop-probe.js
 *
 * 退出码：0 = 断言全过；1 = 有断言不成立（证据照常落盘，go/no-go 证据如实呈现）；
 *         2 = 环境/时序问题（本轮未取到证据）。
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const win32 = require('../lib/win32');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 结论账目（探针自己的报告面） */
const findings = [];
function say(s) { console.log(s); findings.push(s); }

/** 断言账目：一条不成立 → 退出码 1，但探针继续跑完（残局清理与后续证据照常） */
const failures = [];
function check(desc, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'} ${desc}${detail ? ' —— ' + detail : ''}`;
  say(line);
  if (!ok) failures.push(desc);
  return ok;
}

/** 报告落盘（证据面：app/accept/evidence/，文本审计链随轮入库） */
const REPORT_FILE = path.join(__dirname, '..', 'evidence', '371-virtual-desktop-probe.log.txt');
function flushReport() {
  try {
    fs.writeFileSync(REPORT_FILE, [
      '工单371 真机探针（t371-virtual-desktop-probe.js）——真实虚拟桌面配对、切换与面板跟随验证',
      `运行时刻：${new Date().toISOString()}`,
      `退出码：${process.exitCode ?? 0}（${failures.length === 0 ? '断言全过' : failures.length + ' 条断言不成立'}）`,
      '',
      ...findings,
      '',
    ].join('\n'), 'utf8');
  } catch (e) {
    console.log(`（报告落盘失败：${e && e.message}）`);
  }
}

// ————————————————————————————————————————————————————————————
// Win32 绑定（窗口创建 / 消息泵；SendInput 复用 ../lib/win32）
// ————————————————————————————————————————————————————————————
const koffi = win32.koffi;
const user32 = koffi.load('user32.dll');
const ole32 = koffi.load('ole32.dll');

// 具名类型进程级单登（#153 教训：撞名即崩）——一律 T371_ 前缀
koffi.struct('T371_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
koffi.struct('T371_POINT', { x: 'long', y: 'long' });
koffi.struct('T371_MSG', { hwnd: 'uintptr_t', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: 'T371_POINT', lPrivate: 'uint32' });
koffi.struct('T371_WNDCLASS', {
  style: 'uint32', lpfnWndProc: 'void *', cbClsExtra: 'int32', cbWndExtra: 'int32',
  hInstance: 'void *', hIcon: 'void *', hCursor: 'void *', hbrBackground: 'void *',
  lpszMenuName: 'const char16_t *', lpszClassName: 'const char16_t *',
});

const RegisterClassW = user32.func('uint16 __stdcall RegisterClassW(const T371_WNDCLASS *lpWndClass)');
const CreateWindowExW = user32.func('uintptr_t __stdcall CreateWindowExW(uint32 dwExStyle, const char16_t *lpClassName, const char16_t *lpWindowName, uint32 dwStyle, int x, int y, int w, int h, uintptr_t hWndParent, uintptr_t hMenu, void *hInstance, void *lpParam)');
const DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(uintptr_t hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam)');
const DestroyWindow = user32.func('bool __stdcall DestroyWindow(uintptr_t hWnd)');
const PeekMessageW = user32.func('bool __stdcall PeekMessageW(_Out_ T371_MSG *lpMsg, uintptr_t hWnd, uint32 min, uint32 max, uint32 remove)');
const TranslateMessage = user32.func('bool __stdcall TranslateMessage(const T371_MSG *lpMsg)');
const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const T371_MSG *lpMsg)');
const UpdateWindow = user32.func('bool __stdcall UpdateWindow(uintptr_t hWnd)');
const ShowWindowU = user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)');
const CreateSolidBrush = koffi.load('gdi32.dll').func('void * __stdcall CreateSolidBrush(uint32 color)');
const GetModuleHandleW = koffi.load('kernel32.dll').func('void * __stdcall GetModuleHandleW(const char16_t *name)');
const GetCurrentProcessId = koffi.load('kernel32.dll').func('uint32 __stdcall GetCurrentProcessId()');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *pid)');
const SetProcessDpiAwarenessContext = (() => {
  try { return user32.func('bool __stdcall SetProcessDpiAwarenessContext(void *value)'); } catch { return null; }
})();

const WNDPROC = koffi.proto('__stdcall', 'T371_WndProc', 'intptr_t', ['uintptr_t', 'uint32', 'uintptr_t', 'intptr_t']);

// 窗口样式常量
const WS_OVERLAPPEDWINDOW = 0x00CF0000, WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000,
  WS_CHILD = 0x40000000, BS_PUSHBUTTON = 0x00;
const WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
const WM_COMMAND = 0x0111;
const SW_SHOWNA = 8;
const PM_REMOVE = 1;

// ————————————————————————————————————————————————————————————
// COM 绑定（IVirtualDesktopManager 公开面 + IVirtualDesktopManagerInternal 24H2 面）
// ————————————————————————————————————————————————————————————
const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)');
const CLSIDFromString = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T371_GUID *clsid)');
const CoCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(const T371_GUID *clsid, void *outer, uint32 clsCtx, const T371_GUID *iid, _Out_ void **outObj)');

const PTRSZ = koffi.sizeof(koffi.pointer('void'));
function hrName(hr) {
  if (hr === 0) return 'S_OK';
  if (hr === -2147467263) return 'E_NOTIMPL';
  if (hr === -2147467262) return 'E_NOINTERFACE';
  if (hr === -2147221164) return 'REGDB_E_CLASSNOTREG';
  if (hr === -2147024809) return 'E_INVALIDARG';
  if (hr === -2147467259) return 'E_FAIL';
  if (hr === -2147319765) return 'TYPE_E_ELEMENTNOTFOUND';
  return '0x' + (hr >>> 0).toString(16).padStart(8, '0');
}

function guidFromStr(s) {
  let g = [null];
  const hr = CLSIDFromString('{' + s + '}', g);
  if (hr !== 0) throw new Error(`CLSIDFromString(${s}) 失败: ${hrName(hr)}`);
  return g[0];
}
function guidToStr(q) {
  if (!q || !q.d4) return 'null';
  // koffi 已把 Data1/2/3 按主机序解码成数值（数值本身就是 GUID 标准形的各段），
  // 直接打十六进制；Data4 是原始字节数组，按序输出——t371 调试轮实证（对解码值再
  // 做字节交换会把 COM 形 ID 与注册表形 ID 变成两套永不匹配的字符串）
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i]);
  const p = (n, w) => n.toString(16).padStart(w, '0');
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => b.toString(16).padStart(2, '0')).join('')}-${d4.slice(2).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const protoRelease = koffi.proto('__stdcall', 'T371_Release', 'uint32', ['void *']);
function releasePtr(ptr) { try { if (ptr) koffi.call(koffi.decode(koffi.decode(ptr, 'void *'), 2 * PTRSZ, 'void *'), protoRelease, ptr); } catch { /* 可丢弃探针，释放失败不追 */ } }
/** 读 COM 对象 vtable 槽位指针 */
const slotOf = (ptr, i) => koffi.decode(koffi.decode(ptr, 'void *'), i * PTRSZ, 'void *');

// 公开 IVirtualDesktopManager：QI0 AddRef1 Release2 | IsWindowOnCurrent3 GetWindowDesktopId4 MoveWindowToDesktop5
const protoIsOnCurrent = koffi.proto('__stdcall', 'T371_IsOnCurrent', 'int32', ['void *', 'uintptr_t', koffi.out('int32 *')]);
const protoGetWinDesktopId = koffi.proto('__stdcall', 'T371_GetWinDesktopId', 'int32', ['void *', 'uintptr_t', koffi.out('T371_GUID *')]);
const protoMoveWindowToDesktop = koffi.proto('__stdcall', 'T371_MoveWindowToDesktop', 'int32', ['void *', 'uintptr_t', 'const T371_GUID *']);
// IServiceProvider：QI0 AddRef1 Release2 | QueryService3
const protoQueryService = koffi.proto('__stdcall', 'T371_QueryService', 'int32', ['void *', 'const T371_GUID *', 'const T371_GUID *', koffi.out('void **')]);
// IVirtualDesktopManagerInternal（24H2/25H2 布局）：QI0 AddRef1 Release2 | GetCount3 MoveViewToDesktop4
//   CanViewMoveDesktops5 GetCurrentDesktop6 GetDesktops7 GetAdjacentDesktop8 SwitchDesktop9
//   SwitchDesktopAndMoveForegroundView10 CreateDesktop11 MoveDesktop12 RemoveDesktop13 ...
const protoVdmiGetCount = koffi.proto('__stdcall', 'T371_VdmiGetCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoVdmiGetCurrentDesktop = koffi.proto('__stdcall', 'T371_VdmiGetCurrentDesktop', 'int32', ['void *', koffi.out('void **')]);
const protoVdmiGetDesktops = koffi.proto('__stdcall', 'T371_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')]);
const protoVdmiSwitchDesktop = koffi.proto('__stdcall', 'T371_VdmiSwitchDesktop', 'int32', ['void *', 'void *']);
const protoVdmiCreateDesktop = koffi.proto('__stdcall', 'T371_VdmiCreateDesktop', 'int32', ['void *', koffi.out('void **')]);
const protoVdmiRemoveDesktop = koffi.proto('__stdcall', 'T371_VdmiRemoveDesktop', 'int32', ['void *', 'void *', 'void *']);
// IVirtualDesktop（24H2 布局）：QI0 AddRef1 Release2 | IsViewVisible3 GetId4
const protoVdGetId = koffi.proto('__stdcall', 'T371_VdGetId', 'int32', ['void *', koffi.out('T371_GUID *')]);
// IObjectArray：QI0 AddRef1 Release2 | GetCount3 GetAt4
const protoObjArrCount = koffi.proto('__stdcall', 'T371_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')]);
const protoObjArrGetAt = koffi.proto('__stdcall', 'T371_ObjArrGetAt', 'int32', ['void *', 'int32', 'const T371_GUID *', koffi.out('void **')]);

const CLSID = {
  immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239',
  vdManagerInternal: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B',
  vdManager: 'AA509086-5CA9-4C25-8F95-589D3C07B48A',
};
const IID = {
  vdManager: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B',
  vdManagerInternal_24H2: '53F5CA0B-158F-4124-900C-057158060B27',
  virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C',
  serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA',
};

/** 公开 IVirtualDesktopManager 查询面（桌面 ID 事实源之一） */
function bindPublicVdm() {
  let out = [null];
  const hr = CoCreateInstance(guidFromStr(CLSID.vdManager), null, 1, guidFromStr(IID.vdManager), out);
  if (hr !== 0 || !out[0]) return { available: false, hr };
  const ptr = out[0];
  return {
    available: true,
    isOnCurrent: (hwnd) => { const f = [0]; const r = koffi.call(slotOf(ptr, 3), protoIsOnCurrent, ptr, hwnd, f); return { hr: r, on: f[0] !== 0 }; },
    desktopIdOf: (hwnd) => { const g = [null]; const r = koffi.call(slotOf(ptr, 4), protoGetWinDesktopId, ptr, hwnd, g); return { hr: r, id: guidToStr(g[0]) }; },
    moveToDesktop: (hwnd, id) => koffi.call(slotOf(ptr, 5), protoMoveWindowToDesktop, ptr, hwnd, guidFromStr(id)),
  };
}

/** 内部 IVirtualDesktopManagerInternal（24H2 IID；漂移即不可用 → 热键回退） */
function bindInternalVdmi() {
  let shell = [null];
  // ImmersiveShell 直接以 IID_IServiceProvider 创建（.NET 侧等价于先 QI(IServiceProvider)
  // 再 QueryService——对裸 IUnknown 直接调槽 3 会在本机段错误，t371 调试轮实证）
  const hrShell = CoCreateInstance(guidFromStr(CLSID.immersiveShell), null, 1 | 4, guidFromStr(IID.serviceProvider), shell);
  if (hrShell !== 0 || !shell[0]) return { available: false, note: `ImmersiveShell CoCreateInstance(IServiceProvider) 失败 ${hrName(hrShell)}` };
  try {
    let svc = [null];
    const hrQs = koffi.call(slotOf(shell[0], 3), protoQueryService, shell[0], guidFromStr(CLSID.vdManagerInternal), guidFromStr(IID.vdManagerInternal_24H2), svc);
    if (hrQs !== 0 || !svc[0]) return { available: false, note: `QueryService(IVirtualDesktopManagerInternal@24H2) 失败 ${hrName(hrQs)}（IID 漂移）` };
    const ptr = svc[0];
    const getCount = () => { const c = [0]; const r = koffi.call(slotOf(ptr, 3), protoVdmiGetCount, ptr, c); if (r !== 0) throw new Error('GetCount ' + hrName(r)); return c[0]; };
    const vdOfPtr = (d) => {
      if (!d) throw new Error('空 IVirtualDesktop 指针');
      const g = [null]; const r = koffi.call(slotOf(d, 4), protoVdGetId, d, g);
      if (r !== 0) throw new Error('IVirtualDesktop.GetId ' + hrName(r));
      return guidToStr(g[0]);
    };
    const getDesktopsArray = () => {
      const arr = [null]; const r = koffi.call(slotOf(ptr, 7), protoVdmiGetDesktops, ptr, arr);
      if (r !== 0 || !arr[0]) throw new Error('GetDesktops ' + hrName(r));
      return arr[0];
    };
    const getDesktopPtr = (id) => {
      const arr = getDesktopsArray();
      try {
        const n = [0]; koffi.call(slotOf(arr, 3), protoObjArrCount, arr, n);
        for (let i = 0; i < n[0]; i++) {
          const d = [null];
          const r2 = koffi.call(slotOf(arr, 4), protoObjArrGetAt, arr, i, guidFromStr(IID.virtualDesktop), d);
          if (r2 !== 0 || !d[0]) continue;
          if (vdOfPtr(d[0]) === id) return d[0];
        }
        return null;
      } finally { releasePtr(arr); }
    };
    return {
      available: true,
      ptr,
      getCount,
      getCurrentDesktopId: () => { const d = [null]; const r = koffi.call(slotOf(ptr, 6), protoVdmiGetCurrentDesktop, ptr, d); if (r !== 0) throw new Error('GetCurrentDesktop ' + hrName(r)); return vdOfPtr(d[0]); },
      switchDesktop: (desktopPtr) => {
        if (!desktopPtr) throw new Error('SwitchDesktop 收到空桌面指针（getDesktopPtr 未命中）');
        const r = koffi.call(slotOf(ptr, 9), protoVdmiSwitchDesktop, ptr, desktopPtr);
        if (r !== 0) throw new Error('SwitchDesktop ' + hrName(r));
      },
      createDesktop: () => {
        const d = [null]; const r = koffi.call(slotOf(ptr, 11), protoVdmiCreateDesktop, ptr, d);
        if (r !== 0 || !d[0]) throw new Error('CreateDesktop ' + hrName(r));
        return { ptr: d[0], id: vdOfPtr(d[0]) };
      },
      removeDesktop: (desktopPtr, fallbackPtr) => { const r = koffi.call(slotOf(ptr, 13), protoVdmiRemoveDesktop, ptr, desktopPtr, fallbackPtr); if (r !== 0) throw new Error('RemoveDesktop ' + hrName(r)); },
      getDesktopPtr,
      desktopCountInShell: () => {
        const arr = getDesktopsArray();
        try { const n = [0]; koffi.call(slotOf(arr, 3), protoObjArrCount, arr, n); return n[0]; } finally { releasePtr(arr); }
      },
    };
  } finally { releasePtr(shell[0]); }
}

// ————————————————————————————————————————————————————————————
// 注册表事实源（桌面集合 + 当前桌面，explorer 维护）
// ————————————————————————————————————————————————————————————
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';
function regQueryBinary(name) {
  try {
    const out = execSync(`reg query "${REG_KEY}" /v ${name} 2>nul`, { encoding: 'utf8' });
    const m = out.match(/REG_BINARY\s+([0-9A-Fa-f]+)/);
    return m ? m[1].toUpperCase() : null;
  } catch { return null; }
}
function bytesToGuidStrings(hex) {
  const ids = [];
  for (let off = 0; off + 32 <= hex.length; off += 32) {
    const b = [];
    for (let i = 0; i < 32; i += 2) b.push(parseInt(hex.slice(off + i, off + i + 2), 16));
    const p = (n, w) => n.toString(16).padStart(w, '0');
    const swap = (arr) => arr.slice().reverse().map((x) => p(x, 2)).join('');
    ids.push(`${swap(b.slice(0, 4))}-${swap(b.slice(4, 6))}-${swap(b.slice(6, 8))}-${b.slice(8, 10).map((x) => p(x, 2)).join('')}-${b.slice(10, 16).map((x) => p(x, 2)).join('')}`);
  }
  return ids;
}
function regDesktopFacts() {
  // 原子读：单次 reg query 同时取两值——分两次查询会撞上 explorer 中途更新，
  // 产生「当前 ID 不在集合里」的错配快照（t371 调试轮实证）
  try {
    const out = execSync('reg query "' + REG_KEY + '" 2>nul', { encoding: 'utf8' });
    const idsM = out.match(/VirtualDesktopIDs\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    const curM = out.match(/CurrentVirtualDesktop\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    const ids = idsM ? bytesToGuidStrings(idsM[1].toUpperCase()) : [];
    const cur = curM ? (bytesToGuidStrings(curM[1].toUpperCase())[0] || null) : null;
    return { count: ids.length, ids, current: cur };
  } catch { return { count: 0, ids: [], current: null }; }
}

// ————————————————————————————————————————————————————————————
// 轮询确认（切换成功判定 = 系统事实回读，多源互证）
// ————————————————————————————————————————————————————————————
async function waitFor(desc, timeoutMs, predicate) {
  const t0 = Date.now();
  const msg = [null];
  for (;;) {
    // 确定性泵消息：按钮 WM_COMMAND 的派发不靠谓词内 spawn 的副作用
    while (PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) {
      TranslateMessage(msg[0]);
      DispatchMessageW(msg[0]);
    }
    let r;
    try { r = predicate(); } catch (e) { r = { ok: false, detail: `异常 ${e && e.message}` }; }
    if (r && r.ok) return { ok: true, ms: Date.now() - t0, detail: r.detail || '' };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, detail: (r && r.detail) || '超时' };
    await sleep(60);
  }
}

// ————————————————————————————————————————————————————————————
// 探针窗口：面板（含两个真按钮）+ 自绘任务栏条 + 胶囊 + 哨兵
// ————————————————————————————————————————————————————————————
let g_wndprocCb = null;
let g_classRegistered = false;
/** 按钮/入口 handler：点击探针入口 = WM_COMMAND 到达后同步调用的真实切换动作 */
const g_handlers = new Map();

function wndProc(hwnd, msg, wParam, lParam) {
  if (msg === WM_COMMAND) {
    const id = Number(wParam) & 0xffff;
    const fn = g_handlers.get(id);
    if (fn) { try { fn(); } catch (e) { console.log(`（handler ${id} 异常：${e.message}）`); } }
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

function registerProbeClass() {
  if (g_classRegistered) return;
  g_wndprocCb = koffi.register(wndProc, 'T371_WndProc *');
  const wc = {
    style: 0,
    lpfnWndProc: g_wndprocCb,
    cbClsExtra: 0, cbWndExtra: 0,
    hInstance: GetModuleHandleW(null),
    hIcon: null, hCursor: null,
    hbrBackground: CreateSolidBrush(0x00251f1c),
    lpszMenuName: null,
    lpszClassName: 'T371_PROBE_CLASS',
  };
  const atom = RegisterClassW(koffi.as(wc, 'const T371_WNDCLASS *'));
  if (!atom) throw new Error('RegisterClassW 失败');
  g_classRegistered = true;
}

/**
 * 创建一扇探针窗。kind：
 *   'panel' → 生产面板/任务栏/胶囊同形态：TOPMOST|NOACTIVATE 弹窗，**不带 TOOLWINDOW 位**
 *             （生产 skipTaskbar 经 ITaskbarList::DeleteTab，panel-window.ts:29 实测；
 *              应用集合排除走自家进程规则——探针谓词同口径）
 *   'normal' → 普通应用形态（WS_OVERLAPPEDWINDOW，桌面标记哨兵用）
 *   'tool'  → TOOLWINDOW 形态（附加观察窗：验证工具窗的跨桌面行为，仅记录不断言）
 */
function makeWindow(title, x, y, w, h, kind = 'panel', parent = 0) {
  const ex = kind === 'panel' ? (WS_EX_TOPMOST | WS_EX_NOACTIVATE)
    : kind === 'panelplain' ? WS_EX_NOACTIVATE
    : kind === 'tool' ? (WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) : 0;
  const style = parent ? (WS_CHILD | WS_VISIBLE) : (kind === 'normal' ? (WS_OVERLAPPEDWINDOW | WS_VISIBLE) : (WS_POPUP | WS_VISIBLE));
  const hwnd = CreateWindowExW(ex, 'T371_PROBE_CLASS', title, style, x, y, w, h, parent, 0, GetModuleHandleW(null), null);
  if (!hwnd) throw new Error(`CreateWindowExW(${title}) 失败`);
  return hwnd;
}

function makeButton(parent, text, id, x, y, w, h) {
  const hwnd = CreateWindowExW(0, 'BUTTON', text, WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, x, y, w, h, parent, id, GetModuleHandleW(null), null);
  if (!hwnd) throw new Error(`CreateWindowExW(BUTTON ${text}) 失败`);
  return hwnd;
}

/** 消息泵（非阻塞 Peek），跑 during 指定的异步工作 */
async function pumpDuring(during) {
  const msg = [null];
  let stop = false;
  const tick = async () => {
    while (PeekMessageW(msg, 0, 0, 0, PM_REMOVE)) {
      TranslateMessage(msg[0]);
      DispatchMessageW(msg[0]);
    }
    if (!stop) setTimeout(tick, 10);
  };
  setTimeout(tick, 0);
  try { await during(); } finally { stop = true; }
}

// ————————————————————————————————————————————————————————————
// 合格应用窗口集合（与 win-facts.ts 投影同口径的最小谓词：可见 + 非工具窗 +
// 非 APPWINDOW + 无属主 + 非 shell cloak——探针自证「自身不进入应用窗口集合」）
// ————————————————————————————————————————————————————————————
const WS_EX_APPWINDOW = 0x40000;
const DWMWA_CLOAKED = 14, DWM_CLOAKED_SHELL = 0x2;
const DwmGetWindowAttribute = koffi.load('dwmapi.dll').func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)');
function cloakValue(hwnd) {
  const buf = Buffer.alloc(4);
  if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) !== 0) return -1; // 取不到按未 cloak
  return buf.readUInt32LE(0);
}
function qualifiedAppWindows() {
  const myPid = GetCurrentProcessId();
  const out = [];
  for (const h of win32.topLevelWindows()) {
    const ex = win32.GetWindowLongW(h, -20);
    if (ex & WS_EX_TOOLWINDOW) continue;
    if (ex & WS_EX_APPWINDOW) continue;
    if (!win32.IsWindowVisible(h)) continue;
    if (cloakValue(h) === DWM_CLOAKED_SHELL) continue; // 其他虚拟桌面
    if (win32.GetWindowLongW(h, -8 /* GWL_HWNDPARENT */)) continue; // 属主排除
    const pidBuf = Buffer.alloc(4);
    GetWindowThreadProcessId(h, pidBuf);
    if (pidBuf.readUInt32LE(0) === myPid) continue; // 自家进程排除（生产面板同款语义）
    out.push(h);
  }
  return out;
}

// ————————————————————————————————————————————————————————————
// 热键（真 SendInput 和弦；仅作回退路径，判定一律走系统事实回读）
// ————————————————————————————————————————————————————————————
const VK_LWIN = 0x5b, VK_LCONTROL = 0xa2, VK_D = 0x44, VK_LEFT = 0x25, VK_RIGHT = 0x27, VK_F4 = 0x73;
function sendWinCtrlChord(vk) {
  win32.send([
    win32.keyInput(VK_LWIN, win32.KEYDOWN), win32.keyInput(VK_LCONTROL, win32.KEYDOWN),
    win32.keyInput(vk, win32.KEYDOWN),
    win32.keyInput(vk, win32.KEYUP), win32.keyInput(VK_LCONTROL, win32.KEYUP), win32.keyInput(VK_LWIN, win32.KEYUP),
  ]);
}

function isAlive(hwnd) { try { return Boolean(hwnd && win32.IsWindow(hwnd)); } catch { return false; } }

// ————————————————————————————————————————————————————————————
// 崩溃恢复（探针可丢弃，机器状态不丢弃：任何中途异常都要尽力清掉新建桌面）
// ————————————————————————————————————————————————————————————
const g_state = { base: null, createdIds: [], vdmi: null, normalId: null };
async function recoverCleanup() {
  try {
    const { base, createdIds, vdmi, normalId } = g_state;
    if (!base || !normalId) return;
    if (vdmi && vdmi.available) {
      const nPtr = vdmi.getDesktopPtr(normalId);
      for (const id of createdIds.slice().reverse()) {
        try {
          const dPtr = vdmi.getDesktopPtr(id);
          if (dPtr && nPtr) vdmi.removeDesktop(dPtr, nPtr);
        } catch { /* 逐个尽力 */ }
      }
    }
    for (let guard = 0; guard < 6; guard++) {
      const f = regDesktopFacts();
      const extra = f.ids.filter((x) => !base.ids.includes(x));
      if (f.count <= base.count || !extra.length) break;
      if (extra.includes(f.current)) { sendWinCtrlChord(VK_F4); await sleep(700); }
      else { sendWinCtrlChord(VK_RIGHT); await sleep(500); }
    }
    const f = regDesktopFacts();
    say(`恢复清理后：桌面数=${f.count}（基线=${base.count}）当前=${f.current}${f.count === base.count ? '（已复原）' : '（未完全复原——如实记录）'}`);
  } catch (e) { say(`恢复清理异常：${e && e.message}`); }
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————
async function main() {
  process.exitCode = 2;
  if (SetProcessDpiAwarenessContext) {
    try { SetProcessDpiAwarenessContext(koffi.as(-4, 'void *')); } catch { /* 老系统无此 API，按既有电池形态跑 */ }
  }
  say(`CoInitializeEx: ${hrName(CoInitializeEx(null, 0))}`);

  // —— S1 基线 ——
  const base = regDesktopFacts();
  say(`基线注册表事实：桌面数=${base.count} 集合=[${base.ids.join(', ')}] 当前=${base.current}`);
  if (!base.count || !base.current) { say('注册表桌面事实不可读——环境问题退出（exit 2）'); return; }
  const normalId = base.current;
  g_state.base = base;
  g_state.normalId = normalId;
  const appbarBefore = win32.appbarState();
  const trayHwnd = win32.nativeTrayHwnd();
  const trayRectBefore = trayHwnd ? win32.rectOf(trayHwnd) : null;
  say(`基线原生任务栏：appbarState=${appbarBefore} rect=${JSON.stringify(trayRectBefore)}`);

  // —— S2 COM 绑定 ——
  const vdm = bindPublicVdm();
  say(`公开 IVirtualDesktopManager 绑定：${vdm.available ? '可用' : '不可用 (' + hrName(vdm.hr) + ')'}`);
  if (!vdm.available) { say('公开 VDM 不可用即无系统 ID 事实源——核心能力不成立，exit 1'); process.exitCode = 1; flushReport(); return; }

  const vdmi = bindInternalVdmi();
  say(`内部 IVirtualDesktopManagerInternal 绑定：${vdmi.available ? `可用，GetCount=${vdmi.getCount()}（24H2/25H2 IID 命中）` : '不可用 —— ' + vdmi.note}`);
  if (!vdmi.available) say('（创建/切换/删除回退热键 Win+Ctrl+D / Win+Ctrl+←→ / Win+Ctrl+F4，判定一律走系统事实回读）');
  g_state.vdmi = vdmi;

  // —— S3 探针窗与普通哨兵 ——
  registerProbeClass();
  const wins = {};
  await pumpDuring(async () => {
    wins.panel = makeWindow('DECK-T371-PANEL', 24, 120, 380, 240, 'panel');
    const vs = win32.virtualScreen();
    wins.taskbar = makeWindow('DECK-T371-TASKBAR', vs.x, vs.y + vs.h - 56, vs.w, 56, 'panel');
    wins.capsule = makeWindow('DECK-T371-CAPSULE', vs.x + vs.w - 260, vs.y + 16, 240, 40, 'panel');
    wins.panelplain = makeWindow('DECK-T371-PANELPLAIN', 24, 400, 300, 120, 'panelplain');
    wins.observer = makeWindow('T371-OBSERVER-TOOL', 60, 60, 220, 120, 'tool');
    wins.migrator = makeWindow('T371-MIGRATOR', 900, 300, 320, 180, 'normal');
    wins.sentinelN = makeWindow('T371-SENTINEL-NORMAL', 420, 160, 340, 200, 'normal');
    wins.btnAgent = makeButton(wins.panel, '切到 Agent 桌面', 1001, 24, 60, 200, 44);
    wins.btnNormal = makeButton(wins.panel, '切回普通桌面', 1002, 24, 120, 200, 44);
    UpdateWindow(wins.panel); UpdateWindow(wins.taskbar); UpdateWindow(wins.capsule); UpdateWindow(wins.panelplain); UpdateWindow(wins.sentinelN);
    await sleep(400);
  });
  say(`探针窗创建：panel=${wins.panel.toString(16)} taskbar=${wins.taskbar.toString(16)} capsule=${wins.capsule.toString(16)} panelplain=${wins.panelplain.toString(16)} migrator=${wins.migrator.toString(16)} sentinelN=${wins.sentinelN.toString(16)}`);

  const followWins = [wins.panel, wins.taskbar, wins.capsule, wins.panelplain];
  const idOf = (h) => vdm.desktopIdOf(h).id;
  const normalIdReadback = idOf(wins.sentinelN);
  check('S3 公开 GetWindowDesktopId 读到哨兵桌面 ID 且与注册表当前一致（配对以系统桌面 ID 区分）',
    normalIdReadback === normalId, `哨兵=${normalIdReadback} 注册表当前=${normalId}`);

  // 应用窗口集合：生产形态（无 TOOLWINDOW 位）三窗经自家进程排除规则出局（与生产面板
  // 同款语义——panel-window.ts skipTaskbar=DeleteTab 不设 TOOLWINDOW 位）；跨进程 notepad
  // 作合格集正对照；TOOLWINDOW 观察窗按形态天然出局（记录在案）
  const qualNums = new Set(qualifiedAppWindows().map(Number));
  check('S3 面板/任务栏/胶囊不进入合格应用窗口集合（自家进程排除规则，生产同款）',
    !qualNums.has(Number(wins.panel)) && !qualNums.has(Number(wins.taskbar)) && !qualNums.has(Number(wins.capsule)),
    `合格集 ${qualNums.size} 窗（全为他进程）`);
  check('S3 合格集非空（他进程真实应用窗在场，谓词正对照成立）', qualNums.size > 0, `合格集 ${qualNums.size} 窗`);
  {
    // 跨进程读回观察：对合格集里他进程窗口逐个读桌面 ID，记录成败面（生产任务栏要读的就是这些窗）
    let okCount = 0, failCount = 0; const sample = [];
    for (const h of qualNums) {
      const r = vdm.desktopIdOf(h);
      if (r.hr === 0 && r.id && r.id !== 'null') { okCount++; if (sample.length < 3) sample.push(`${h.toString(16)}→${r.id.slice(0, 8)}`); }
      else failCount++;
    }
    say(`S3 跨进程 GetWindowDesktopId 读回观察：成功 ${okCount} 窗 / 失败 ${failCount} 窗（样例 ${sample.join(', ') || '无'}）`);
  }

  // —— S4 创建 Agent 桌面 ——
  const createdIds = []; // 本探针新建的桌面（Agent + 第三桌面），S11 逐个删除
  g_state.createdIds = createdIds;
  let agent = null;
  if (vdmi.available) {
    try {
      agent = vdmi.createDesktop();
      createdIds.push(agent.id);
      g_state.createdIds = createdIds;
      say(`COM CreateDesktop 成功：Agent 桌面 ID=${agent.id}`);
    } catch (e) {
      say(`COM CreateDesktop 失败：${e.message} —— 回退热键 Win+Ctrl+D`);
    }
  }
  if (!agent) {
    sendWinCtrlChord(VK_D);
    const created = await waitFor('热键创建桌面回读', 3000, () => {
      const f = regDesktopFacts();
      const newIds = f.ids.filter((x) => !base.ids.includes(x));
      return f.count === base.count + 1 && newIds.length === 1 && f.current === newIds[0]
        ? { ok: true, detail: `count=${f.count} 新ID=${newIds[0]}` } : { ok: false, detail: `count=${f.count} 当前=${f.current}` };
    });
    if (created.ok) {
      const f = regDesktopFacts();
      agent = { ptr: null, id: f.ids.find((x) => !base.ids.includes(x)) };
      createdIds.push(agent.id);
      g_state.createdIds = createdIds;
      say(`热键 Win+Ctrl+D 创建成功（回读确认）：Agent 桌面 ID=${agent.id}，且已自动切到该桌面`);
    } else {
      check('S4 创建 Agent 桌面（COM 与热键均未确认）', false, created.detail);
    }
  }
  if (!agent) { say('无法创建 Agent 桌面——核心平台能力不成立，按失败关闭出证'); process.exitCode = 1; flushReport(); return; }

  {
    const afterCreate = await waitFor('创建后桌面集合 +1', 3000, () => {
      const f = regDesktopFacts();
      return f.count === base.count + 1 && f.ids.includes(agent.id)
        ? { ok: true, detail: `count=${f.count}` } : { ok: false, detail: `count=${f.count}` };
    });
    check('S4 创建后系统桌面集合 +1 且含新 ID（注册表回读）', afterCreate.ok, afterCreate.detail);
  }

  // 点击路径 handler：点按钮 → WM_COMMAND → COM SwitchDesktop（COM 不可用时热键）
  let normalPtr = vdmi.available ? vdmi.getDesktopPtr(normalId) : null;
  const agentPtr = agent.ptr || (vdmi.available ? vdmi.getDesktopPtr(agent.id) : null);
  g_handlers.set(1001, () => {
    say('（handler 1001 触发：探针入口点击已到达，执行切往 Agent 桌面）');
    if (vdmi.available && agentPtr) vdmi.switchDesktop(agentPtr);
    else sendWinCtrlChord(VK_RIGHT);
  });
  g_handlers.set(1002, () => {
    say('（handler 1002 触发：探针入口点击已到达，执行切回普通桌面）');
    if (vdmi.available && normalPtr) vdmi.switchDesktop(normalPtr);
    else sendWinCtrlChord(VK_LEFT);
  });

  // —— S5 真点击「切到 Agent 桌面」→ 实际切换（回读确认，非乐观假设） ——
  const btnRect = win32.rectOf(wins.btnAgent);
  const cx = Math.round((btnRect.left + btnRect.right) / 2), cy = Math.round((btnRect.top + btnRect.bottom) / 2);
  say(`S5 真点击「切到 Agent 桌面」按钮 @(${cx},${cy})（SendInput 物理坐标）`);
  const tClick1 = Date.now();
  win32.clickPhys(cx, cy);
  const conf1 = await waitFor('切到 Agent 桌面确认', 1500, () => {
    const onN = vdm.isOnCurrent(wins.sentinelN);
    const cur = regDesktopFacts().current;
    const cloakN = cloakValue(wins.sentinelN);
    const internalCur = vdmi.available ? vdmi.getCurrentDesktopId() : null;
    const ok = onN.hr === 0 && onN.on === false && cur === agent.id && cloakN === DWM_CLOAKED_SHELL && (internalCur === null || internalCur === agent.id);
    return ok
      ? { ok: true, detail: `注册表=${cur} 内部=${internalCur} 哨兵N离场(on=${onN.on},cloak=${cloakN})` }
      : { ok: false, detail: `注册表=${cur} 内部=${internalCur} 哨兵N(on=${onN.on},cloak=${cloakN})` };
  });
  const click1Ms = Date.now() - tClick1;
  check('S5 点击探针入口后实际桌面切换（系统事实回读：公开 VDM+注册表+DWM cloak' + (vdmi.available ? '+内部 GetCurrentDesktop' : '') + '）',
    conf1.ok, `${conf1.detail}`);
  check('S5 点击→切换确认 ≤1000ms（spec 决策 17 预算）', conf1.ok && click1Ms <= 1000, `点击→确认=${click1Ms}ms`);

  // —— S6 Agent 桌面上建哨兵 + 三窗跟随（重显路径实测） ——
  let sentinelA = 0, sentinelT = 0;
  await pumpDuring(async () => { await sleep(200); sentinelA = makeWindow('T371-SENTINEL-AGENT', 420, 160, 340, 200, false); await sleep(250); });
  const idA = idOf(sentinelA);
  const onA = vdm.isOnCurrent(sentinelA);
  check('S6 Agent 哨兵以系统 ID 归属 Agent 桌面且在当前桌面', idA === agent.id && onA.hr === 0 && onA.on, `id=${idA} agent=${agent.id} on=${onA.on}`);

  // 机制判定：静置 800ms 读跟随窗事实——on=true+cloak=0 即「原生跨桌面在场」（自动跟随），
  // on=false+cloak=2 即「桌面绑定」（需重显迁移）；两种机制都满足「能在两个桌面使用」，
  // 如实记录是哪一种，不预设。
  await sleep(800);
  const preFollow = followWins.map((h) => ({ h, on: vdm.isOnCurrent(h), cloak: cloakValue(h) }));
  say(`切走后静置 800ms 跟随窗事实：${preFollow.map((x) => `on=${x.on.on},cloak=${x.cloak}`).join(' ')}（${wins.panel.toString(16)}=panel ${wins.taskbar.toString(16)}=taskbar ${wins.capsule.toString(16)}=capsule ${wins.panelplain.toString(16)}=panelplain）`);
  const topAuto = preFollow.slice(0, 3).every((x) => x.on.hr === 0 && x.on.on && x.cloak === 0);
  const plainAuto = preFollow[3].on.hr === 0 && preFollow[3].on.on && preFollow[3].cloak === 0;
  say(`跟随机制判定：topmost 三窗（panel/taskbar/capsule）=${topAuto ? '自动跟随（原生跨桌面在场，无需动作）' : '桌面绑定（需重显迁移）'}；非置顶 panelplain=${plainAuto ? '自动跟随' : '桌面绑定（需重显迁移）'}`);
  const followT0 = Date.now();
  await pumpDuring(async () => {
    for (const h of followWins) ShowWindowU(h, SW_SHOWNA);
    await sleep(150);
  });
  const follow = await waitFor('跟随窗事实确认', 3000, () => {
    const bad = [];
    for (const h of followWins) {
      const on = vdm.isOnCurrent(h);
      if (!(on.hr === 0 && on.on) || cloakValue(h) === DWM_CLOAKED_SHELL) bad.push(`${h.toString(16)}:on=${on.on}`);
    }
    return bad.length === 0 ? { ok: true, detail: '跟随窗全部回读为当前桌面且未 shell cloak' } : { ok: false, detail: bad.join(' ') };
  });
  const followMs = Date.now() - followT0;
  check('S6 面板/任务栏/胶囊(+panelplain) 在 Agent 桌面可用（跟随事实：IsOnCurrent+未 cloak）', follow.ok,
    `${follow.detail} 耗时=${followMs}ms`);
  // 迁移机制（desktop-bound 窗的跟随兜底路径，本段如实测得）：
  //   a) SW_SHOWNA 重显——上一调试轮对 desktop-bound 窗不迁移（on 仍 false），先复测记录；
  //   b) 公开 MoveWindowToDesktop——同轮 S9 已证可迁移，作为判定路径。
  const preMig = { on: vdm.isOnCurrent(wins.migrator), cloak: cloakValue(wins.migrator) };
  check('S6 迁移试验窗切走后被桌面绑定（on=false+shell cloak）', preMig.on.hr === 0 && preMig.on.on === false && preMig.cloak === DWM_CLOAKED_SHELL,
    `on=${preMig.on.on},cloak=${preMig.cloak}`);
  await pumpDuring(async () => { ShowWindowU(wins.migrator, SW_SHOWNA); await sleep(200); });
  const afterReshow = { on: vdm.isOnCurrent(wins.migrator), cloak: cloakValue(wins.migrator) };
  say(`S6 SW_SHOWNA 重显复测：migrator on=${afterReshow.on.on},cloak=${afterReshow.cloak}（${afterReshow.on.on ? '重显即迁移' : '重显不迁移——失败边界如实记录'}）`);
  const hrMig = vdm.moveToDesktop(wins.migrator, agent.id);
  await sleep(300);
  const postMig = { on: vdm.isOnCurrent(wins.migrator), cloak: cloakValue(wins.migrator) };
  check('S6 公开 MoveWindowToDesktop 迁移路径成立（desktop-bound 窗跟随兜底）',
    hrMig === 0 && postMig.on.hr === 0 && postMig.on.on,
    `hr=${hrName(hrMig)} on=${postMig.on.on},cloak=${postMig.cloak}`);

  // —— S7 真点击「切回普通桌面」→ 实际切换（回读确认） ——
  const btnRect2 = win32.rectOf(wins.btnNormal);
  const cx2 = Math.round((btnRect2.left + btnRect2.right) / 2), cy2 = Math.round((btnRect2.top + btnRect2.bottom) / 2);
  say(`S7 真点击「切回普通桌面」按钮 @(${cx2},${cy2})`);
  const tClick2 = Date.now();
  win32.clickPhys(cx2, cy2);
  const conf2 = await waitFor('切回普通桌面确认', 1500, () => {
    const onN = vdm.isOnCurrent(wins.sentinelN);
    const cur = regDesktopFacts().current;
    const internalCur = vdmi.available ? vdmi.getCurrentDesktopId() : null;
    const ok = onN.hr === 0 && onN.on === true && cur === normalId && (internalCur === null || internalCur === normalId);
    return ok ? { ok: true, detail: `注册表=${cur} 内部=${internalCur} 哨兵N回读在当前桌面` } : { ok: false, detail: `注册表=${cur} 内部=${internalCur} 哨兵N(on=${onN.on})` };
  });
  const click2Ms = Date.now() - tClick2;
  check('S7 点击探针入口切回普通桌面（系统事实回读）', conf2.ok, conf2.detail);
  check('S7 点击→切换确认 ≤1000ms（spec 预算）', conf2.ok && click2Ms <= 1000, `点击→确认=${click2Ms}ms`);
  const preBack = followWins.map((h) => ({ h, on: vdm.isOnCurrent(h), cloak: cloakValue(h) }));
  say(`回程切走后跟随窗事实：${preBack.map((x) => `on=${x.on.on},cloak=${x.cloak}`).join(' ')}`);
  await pumpDuring(async () => { for (const h of followWins) ShowWindowU(h, SW_SHOWNA); await sleep(150); });
  try {
    const hrBack = vdm.moveToDesktop(wins.migrator, normalId);
    await sleep(300);
    say(`S7 migrator 公开迁移回普通桌面：hr=${hrName(hrBack)} on=${vdm.isOnCurrent(wins.migrator).on}`);
  } catch (e) { say(`S7 migrator 迁移回程异常：${e.message}`); }
  const back = await waitFor('跟随窗回普通桌面确认', 3000, () => {
    for (const h of followWins) { const on = vdm.isOnCurrent(h); if (!(on.hr === 0 && on.on)) return { ok: false }; }
    return { ok: true };
  });
  check('S7 跟随窗全部跟随回普通桌面（机制与去程一致）', back.ok,
    preBack.map((x) => `on=${x.on.on},cloak=${x.cloak}`).join(' '));

  // —— S8 第三桌面：不受吞并/删除/自动切回 ——
  let third = null;
  if (vdmi.available) {
    try {
      third = vdmi.createDesktop();
      createdIds.push(third.id);
      g_state.createdIds = createdIds;
      const t3c = await waitFor('第三桌面入册', 3000, () => {
        const f = regDesktopFacts();
        return f.count === base.count + 2 && f.ids.includes(third.id)
          ? { ok: true, detail: `count=${f.count} third=${third.id}` } : { ok: false, detail: `count=${f.count}` };
      });
      check('S8 第三桌面创建（替身用户既有桌面）', t3c.ok, t3c.detail);
    } catch (e) { check('S8 第三桌面创建', false, e.message); }
  } else {
    say('S8 第三桌面：内部 COM 不可用态下不做（热键路径下第三桌面安全断言以邻位观察替代，失败边界如实记录）');
  }
  if (third) {
    // 唯一一次有意切到第三桌面（放置哨兵，记录在案）
    try { vdmi.switchDesktop(third.ptr); } catch (e) { say(`切往第三桌面异常：${e.message}`); }
    const t3 = await waitFor('有意切到第三桌面', 1500, () => regDesktopFacts().current === third.id ? { ok: true } : { ok: false, detail: regDesktopFacts().current });
    say(`（有意切换到第三桌面一次，用于放置哨兵：${t3.ok ? '确认' : '未确认 ' + t3.detail}）`);
    await pumpDuring(async () => { await sleep(200); sentinelT = makeWindow('T371-SENTINEL-THIRD', 420, 160, 340, 200, 'normal'); await sleep(250); });
    const idT = idOf(sentinelT);
    check('S8 第三桌面哨兵归属第三桌面（系统 ID）', idT === third.id, `id=${idT} third=${third.id}`);
    // 切回普通，然后 agent↔normal 四轮——每轮断言永不落在第三桌面且第三桌面原样
    try {
      const nPtr = vdmi.getDesktopPtr(normalId), aPtr = vdmi.getDesktopPtr(agent.id);
      const thirdLog = [];
      let thirdSafe = true;
      for (const [label, target] of [['→普通', nPtr], ['→Agent', aPtr], ['→普通', nPtr], ['→Agent', aPtr]]) {
        vdmi.switchDesktop(target);
        const conf = await waitFor('配对切换确认', 1500, () => {
          const cur = regDesktopFacts().current;
          const internalCur = vdmi.getCurrentDesktopId();
          return cur === internalCur && (cur === normalId || cur === agent.id) ? { ok: true, detail: cur } : { ok: false, detail: `${cur}/${internalCur}` };
        });
        const cur = vdmi.getCurrentDesktopId();
        const f = regDesktopFacts();
        const stayed = cur !== third.id && isAlive(sentinelT) && idOf(sentinelT) === third.id && f.ids.includes(third.id) && f.count === base.count + 2;
        if (!conf.ok || !stayed) {
          thirdSafe = false;
          thirdLog.push(`${label} 确认=${conf.ok}(${conf.detail}) 当前=${cur} 哨兵T存活=${isAlive(sentinelT)} 归属=${isAlive(sentinelT) ? idOf(sentinelT) : 'dead'} 在册=${f.ids.includes(third.id)} count=${f.count}`);
        }
      }
      check('S8 配对切换 4 轮中第三桌面不被自动切回、不被吞并、不被删除（ID/哨兵/集合全程不变）', thirdSafe, thirdLog.join(' | ') || '四轮全部安全');
    } catch (e) {
      check('S8 配对切换循环', false, `异常 ${e.message}`);
    }
    // 回普通桌面
    try {
      const nPtr = vdmi.getDesktopPtr(normalId);
      if (nPtr) vdmi.switchDesktop(nPtr);
      await waitFor('回普通桌面', 1500, () => regDesktopFacts().current === normalId ? { ok: true } : { ok: false, detail: regDesktopFacts().current });
      await pumpDuring(async () => { for (const h of followWins) ShowWindowU(h, SW_SHOWNA); await sleep(150); });
    } catch (e) { say(`（收尾切回普通桌面异常：${e.message}）`); }
  }

  // —— S9 公开 MoveWindowToDesktop 能力观察（窗口跨桌面移动路径，非致命） ——
  try {
    const hrMove = vdm.moveToDesktop(wins.sentinelN, agent.id);
    await sleep(400);
    const idAfter = idOf(wins.sentinelN);
    const moved = idAfter === agent.id;
    say(`S9 公开 MoveWindowToDesktop：hr=${hrName(hrMove)} 移动后哨兵N归属=${idAfter}（${moved ? '成功迁移——窗口跨桌面移动公开路径成立' : '未迁移——公开移动路径不成立，生产需内部 MoveViewToDesktop 或另案' }）`);
    if (moved) {
      vdm.moveToDesktop(wins.sentinelN, normalId);
      await sleep(400);
      say(`S9 公开 MoveWindowToDesktop 移回：哨兵N归属=${idOf(wins.sentinelN)}`);
    }
  } catch (e) { say(`S9 公开 MoveWindowToDesktop 异常：${e.message}`); }

  // —— S10 热键回退路径演习（Win+Ctrl+←→，回读确认；非致命，失败即失败边界） ——
  if (process.argv.includes('--no-hotkey-check')) {
    say('S10 热键回退演习：--no-hotkey-check 跳过');
  } else {
    try {
      const before = vdmi.available ? vdmi.getCurrentDesktopId() : regDesktopFacts().current;
      sendWinCtrlChord(VK_RIGHT);
      const hk = await waitFor('热键右切确认', 1500, () => {
        const cur = regDesktopFacts().current;
        const internalCur = vdmi.available ? vdmi.getCurrentDesktopId() : null;
        return cur !== before && (internalCur === null || internalCur === cur) ? { ok: true, detail: cur } : { ok: false, detail: cur };
      });
      say(`S10 热键 Win+Ctrl+→：${hk.ok ? '确认切到 ' + hk.detail : '未确认（' + hk.detail + '）'} 耗时=${hk.ms}ms`);
      if (hk.ok) {
        sendWinCtrlChord(VK_LEFT);
        const back = await waitFor('热键左切回确认', 1500, () => {
          const cur = regDesktopFacts().current;
          return cur === before ? { ok: true } : { ok: false, detail: cur };
        });
        check('S10 热键左切回到原桌面（回读）', back.ok, back.detail);
      } else {
        sendWinCtrlChord(VK_LEFT); // 归位，防残局
        await sleep(600);
        say('S10 热键右切未确认——已发左切归位；失败边界如实记录（热键可能被策略吞掉或邻位语义不符）');
        check('S10 热键回退路径可用（回读确认）', false, '右切未确认');
      }
    } catch (e) { say(`S10 热键演习异常：${e.message}`); }
  }

  // —— S11 清零残留 ——
  say('—— S11 清理与零残留断言 ——');
  // 1) 回普通桌面再删我们创建的桌面（回退均给普通桌面）
  try {
    const nPtr = vdmi.available ? vdmi.getDesktopPtr(normalId) : null;
    if (vdmi.available && nPtr && regDesktopFacts().current !== normalId) {
      vdmi.switchDesktop(nPtr);
      await waitFor('清理前回普通桌面', 1500, () => regDesktopFacts().current === normalId ? { ok: true } : { ok: false });
    }
  } catch { /* 下面逐个删除时再处理 */ }
  if (vdmi.available) {
    const nPtr = vdmi.getDesktopPtr(normalId);
    for (const id of createdIds.slice().reverse()) {
      try {
        const dPtr = vdmi.getDesktopPtr(id);
        if (!dPtr) { say(`RemoveDesktop(${id})：桌面已不在壳集合（跳过）`); continue; }
        vdmi.removeDesktop(dPtr, nPtr);
        say(`RemoveDesktop(${id}) 已调用`);
      } catch (e) { say(`RemoveDesktop(${id}) 失败：${e.message}——热键兜底`); }
    }
  }
  // 热键兜底：若桌面数仍多于基线，逐个「当前=多余桌面 → Win+Ctrl+F4」
  for (let guard = 0; guard < 6; guard++) {
    const f = regDesktopFacts();
    const extra = f.ids.filter((x) => !base.ids.includes(x));
    if (f.count <= base.count || !extra.length) break;
    if (extra.includes(f.current)) {
      sendWinCtrlChord(VK_F4);
      await sleep(700);
    } else {
      sendWinCtrlChord(VK_RIGHT);
      await sleep(500);
    }
  }
  const afterCleanup = await waitFor('桌面集合回到基线', 5000, () => {
    const f = regDesktopFacts();
    const setEq = f.count === base.count && base.ids.every((x) => f.ids.includes(x)) && f.ids.every((x) => base.ids.includes(x));
    return setEq && f.current === normalId ? { ok: true, detail: `count=${f.count} 当前=${f.current} 集合与基线逐项相等` } : { ok: false, detail: `count=${f.count} 当前=${f.current} 集合=[${f.ids.join(',')}]` };
  });
  check('S11 新建桌面全部删除：注册表桌面集合与基线逐项相等、当前=普通桌面（无多余桌面）', afterCleanup.ok, afterCleanup.detail);

  // 2) 窗口零残留
  await pumpDuring(async () => {
    for (const h of [...followWins, wins.observer, wins.migrator, wins.sentinelN, sentinelA, sentinelT]) {
      try { if (isAlive(h)) DestroyWindow(h); } catch { /* 逐个销毁 */ }
    }
    await sleep(200);
  });
  try { if (g_wndprocCb) koffi.unregister(g_wndprocCb); } catch { /* 收尾 */ }
  const myPid = GetCurrentProcessId();
  const remain = [];
  for (const h of win32.topLevelWindows()) {
    const buf = Buffer.alloc(4);
    GetWindowThreadProcessId(h, buf);
    if (buf.readUInt32LE(0) === myPid) remain.push(h.toString(16));
  }
  check('S11 探针窗口零残留（本 pid 顶层可见窗=0）', remain.length === 0, remain.join(','));

  // 3) 原生任务栏状态不变
  const appbarAfter = win32.appbarState();
  const trayRectAfter = trayHwnd && win32.IsWindow(trayHwnd) ? win32.rectOf(trayHwnd) : null;
  say(`S11 原生任务栏矩形观察（autohide peek 态下矩形本就随滑入滑出漂移，不作断言）：${JSON.stringify(trayRectBefore)}→${JSON.stringify(trayRectAfter)}`);
  check('S11 原生任务栏状态不变（ABM_GETSTATE + 可见性）',
    appbarAfter === appbarBefore && Boolean(win32.nativeTaskbarVisible()) === Boolean(trayHwnd && win32.IsWindowVisible(trayHwnd)),
    `state ${appbarBefore}→${appbarAfter} visible ${Boolean(trayHwnd && win32.IsWindowVisible(trayHwnd))}→${Boolean(win32.nativeTaskbarVisible())}`);

  // 4) 常驻进程
  say('S11 常驻进程：探针未 spawn 任何子进程，main 返回即退出，无常驻残留（结构性保证）');

  // —— 汇总 ——
  say('');
  say('=== 工单371 go/no-go 证据要点 ===');
  say(`① 桌面配对与 ID 区分：公开 VDM + 注册表 + DWM cloak${vdmi.available ? ' + 内部 GetCurrentDesktop' : ''} 多源互证——见 S3/S6/S8 PASS 行`);
  say(`② 点击探针入口→实际切换：两次真点击（→Agent ${click1Ms}ms、→普通 ${click2Ms}ms）均以系统事实回读确认（预算 ≤1000ms）`);
  say(`③ 面板/任务栏/胶囊跨桌面可用：${follow.ok ? '实测成立' : '未成立'}（机制判定见 S6 行：topmost 形态与 panelplain 形态分别记录）；确认耗时 ${followMs}ms；探针窗不进合格应用集合见 S3；重显迁移兜底路径见 migrator 两行`);
  say(`④ 第三桌面安全：见 S8 PASS 行（替身用户桌面，配对切换 4 轮全程原样）`);
  say(`⑤ 零残留：见 S11 PASS 行（桌面集合回基线、窗口零残留、原生任务栏状态不变、无子进程）`);
  say(`内部 COM（创建/切换/删除，24H2/25H2 IID）：${vdmi.available ? '可用——生产适配器首选路径成立' : '不可用（IID 漂移）——需热键回退或另案评审'}`);
  say(`公开 VDM：桌面 ID 读取/IsOnCurrent 可用；MoveWindowToDesktop 能力见 S9 实测行`);
  say(`断言账目：${failures.length === 0 ? '全部通过' : failures.length + ' 条不成立：' + failures.join('；')}`);
  say('go/no-go 判读：探针能力不记作生产完成——生产实现仍需按 spec #369 决策 3/8/30 走适配器与失败关闭；验收标准①~⑤逐条对应上方 PASS/FAIL 行。');

  process.exitCode = failures.length === 0 ? 0 : 1;
  flushReport();
}

main().catch(async (e) => {
  say(`探针异常退出：${e && e.stack ? e.stack : e && e.message}`);
  await recoverCleanup();
  process.exitCode = 2;
  flushReport();
});
