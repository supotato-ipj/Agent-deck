// 虚拟桌面注册表事实源（进程内直读）与变更通知布防（工单474，spec #472 / ADR-0032
// 「事件驱动优先于轮询」）。替换「每秒 spawn 2 个 reg.exe 子进程」的常驻轮询：
//   - readRegistryFactsDirect：advapi32 RegQueryValueExW 两步读（探大小→读值），零进程
//     创建；GUID 换算复用 virtual-desktop.regBytesToGuid（与旧 reg.exe 文本解析同一出口，
//     t474 探针 P1 实证两路同值）。
//   - vdRegistryWatch：RegNotifyChangeKeyValue 异步通知（REG_NOTIFY_CHANGE_LAST_SET |
//     REG_NOTIFY_THREAD_AGNOSTIC，Win8+——通知不再绑定布防线程寿命）+ 手动复位事件；
//     consumeFired = 查态(0 超时) → 复位 → 重新布防 → true。**重新布防先于调用方读
//     事实**：布防→读的顺序保证消费与读之间没有盲窗（重布防后的写入会再次点火）。
//     t474 探针 P2/P3 实证：静默零误报、写入 2s 内点火、重布防后可再点火。
//
// 纪律（virtual-desktop.ts 同款）：lazy-bind——模块加载零 FFI，start() 才触 koffi；
// 绑定失败失败关闭（available:false，服务降级每拍全对账——读面仍是进程内直读，
// 常驻路径零 reg.exe）；未布防时 consumeFired/stop 是纯 JS no-op（离线测试零 FFI）。
// 单查询原子读口径（t371 实证）：一次 facts = VirtualDesktopIDs 与 CurrentVirtualDesktop
// 两条 RegQueryValueExW 背靠背——与旧 reg.exe 单进程内两读同形，分两次进程的错配快照
// 坑不复发。
import { regBytesToGuid, type RegistryDesktopFacts } from './virtual-desktop'

const HKCU = 0x80000001
/** KEY_QUERY_VALUE|KEY_ENUMERATE_SUB_KEYS|KEY_NOTIFY|STANDARD_RIGHTS_READ（读值+收通知） */
const KEY_READ = 0x20019
const REG_BINARY = 3
/** 值集变更（VirtualDesktopIDs / CurrentVirtualDesktop 的增删改都算） */
const REG_NOTIFY_CHANGE_LAST_SET = 0x4
/** 通知不随布防线程退出失效（Win8+；koffi 调用都在 Electron 主线程，加此位防将来线程形态变化） */
const REG_NOTIFY_THREAD_AGNOSTIC = 0x10000000
const WAIT_OBJECT_0 = 0
const ERROR_MORE_DATA = 234

const VD_KEY_PATH = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops'
/** VirtualDesktopIDs 每 16 字节一个桌面 GUID；CurrentVirtualDesktop 16 字节 */
const GUID_BYTES = 16
/** 探针实证 koffi 解码路径：alloc('uint8_t', n) → decode(ptr,'uint8_t',n) → number[] */

interface KoffiLike {
  load(name: string): KoffiLike
  func(declaration: string): KoffiFunc
  alloc(type: string, length: number): unknown
  free(ptr: unknown): void
  decode(ptr: unknown, type: string, length: number): number[]
}

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface RegistryFfi {
  regOpenKeyExW: KoffiFunc
  regCloseKey: KoffiFunc
  regQueryValueExW: KoffiFunc
  regNotifyChangeKeyValue: KoffiFunc
  createEventW: KoffiFunc
  waitForSingleObject: KoffiFunc
  resetEvent: KoffiFunc
  closeHandle: KoffiFunc
  alloc: (n: number) => unknown
  free: (ptr: unknown) => void
  decodeBytes: (ptr: unknown, n: number) => number[]
}

let ffi: RegistryFfi | null = null
let bindFailed = false

function bind(): RegistryFfi | null {
  if (bindFailed) return null
  if (ffi) return ffi
  try {
    const koffi = require('koffi') as KoffiLike
    const advapi32 = koffi.load('advapi32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    // lpcbData 是 in-out（入=缓冲大小/出=实际大小）：koffi 对 _Out_ 参数调前清零
    // （t474 探针实证 hr=234 MORE_DATA 形态），必须 _Inout_ 才保住初值——探针定案形状。
    ffi = {
      regOpenKeyExW: advapi32.func('int32 __stdcall RegOpenKeyExW(void *hKey, const char16_t *lpSubKey, uint32_t ulOptions, uint32_t samDesired, _Out_ void **phkResult)'),
      regCloseKey: advapi32.func('int32 __stdcall RegCloseKey(void *hKey)'),
      regQueryValueExW: advapi32.func('int32 __stdcall RegQueryValueExW(void *hKey, const char16_t *lpValueName, void *lpReserved, _Out_ uint32_t *lpType, uint8_t *lpData, _Inout_ uint32_t *lpcbData)'),
      regNotifyChangeKeyValue: advapi32.func('int32 __stdcall RegNotifyChangeKeyValue(void *hKey, uint32_t bWatchSubtree, uint32_t dwNotifyFilter, void *hEvent, uint32_t fAsynchronous)'),
      createEventW: kernel32.func('void *__stdcall CreateEventW(void *lpEventAttributes, uint32_t bManualReset, uint32_t bInitialState, const char16_t *lpName)'),
      waitForSingleObject: kernel32.func('uint32_t __stdcall WaitForSingleObject(void *hHandle, uint32_t dwMilliseconds)'),
      resetEvent: kernel32.func('uint32_t __stdcall ResetEvent(void *hEvent)'),
      closeHandle: kernel32.func('uint32_t __stdcall CloseHandle(void *hObject)'),
      alloc: (n) => koffi.alloc('uint8_t', n),
      free: (ptr) => koffi.free(ptr),
      decodeBytes: (ptr, n) => koffi.decode(ptr, 'uint8_t', n),
    }
    return ffi
  } catch {
    bindFailed = true
    return null
  }
}

function openKey(f: RegistryFfi, path: string): unknown | null {
  const hk = [null]
  const hr = Number(f.regOpenKeyExW(HKCU, path, 0, KEY_READ, hk))
  return hr === 0 ? hk[0] : null
}

/** 探大小再读值（两步）：任一步失败/类型非 REG_BINARY = null（调用方回退 reg.exe 单查询） */
function readBinaryValue(f: RegistryFfi, hKey: unknown, name: string): Buffer | null {
  try {
    const type = [0]
    const size = [0]
    const hr1 = Number(f.regQueryValueExW(hKey, name, null, type, null, size))
    if ((hr1 !== 0 && hr1 !== ERROR_MORE_DATA) || !size[0]) return null
    const buf = f.alloc(Number(size[0]))
    const len = [size[0]]
    const hr2 = Number(f.regQueryValueExW(hKey, name, null, type, buf, len))
    const n = Number(len[0])
    let bytes: number[] | null = null
    if (hr2 === 0 && n > 0) bytes = f.decodeBytes(buf, n)
    f.free(buf)
    if (!bytes || Number(type[0]) !== REG_BINARY) return null
    return Buffer.from(bytes)
  } catch {
    return null
  }
}

function factsFromBytes(f: RegistryFfi, hKey: unknown): RegistryDesktopFacts | null {
  const idsRaw = readBinaryValue(f, hKey, 'VirtualDesktopIDs')
  if (!idsRaw) return null
  const hex = idsRaw.toString('hex').toUpperCase()
  const ids: string[] = []
  for (let off = 0; off + GUID_BYTES * 2 <= hex.length; off += GUID_BYTES * 2) {
    const id = regBytesToGuid(hex.slice(off, off + GUID_BYTES * 2))
    if (id) ids.push(id)
  }
  const curRaw = readBinaryValue(f, hKey, 'CurrentVirtualDesktop')
  const current = curRaw ? regBytesToGuid(curRaw.toString('hex').toUpperCase()) : null
  return { count: ids.length, ids, current: current || null }
}

/**
 * 注册表桌面事实（进程内直读，工单474 常驻主路）：语义与旧 reg.exe 单查询路径一致
 * （RegistryDesktopFacts；不可读 = null——调用方回退 reg.exe 或按失败关闭处理）。
 */
export function readRegistryFactsDirect(): RegistryDesktopFacts | null {
  const f = bind()
  if (!f) return null
  try {
    const hKey = openKey(f, VD_KEY_PATH)
    if (!hKey) return null
    try {
      return factsFromBytes(f, hKey)
    } finally {
      try { f.regCloseKey(hKey) } catch { /* 关闭失败不追（句柄随进程回收） */ }
    }
  } catch {
    return null
  }
}

/** 注册表变更通知面（工单474）：服务编排经此布防/消费/撤防 */
export interface VdRegistryWatch {
  /** 布防成功且未损坏（false = 服务降级每拍全对账） */
  available(): boolean
  /** 布防（幂等）：开键 + 建手动复位事件 + 挂异步通知。失败关闭返回 false。 */
  start(): boolean
  /** 消费一次点火：内核事件已点火 = 复位 + 重新布防 + true；未点火/未布防/已损坏 = false。
   * 重新布防发生在本调用内、先于调用方的对账读——消费与读之间无盲窗。 */
  consumeFired(): boolean
  /** 撤防（关键与事件句柄）；未布防 = no-op（零 FFI）。 */
  stop(): void
}

interface WatchState {
  armed: boolean
  broken: boolean
  hKey: unknown
  hEvent: unknown
}

let watchSingleton: VdRegistryWatch | null = null

/** 通知面单例（服务缺省绑定；进程级一份内核句柄，stop 后可再 start） */
export function vdRegistryWatch(): VdRegistryWatch {
  if (watchSingleton) return watchSingleton
  const st: WatchState = { armed: false, broken: false, hKey: null, hEvent: null }
  const f = () => bind()
  const arm = (): boolean => {
    if (!st.hKey || !st.hEvent) return false
    const hr = Number(f()!.regNotifyChangeKeyValue(st.hKey, 0, REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC, st.hEvent, 1))
    return hr === 0
  }
  watchSingleton = {
    available: () => st.armed && !st.broken,
    start: (): boolean => {
      const lib = f()
      if (!lib) return false
      if (st.armed && !st.broken) return true // 幂等
      if (st.armed) this_stop() // 损坏态重布防前先清句柄
      const hKey = openKey(lib, VD_KEY_PATH)
      if (!hKey) return false
      const hEvent = lib_closeCreate(lib)
      if (!hEvent) {
        try { lib.regCloseKey(hKey) } catch { /* 清理尽力 */ }
        return false
      }
      st.hKey = hKey
      st.hEvent = hEvent
      if (!arm()) {
        st.hKey = null
        st.hEvent = null
        try { lib.regCloseKey(hKey) } catch { /* 清理尽力 */ }
        try { lib.closeHandle(hEvent) } catch { /* 清理尽力 */ }
        return false
      }
      st.armed = true
      st.broken = false
      return true
    },
    consumeFired: (): boolean => {
      const lib = f()
      if (!lib || !st.armed || st.broken) return false
      try {
        const w = Number(lib.waitForSingleObject(st.hEvent, 0))
        if (w !== WAIT_OBJECT_0) return false
        // 消费：复位 + 重新布防（先于调用方读事实=无盲窗）；重布防失败 = 通知链路损坏，
        // available 翻 false → 服务降级每拍全对账（本拍照常 true，读事实仍做）。
        lib.resetEvent(st.hEvent)
        if (!arm()) st.broken = true
        return true
      } catch {
        st.broken = true
        return false
      }
    },
    stop: (): void => {
      if (!st.armed) return // 未布防：零 FFI no-op（离线测试零实害）
      this_stop()
    },
  }
  function lib_closeCreate(lib: RegistryFfi): unknown {
    try {
      return lib.createEventW(null, 1, 0, null) // 手动复位、初始无信号
    } catch {
      return null
    }
  }
  function this_stop(): void {
    const lib = f()
    st.armed = false
    st.broken = false
    if (lib) {
      try { if (st.hKey) lib.regCloseKey(st.hKey) } catch { /* 尽力 */ }
      try { if (st.hEvent) lib.closeHandle(st.hEvent) } catch { /* 尽力 */ }
    }
    st.hKey = null
    st.hEvent = null
  }
  return watchSingleton
}
