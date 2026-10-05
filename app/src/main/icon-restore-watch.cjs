// 原生图标/任务栏还原守护（工单05 缝隙修复；工单50 扩展任务栏）：守卫的守护。
// 动机：控制台信号（Ctrl+C / Ctrl+Break / 关终端窗）由 conhost 同发守卫与面板，Electron
// 主进程在 Windows 下 process.on('SIGINT'|'SIGBREAK') 不触发（真机实证：CTRL_BREAK 经
// GenerateConsoleCtrlEvent 送达后整树死亡、Node 信号处理器未运行、图标留隐藏态），
// 守卫进程内的还原钩子全被绕过。本进程由守卫以 detached + stdio:ignore 拉起：
// 无控制台可收任何信号，且逃出 Chromium job kill-on-close（05 踩坑 2 的反向利用）。
// 运行形态：electron 二进制 + ELECTRON_RUN_AS_NODE=1（免独立 node 依赖）。
// 生命周期：钉守卫进程对象等死亡 → 仍隐藏的桌面图标/原生任务栏（视图事实）翻回 → 自退。
// 正常退出路径守卫已还原，这里见到可见即静默退出，零感知。
// 工单50 注记：守卫先死、面板独活的畸形现场下，本守护会在面板仍跑时把原生任务栏
// 翻回（查不到面板的隐藏账，视图事实是唯一判据）——条带与原生栏短暂并存是安全
// 方向的降级（用户不失系统入口），面板随后退出时各路径幂等收敛。
'use strict'
const koffi = require('koffi')
const { restoreIfHidden, iconsVisible } = require('./icon-carry.js')
const { restoreNativeTaskbarIfHidden } = require('./taskbar/native.js')

const guardPid = parseInt(process.argv[2], 10)
const SYNCHRONIZE = 0x00100000
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const INFINITE = 0xffffffff

const kernel32 = koffi.load('kernel32.dll')
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(void *h, uint32 ms)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)')

// 存证（工单50）：守卫经环境继承带来 DECK_EVENT_LOG 时，任务栏还原落同一事件流——
// 验收电池据此断言「guard-dead」兜底路径真的执行过（图标路径维持 05 原状的静默）。
const logFile = process.env.DECK_EVENT_LOG
const log = logFile ? {
  append(event) {
    try { require('fs').appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...event }) + '\n') } catch { /* 尽力 */ }
  },
} : null

// 钉住守卫进程对象：句柄指向具体进程而非 pid 数字，守卫死亡即被触发（signaled），
// 不受 Windows pid 复用影响。打不开（守卫已死/权限）视为已死，直接走还原判断。
const handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, guardPid)
if (handle) {
  WaitForSingleObject(handle, INFINITE)
  CloseHandle(handle)
}
try {
  // 幂等：正常退出路径守卫已还原图标（iconsVisible=true），这里不动；
  // 死路径（控制台信号同杀）图标仍隐藏，按视图事实翻回。
  if (!iconsVisible()) restoreIfHidden(null, 'guard-dead')
} catch {
  // 尽力：还原失败不阻断自退（无家可归的守护不该成为常驻残留）
}
try {
  // 工单50：原生任务栏同一兜底（restoreNativeTaskbarIfHidden 自带视图事实判据，
  // 可见即静默空转）；存证走本进程自建日志（DECK_EVENT_LOG 在场时）。
  restoreNativeTaskbarIfHidden(log, 'guard-dead')
} catch {
  // 尽力：同上
}
process.exit(0)
