// 窗口预览内存缓存（工单379，spec #369 决策 15/26）：最小化窗口的「最近缓存」只存内存，
// 预览关闭即整体释放，不建立磁盘图像缓存。纯数据结构——抓取（PrintWindow）在
// desktop/thumbnails.ts，模式裁决在 desktop/preview-projection.ts，生命周期由
// services/window-preview.ts 收口。
//
// 隐私边界（决策 26 / ADR-0002）：本模块只持有位图与尺寸，不持窗口标题；清理是结构性
// 保证（无 fs 写路径），不是运行期约定。

/** 一帧缩略图缓存（PNG dataURL + 像素尺寸） */
export interface PreviewCacheEntry {
  dataUrl: string
  width: number
  height: number
}

/** 最小化窗口最近缓存（hwnd → 帧；内存 only，clear 即释放） */
export class PreviewCache {
  private readonly frames = new Map<number, PreviewCacheEntry>()

  /** 记住一帧（后写覆盖前写——重开预览抓到的更新帧替换旧帧） */
  remember(hwnd: number, entry: PreviewCacheEntry): void {
    this.frames.set(hwnd, entry)
  }

  /** 取最近一帧；无缓存返回 null */
  peek(hwnd: number): PreviewCacheEntry | null {
    return this.frames.get(hwnd) ?? null
  }

  has(hwnd: number): boolean {
    return this.frames.has(hwnd)
  }

  /** 单窗遗忘（窗口关闭/身份被复用） */
  forget(hwnd: number): void {
    this.frames.delete(hwnd)
  }

  size(): number {
    return this.frames.size
  }

  /** 关闭预览：释放全部位图引用 */
  clear(): void {
    this.frames.clear()
  }
}
