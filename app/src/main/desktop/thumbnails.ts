// 窗口缩略图 FFI 适配层（工单379，spec #369 决策 15 + 373 探针 go 裁决）：
// 生产窗口预览链的原生承重面——DWM 实时缩略图注册/更新/注销。
//
// 373 探针实证的硬约束（app/accept/evidence/373-window-thumbnail-probe.log.txt）：
// - 目标窗必须由**本进程**持有（跨进程目标 DwmRegisterThumbnail 返回 E_INVALIDARG）——
//   生产由 panel 主进程创建预览 BrowserWindow 并在此注册（决策 15「目标窗必须由面板持有」）；
// - DWM 实时关系逐张填入 12–23ms、注销后目标窗回底色、不产生磁盘图像文件。
//
// 为什么本模块**不含 PrintWindow 抓帧**：真机构建期实证 PrintWindow(PW_RENDERFULLCONTENT)
// 对 WPF 窗会无限期阻塞调用线程（面板主进程被冻 30s、独立复现脚本直接挂死）——主进程
// 不能对第三方窗做同步跨进程绘制。最小化缓存改由预览窗控制器对「已由 DWM 合成的预览窗
// 画面」做一次异步屏幕取景（desktopCapturer，不阻塞主线程），见 preview-window.ts。
//
// 边界：本模块只做效果（注册/更新/注销），不做裁决——模式回退（注册失败 → 图标+标题）
// 由 services/window-preview.ts 与预览窗控制器收口。lazy bind（geom-write 同款）：
// 模块加载不触 FFI，首调才 require koffi——离线纯函数测试零 FFI 实害。

/** 渲染区矩形（物理 px，目标窗客户区坐标——DWM 缩略图目标矩形口径） */
export interface ThumbRect {
  left: number
  top: number
  right: number
  bottom: number
}

const DWM_TNP_RECTDESTINATION = 0x1
const DWM_TNP_VISIBLE = 0x8
const DWM_TNP_OPACITY = 0x4

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  register: KoffiFunc
  unregister: KoffiFunc
  update: KoffiFunc
  isWindow: KoffiFunc
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi')
  const dwmapi = koffi.load('dwmapi.dll')
  const user32 = koffi.load('user32.dll')

  // 具名 struct 进程级单登（#153 教训）：前缀本模块独有
  koffi.struct('DECK_THUMB_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  koffi.struct('DECK_THUMB_PROPS', {
    dwFlags: 'uint32',
    rcDestination: 'DECK_THUMB_RECT',
    rcSource: 'DECK_THUMB_RECT',
    opacity: 'uint8',
    fVisible: 'int32',
    fSourceClientAreaOnly: 'int32',
  })

  bound = {
    register: dwmapi.func('int32 __stdcall DwmRegisterThumbnail(uintptr_t hwndDestination, uintptr_t hwndSource, _Out_ void **phThumbnailId)'),
    unregister: dwmapi.func('int32 __stdcall DwmUnregisterThumbnail(void *hThumbnailId)'),
    update: dwmapi.func('int32 __stdcall DwmUpdateThumbnailProperties(void *hThumbnailId, _In_ DECK_THUMB_PROPS *props)'),
    isWindow: user32.func('bool __stdcall IsWindow(uintptr_t hWnd)'),
  }
  return bound
}

/**
 * 注册一条 DWM 实时缩略图关系（目标窗 → 源窗）并填入目标矩形。返回关系句柄；
 * 任何失败（含跨进程目标 E_INVALIDARG、源窗已销毁）返回 null——调用方回退图标+标题。
 */
export function registerThumbnail(destHwnd: number, sourceHwnd: number, rect: ThumbRect): unknown | null {
  try {
    const b = bind()
    if (!b.isWindow(destHwnd) || !b.isWindow(sourceHwnd)) return null
    const out: unknown[] = [null]
    const hr = Number(b.register(destHwnd, sourceHwnd, out))
    const thumb = out[0]
    if (hr !== 0 || !thumb) return null
    if (!updateThumbnail(thumb, rect)) {
      unregisterThumbnail(thumb)
      return null
    }
    return thumb
  } catch {
    return null
  }
}

/** 更新关系目标矩形（滚动/布局变化；失败按不可见处理，关系仍可注销） */
export function updateThumbnail(thumb: unknown, rect: ThumbRect): boolean {
  try {
    const b = bind()
    const props = {
      dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY,
      rcDestination: { ...rect },
      rcSource: { left: 0, top: 0, right: 0, bottom: 0 },
      opacity: 255,
      fVisible: 1,
      fSourceClientAreaOnly: 0,
    }
    return Number(b.update(thumb, props)) === 0
  } catch {
    return false
  }
}

/** 注销一条关系（关闭预览/条目滚出/状态复位） */
export function unregisterThumbnail(thumb: unknown): void {
  try {
    if (thumb) bind().unregister(thumb)
  } catch {
    /* 收尾尽力 */
  }
}

/** 窗口是否仍存活（预览刷新/选中前的安全判据） */
export function windowAlive(hwnd: number): boolean {
  try {
    return Boolean(bind().isWindow(hwnd))
  } catch {
    return false
  }
}
