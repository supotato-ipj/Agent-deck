// 真实虚拟桌面适配器（工单375，spec #369 决策 3）：桌面创建/切换/集合与窗口跨桌面
// 移动的**单一 FFI 出处**，业务层不散落 COM 绑定。绑定面照抄 t371 真机探针的实证形态
// （app/accept/experiments/t371-virtual-desktop-probe.js，Win11 26300 全绿）：
//   - 内部 IVirtualDesktopManagerInternal（24H2/25H2 IID）：GetCurrentDesktop / GetDesktops /
//     SwitchDesktop / CreateDesktop / RemoveDesktop；
//   - 公开 IVirtualDesktopManager：IsWindowOnCurrentVirtualDesktop / GetWindowDesktopId /
//     MoveWindowToDesktop（desktop-bound 窗的跟随兜底——SW_SHOWNA 重显不迁移，探针实证）；
//   - 内部 IApplicationViewCollection::GetViewForHwnd + VDMI::MoveViewToDesktop（工单407
//     t407-move-window 探针实证：**跨进程**移动他进程窗口的可用路径——公开
//     MoveWindowToDesktop 对他进程窗实测 E_ACCESSDENIED，不能承载拖入迁移）；
//   - 注册表 VirtualDesktopIDs/CurrentVirtualDesktop 单查询原子读（explorer 维护）。
//
// 纪律（spec 决策 3/30）：适配器**不向业务层泄露乐观状态**——switchDesktop 只报告 COM
// 调用成败，「切成功」的判定在编排层以系统 ID 回读（workspace-plan.switchConfirmed）完成；
// 绑定失败（IID 漂移/壳不可达）显式 available:false（失败关闭），不静默改热键凑合。
//
// 边界：lazy-bind（win-facts.ts 同款——模块加载不触 FFI/COM，离线测试零实害）；具名
// struct 进程级单登（#153 教训，VD_ 前缀防撞名）；本模块零窗口枚举/零几何改写——窗口
// 事实在 taskbar/win-facts.ts，桌面 ID 条件加在投影裁决层（spec 决策 6）。
import { execFile } from 'node:child_process'

const CLSID = {
  immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239',
  vdManagerInternal: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B',
  vdManager: 'AA509086-5CA9-4C25-8F95-589D3C07B48A',
}
const IID = {
  vdManager: 'A5CD92FF-29BE-454C-8D04-D82879FB3F1B',
  vdManagerInternal_24H2: '53F5CA0B-158F-4124-900C-057158060B27',
  virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C',
  serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA',
  /** IApplicationViewCollection（QueryService 双参同 IID，MScholtes 24H2 布局） */
  applicationViewCollection: '1841C6D7-4F9D-42C0-AF41-8747538F10E5',
}

// COM vtable 槽位（t371 实证布局，QI0/AddRef1/Release2 起）
const SLOT_QUERY_SERVICE = 3
const SLOT_VDMI_GET_CURRENT_DESKTOP = 6
const SLOT_VDMI_GET_DESKTOPS = 7
const SLOT_VDMI_SWITCH_DESKTOP = 9
const SLOT_VDMI_CREATE_DESKTOP = 11
const SLOT_VDMI_REMOVE_DESKTOP = 13
const SLOT_VD_GET_ID = 4
const SLOT_OBJARR_COUNT = 3
const SLOT_OBJARR_GET_AT = 4
const SLOT_IS_ON_CURRENT = 3
const SLOT_GET_WIN_DESKTOP_ID = 4
const SLOT_MOVE_WINDOW_TO_DESKTOP = 5
const SLOT_RELEASE = 2
/** 内部 VDMI::MoveViewToDesktop（IApplicationView + IVirtualDesktop，t407-move-window 探针实证） */
const SLOT_VDMI_MOVE_VIEW_TO_DESKTOP = 4
/** IApplicationViewCollection::GetViewForHwnd（QI0/AddRef1/Release2 起，GetViews=3…GetViewForHwnd=6） */
const SLOT_VIEW_COLL_GET_VIEW_FOR_HWND = 6

/** koffi 模块对象（module 与 dll 实例同构：load + 全部成员函数） */
interface KoffiLike {
  load(name: string): KoffiLike
  func(declaration: string): KoffiFunc
  struct(name: string, shape: Record<string, string>): void
  proto(conv: string, name: string, ret: string, args: string[]): unknown
  out(type: string): string
  call(fn: unknown, proto: unknown, ...args: unknown[]): unknown
  decode(ptr: unknown, type: string): unknown
  decode(ptr: unknown, offset: number, type: string): unknown
  as(value: unknown, type: string): unknown
}

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  koffi: KoffiLike
  /** 内部 COM 可用（false = IID 漂移/壳不可达——失败关闭，创建与切换整体离场） */
  internalAvailable: boolean
  /** 公开 VDM 查询面可用 */
  publicAvailable: boolean
  /** 内部 IApplicationViewCollection 可用（跨进程移动窗口路径，t407-move-window 探针） */
  viewCollectionAvailable: boolean
  internalPtr: unknown
  publicPtr: unknown
  viewCollectionPtr: unknown
  protos: Record<string, unknown>
  guidFromStr: (s: string) => unknown
}

let bound: Bound | null = null
let bindFailed = false

function bind(): Bound | null {
  if (bindFailed) return null
  if (bound) return bound
  try {
    const koffi = require('koffi') as KoffiLike
    const ole32 = koffi.load('ole32.dll')
    koffi.struct('VD_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' })
    const coInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)')
    const clsidFromString = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ VD_GUID *clsid)')
    const coCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(const VD_GUID *clsid, void *outer, uint32 clsCtx, const VD_GUID *iid, _Out_ void **outObj)')
    const hrInit = coInitializeEx(null, 0)
    // S_OK(0) / S_FALSE(1) / RPC_E_CHANGED_MODE(-2147417850，Electron 主线程常已 STA 初始化
    // ——线程本身已进 COM，调用照常可用）都算「初始化成立」；其余按失败关闭。
    if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx 失败 hr=${hrInit}`)
    const guidFromStr = (s: string) => {
      const g = [null]
      const hr = clsidFromString('{' + s + '}', g)
      if (hr !== 0) throw new Error(`CLSIDFromString(${s}) 失败 hr=${hr}`)
      return g[0]
    }
    const protos: Record<string, unknown> = {
      release: koffi.proto('__stdcall', 'VD_Release', 'uint32', ['void *']),
      queryService: koffi.proto('__stdcall', 'VD_QueryService', 'int32', ['void *', 'const VD_GUID *', 'const VD_GUID *', koffi.out('void **')]),
      vdmiGetCurrentDesktop: koffi.proto('__stdcall', 'VD_VdmiGetCurrentDesktop', 'int32', ['void *', koffi.out('void **')]),
      vdmiGetDesktops: koffi.proto('__stdcall', 'VD_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')]),
      vdmiSwitchDesktop: koffi.proto('__stdcall', 'VD_VdmiSwitchDesktop', 'int32', ['void *', 'void *']),
      vdmiCreateDesktop: koffi.proto('__stdcall', 'VD_VdmiCreateDesktop', 'int32', ['void *', koffi.out('void **')]),
      vdmiRemoveDesktop: koffi.proto('__stdcall', 'VD_VdmiRemoveDesktop', 'int32', ['void *', 'void *', 'void *']),
      vdGetId: koffi.proto('__stdcall', 'VD_VdGetId', 'int32', ['void *', koffi.out('VD_GUID *')]),
      objArrCount: koffi.proto('__stdcall', 'VD_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')]),
      objArrGetAt: koffi.proto('__stdcall', 'VD_ObjArrGetAt', 'int32', ['void *', 'int32', 'const VD_GUID *', koffi.out('void **')]),
      isOnCurrent: koffi.proto('__stdcall', 'VD_IsOnCurrent', 'int32', ['void *', 'uintptr_t', koffi.out('int32 *')]),
      getWinDesktopId: koffi.proto('__stdcall', 'VD_GetWinDesktopId', 'int32', ['void *', 'uintptr_t', koffi.out('VD_GUID *')]),
      moveWindowToDesktop: koffi.proto('__stdcall', 'VD_MoveWindowToDesktop', 'int32', ['void *', 'uintptr_t', 'const VD_GUID *']),
      getViewForHwnd: koffi.proto('__stdcall', 'VD_GetViewForHwnd', 'int32', ['void *', 'uintptr_t', koffi.out('void **')]),
      moveViewToDesktop: koffi.proto('__stdcall', 'VD_MoveViewToDesktop', 'int32', ['void *', 'void *', 'void *']),
    }
    const PTRSZ = 8 // x64 指针宽
    const slotOf = (obj: unknown, i: number) => koffi.decode(koffi.decode(obj, 'void *'), i * PTRSZ, 'void *')
    const releasePtr = (obj: unknown) => {
      try {
        if (obj) koffi.call(slotOf(obj, SLOT_RELEASE), protos.release!, obj)
      } catch { /* 释放失败不追（进程退出即回收） */ }
    }
    // ImmersiveShell 直接以 IID_IServiceProvider 创建（对裸 IUnknown 直调 QueryService 槽
    // 会段错误，t371 调试轮实证）
    const shell = [null]
    const hrShell = coCreateInstance(guidFromStr(CLSID.immersiveShell), null, 1 | 4, guidFromStr(IID.serviceProvider), shell)
    if (hrShell !== 0 || !shell[0]) throw new Error(`ImmersiveShell CoCreateInstance(IServiceProvider) 失败 hr=${hrShell}`)
    // QueryService(IVirtualDesktopManagerInternal@24H2/25H2)——失败即 IID 漂移，内部面整体离场
    const svc = [null]
    const hrQs = koffi.call(slotOf(shell[0], SLOT_QUERY_SERVICE), protos.queryService!, shell[0], guidFromStr(CLSID.vdManagerInternal), guidFromStr(IID.vdManagerInternal_24H2), svc)
    // 公开 VDM 独立绑定（窗口桌面 ID/IsOnCurrent/移动的查询面）
    const pub = [null]
    const hrPub = coCreateInstance(guidFromStr(CLSID.vdManager), null, 1, guidFromStr(IID.vdManager), pub)
    // 内部 IApplicationViewCollection（跨进程移动窗口路径；QueryService 双参同 IID，
    // t407-move-window 探针实证形态）——缺席只降级移动面，查询/切换/创建不受影响
    const viewColl = [null]
    const hrViewColl = koffi.call(slotOf(shell[0], SLOT_QUERY_SERVICE), protos.queryService!, shell[0], guidFromStr(IID.applicationViewCollection), guidFromStr(IID.applicationViewCollection), viewColl)
    try { releasePtr(shell[0]) } catch { /* 壳引用释放（QueryService 已持自有引用） */ }
    bound = {
      koffi,
      internalAvailable: hrQs === 0 && svc[0] != null,
      publicAvailable: hrPub === 0 && pub[0] != null,
      viewCollectionAvailable: hrViewColl === 0 && viewColl[0] != null,
      internalPtr: svc[0],
      publicPtr: pub[0],
      viewCollectionPtr: viewColl[0],
      protos,
      guidFromStr,
    }
    return bound
  } catch {
    bindFailed = true
    return null
  }
}

// —— GUID 换算（t371 坑位：COM 结构体经 koffi 解码后已是主机序数值，直接拼标准形；
// 注册表字节才是小端原码，两处换算各自独立，不可互相套用——否则同一桌面变两套永不
// 匹配的 ID 字符串） ——

function comGuidToStr(q: { d1: number; d2: number; d3: number; d4: ArrayLike<number> } | null | undefined): string {
  if (!q || !q.d4) return ''
  const p = (n: number, w: number) => n.toString(16).padStart(w, '0')
  const d4 = Array.from({ length: 8 }, (_, i) => Number(q.d4[i]))
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`
}

/** 注册表原始 16 字节（Data1/2/3 小端）→ GUID 标准形（t371 实证换算） */
export function regBytesToGuid(hex: string): string {
  const b: number[] = []
  for (let i = 0; i + 2 <= hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16))
  const p = (n: number, w: number) => n.toString(16).padStart(w, '0')
  const swap = (arr: number[]) => arr.slice().reverse().map((x) => p(x, 2)).join('')
  if (b.length < 16) return ''
  return `${swap(b.slice(0, 4))}-${swap(b.slice(4, 6))}-${swap(b.slice(6, 8))}-${b.slice(8, 10).map((x) => p(x, 2)).join('')}-${b.slice(10, 16).map((x) => p(x, 2)).join('')}`
}

// —— 注册表事实源（单查询原子读：分两次读会撞 explorer 中途更新产生错配快照，t371 实证） ——

export interface RegistryDesktopFacts {
  count: number
  ids: string[]
  current: string | null
}

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops'

function parseRegQueryOutput(out: string): RegistryDesktopFacts {
  const idsM = out.match(/VirtualDesktopIDs\s+REG_BINARY\s+([0-9A-Fa-f]+)/)
  const curM = out.match(/CurrentVirtualDesktop\s+REG_BINARY\s+([0-9A-Fa-f]+)/)
  const hexIds = idsM ? idsM[1].toUpperCase() : ''
  const ids: string[] = []
  for (let off = 0; off + 32 <= hexIds.length; off += 32) {
    const id = regBytesToGuid(hexIds.slice(off, off + 32))
    if (id) ids.push(id)
  }
  const cur = curM ? regBytesToGuid(curM[1].toUpperCase()) : ''
  return { count: ids.length, ids, current: cur || null }
}

const REG_FACTS_UNAVAILABLE: RegistryDesktopFacts = { count: 0, ids: [], current: null }

/** 注册表桌面事实（异步单查询——编排层轮询统一走这里，不阻塞 Electron 主线程） */
export function registryDesktopFacts(): Promise<RegistryDesktopFacts> {
  return new Promise((resolve) => {
    execFile('reg', ['query', REG_KEY], { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve(REG_FACTS_UNAVAILABLE)
        return
      }
      try {
        resolve(parseRegQueryOutput(String(stdout)))
      } catch {
        resolve(REG_FACTS_UNAVAILABLE)
      }
    })
  })
}

// —— 内部 COM 桥 ——

/** 内部 COM（创建/切换/删除承载面）绑定可用；false = 失败关闭，生产路径整体离场 */
export function internalAvailable(): boolean {
  return bind()?.internalAvailable === true
}

/** 公开 VDM 查询面绑定可用（窗口桌面 ID / IsOnCurrent / 移动兜底） */
export function publicAvailable(): boolean {
  return bind()?.publicAvailable === true
}

function withInternal<T>(fn: (b: Bound) => T, fallback: T): T {
  const b = bind()
  if (!b?.internalAvailable) return fallback
  try {
    return fn(b)
  } catch {
    return fallback
  }
}

/** 系统桌面全集合（内部 COM GetDesktops→IObjectArray→GetId；不可用 = 空集） */
export function desktopIds(): string[] {
  return withInternal((b) => {
    const arr = [null]
    const hr = b.koffi.call(vtSlot(b.internalPtr, SLOT_VDMI_GET_DESKTOPS), b.protos.vdmiGetDesktops!, b.internalPtr, arr)
    if (hr !== 0 || !arr[0]) return []
    try {
      const n = [0]
      b.koffi.call(vtSlot(arr[0], SLOT_OBJARR_COUNT), b.protos.objArrCount!, arr[0], n)
      const out: string[] = []
      for (let i = 0; i < n[0]; i++) {
        const d = [null]
        const r = b.koffi.call(vtSlot(arr[0], SLOT_OBJARR_GET_AT), b.protos.objArrGetAt!, arr[0], i, b.guidFromStr(IID.virtualDesktop), d)
        if (r !== 0 || !d[0]) continue
        const g = [null]
        const r2 = b.koffi.call(vtSlot(d[0], SLOT_VD_GET_ID), b.protos.vdGetId!, d[0], g)
        if (r2 === 0) {
          const id = comGuidToStr(g[0])
          if (id) out.push(id)
        }
      }
      return out
    } finally {
      releaseObj(arr[0])
    }
  }, [] as string[])
}

/** 内部 COM 直读当前桌面 ID（第二事实源，与注册表互证；不可用 = null） */
export function internalCurrentDesktopId(): string | null {
  return withInternal((b) => {
    const d = [null]
    const hr = b.koffi.call(vtSlot(b.internalPtr, SLOT_VDMI_GET_CURRENT_DESKTOP), b.protos.vdmiGetCurrentDesktop!, b.internalPtr, d)
    if (hr !== 0 || !d[0]) return null
    const g = [null]
    const r = b.koffi.call(vtSlot(d[0], SLOT_VD_GET_ID), b.protos.vdGetId!, d[0], g)
    const id = r === 0 ? comGuidToStr(g[0]) : ''
    return id || null
  }, null)
}

/**
 * 切换到目标桌面（内部 COM SwitchDesktop）。**只报告调用成败，不报告「已切换」**——
 * 成功判定在编排层以系统 ID 回读完成（spec 决策 3 不泄露乐观状态）。调用失败抛错。
 */
export function switchDesktop(id: string): void {
  const b = bind()
  if (!b?.internalAvailable) throw new Error('虚拟桌面内部 COM 不可用（失败关闭）')
  const target = desktopObjectById(id)
  if (!target) throw new Error(`目标桌面不在系统集合中: ${id}`)
  try {
    const hr = Number(b.koffi.call(vtSlot(b.internalPtr, SLOT_VDMI_SWITCH_DESKTOP), b.protos.vdmiSwitchDesktop!, b.internalPtr, target))
    if (hr !== 0) throw new Error(`SwitchDesktop 失败 hr=0x${(hr >>> 0).toString(16)}`)
  } finally {
    releaseObj(target)
  }
}

/** 新建虚拟桌面（CreateDesktop），返回新桌面系统 ID；失败抛错（编排层回收义务在案）。 */
export function createDesktop(): string {
  const b = bind()
  if (!b?.internalAvailable) throw new Error('虚拟桌面内部 COM 不可用（失败关闭）')
  const d = [null]
  const hr = Number(b.koffi.call(vtSlot(b.internalPtr, SLOT_VDMI_CREATE_DESKTOP), b.protos.vdmiCreateDesktop!, b.internalPtr, d))
  if (hr !== 0 || !d[0]) throw new Error(`CreateDesktop 失败 hr=0x${(hr >>> 0).toString(16)}`)
  try {
    const g = [null]
    const r = b.koffi.call(vtSlot(d[0], SLOT_VD_GET_ID), b.protos.vdGetId!, d[0], g)
    const id = r === 0 ? comGuidToStr(g[0]) : ''
    if (!id) throw new Error('CreateDesktop 后 GetId 失败（桌面 ID 不可读——按失败关闭处理）')
    return id
  } finally {
    releaseObj(d[0])
  }
}

/**
 * 删除虚拟桌面（RemoveDesktop，回退桌面 = fallbackId）：探针 recoverCleanup 同款纪律——
 * 创建后任何失败路径都要回收桌面（零残留硬纪律）。生产路径目前只在配对身份失效的
 * 清理口调用；fallback 缺省取系统当前桌面（RemoveDesktop 要求一个存活回退）。
 */
export function removeDesktop(id: string, fallbackId?: string): void {
  const b = bind()
  if (!b?.internalAvailable) throw new Error('虚拟桌面内部 COM 不可用（失败关闭）')
  const target = desktopObjectById(id)
  if (!target) return // 已不在集合 = 无残留，幂等
  const fallback = desktopObjectById(fallbackId ?? internalCurrentDesktopId() ?? '') ?? desktopObjectById(desktopIds()[0] ?? '')
  try {
    const hr = Number(b.koffi.call(vtSlot(b.internalPtr, SLOT_VDMI_REMOVE_DESKTOP), b.protos.vdmiRemoveDesktop!, b.internalPtr, target, fallback))
    if (hr !== 0) throw new Error(`RemoveDesktop 失败 hr=0x${(hr >>> 0).toString(16)}`)
  } finally {
    releaseObj(target)
    releaseObj(fallback)
  }
}

function desktopObjectById(id: string): unknown {
  if (!id) return null
  const b = bind()
  if (!b?.internalAvailable) return null
  const arr = [null]
  const hr = b.koffi.call(vtSlot(b.internalPtr, SLOT_VDMI_GET_DESKTOPS), b.protos.vdmiGetDesktops!, b.internalPtr, arr)
  if (hr !== 0 || !arr[0]) return null
  try {
    const n = [0]
    b.koffi.call(vtSlot(arr[0], SLOT_OBJARR_COUNT), b.protos.objArrCount!, arr[0], n)
    for (let i = 0; i < n[0]; i++) {
      const d = [null]
      const r = b.koffi.call(vtSlot(arr[0], SLOT_OBJARR_GET_AT), b.protos.objArrGetAt!, arr[0], i, b.guidFromStr(IID.virtualDesktop), d)
      if (r !== 0 || !d[0]) continue
      const g = [null]
      const r2 = b.koffi.call(vtSlot(d[0], SLOT_VD_GET_ID), b.protos.vdGetId!, d[0], g)
      if (r2 === 0 && comGuidToStr(g[0]) === id) {
        const hit = d[0]
        // 引用交由调用方释放（从数组元素持有，数组释放不影响元素引用计数）
        return hit
      }
    }
    return null
  } finally {
    releaseObj(arr[0])
  }
}

function vtSlot(obj: unknown, index: number): unknown {
  const b = bind()
  if (!b) return null
  const PTRSZ = 8
  return b.koffi.decode(b.koffi.decode(obj, 'void *'), index * PTRSZ, 'void *')
}

function releaseObj(obj: unknown): void {
  const b = bind()
  if (!b || !obj) return
  try {
    b.koffi.call(vtSlot(obj, SLOT_RELEASE), b.protos.release!, obj)
  } catch { /* 释放失败不追 */ }
}

// —— 公开 VDM 查询桥（窗口桌面归属：跟随兜底的判定与动作） ——

/** 窗口是否在当前桌面（公开 IsWindowOnCurrent；不可用/取失败 = null——调用方不猜） */
export function isWindowOnCurrentDesktop(hwnd: number): boolean | null {
  const b = bind()
  if (!b?.publicAvailable) return null
  try {
    const f = [0]
    const hr = b.koffi.call(vtSlot(b.publicPtr, SLOT_IS_ON_CURRENT), b.protos.isOnCurrent!, b.publicPtr, hwnd, f)
    if (hr !== 0) return null
    return f[0] !== 0
  } catch {
    return null
  }
}

/**
 * 窗口所属桌面系统 ID（公开 IVirtualDesktopManager::GetWindowDesktopId，工单380 跨桌面
 * 点击目标判定）：不可用/取失败 = null——调用方不猜、不切桌面（安全方向）。
 */
export function windowDesktopId(hwnd: number): string | null {
  const b = bind()
  if (!b?.publicAvailable) return null
  try {
    const g = [null]
    const hr = b.koffi.call(vtSlot(b.publicPtr, SLOT_GET_WIN_DESKTOP_ID), b.protos.getWinDesktopId!, b.publicPtr, hwnd, g)
    if (hr !== 0) return null
    const id = comGuidToStr(g[0] as { d1: number; d2: number; d3: number; d4: ArrayLike<number> } | null)
    return id || null
  } catch {
    return null
  }
}

/**
 * 把窗口移动到目标桌面（公开 MoveWindowToDesktop——desktop-bound 窗的跟随兜底路径，
 * t371 实证 S_OK 双向可用）。返回 true = 系统受理（最终归属仍以回读为准）。
 *
 * **仅限自家进程窗口**：对他进程窗实测 E_ACCESSDENIED（工单407 t407-move-window 探针
 * round2 实证）——跨进程移动（拖入迁移）走 moveWindowToDesktopInternal。
 */
export function moveWindowToDesktop(hwnd: number, id: string): boolean {
  const b = bind()
  if (!b?.publicAvailable || !id) return false
  try {
    const hr = b.koffi.call(vtSlot(b.publicPtr, SLOT_MOVE_WINDOW_TO_DESKTOP), b.protos.moveWindowToDesktop!, b.publicPtr, hwnd, b.guidFromStr(id))
    return hr === 0
  } catch {
    return false
  }
}

/**
 * 跨进程把窗口移动到目标桌面（内部 IApplicationViewCollection::GetViewForHwnd +
 * VDMI::MoveViewToDesktop，工单407 t407-move-window 探针 GO 实证：hr=0 且公开
 * GetWindowDesktopId 回读命中目标）。拖入迁移的移动真源；返回 = 系统受理与否
 * （最终归属仍以桌面 ID 回读为准，调用方确认——migrationConfirmed）。
 */
export function moveWindowToDesktopInternal(hwnd: number, id: string): boolean {
  const b = bind()
  if (!b?.viewCollectionAvailable || !b.internalAvailable || !id) return false
  let view: unknown = null
  try {
    const v = [null]
    const hrView = b.koffi.call(vtSlot(b.viewCollectionPtr, SLOT_VIEW_COLL_GET_VIEW_FOR_HWND), b.protos.getViewForHwnd!, b.viewCollectionPtr, hwnd, v)
    if (hrView !== 0 || !v[0]) return false
    view = v[0]
    const target = desktopObjectById(id)
    if (!target) return false
    try {
      const hrMove = b.koffi.call(vtSlot(b.internalPtr, SLOT_VDMI_MOVE_VIEW_TO_DESKTOP), b.protos.moveViewToDesktop!, b.internalPtr, view, target)
      return hrMove === 0
    } finally {
      releaseObj(target)
    }
  } catch {
    return false
  } finally {
    if (view) {
      try {
        b.koffi.call(vtSlot(view, SLOT_RELEASE), b.protos.release!, view)
      } catch { /* 释放尽力 */ }
    }
  }
}
