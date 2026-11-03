/**
 * 窗口预览内存缓存（工单379，spec #369 决策 15/26）：最小化窗口的最近缓存只存内存、
 * 关闭预览即释放、结构性无磁盘图像缓存。纯逻辑，零 FFI/Electron。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PreviewCache } from '../../src/main/desktop/preview-cache'

describe('预览内存缓存', () => {
  it('记住最近一帧并按 hwnd 取回（后写覆盖前写——「最近缓存」语义）', () => {
    const cache = new PreviewCache()
    cache.remember(101, { dataUrl: 'data:image/png;base64,AAA', width: 320, height: 180 })
    expect(cache.has(101)).toBe(true)
    expect(cache.peek(101)?.dataUrl).toContain('AAA')

    cache.remember(101, { dataUrl: 'data:image/png;base64,BBB', width: 320, height: 180 })
    expect(cache.peek(101)?.dataUrl).toContain('BBB')
    expect(cache.size()).toBe(1)
  })

  it('未缓存窗口返回 null；单窗遗忘只清一条', () => {
    const cache = new PreviewCache()
    cache.remember(1, { dataUrl: 'data:image/png;base64,1', width: 1, height: 1 })
    cache.remember(2, { dataUrl: 'data:image/png;base64,2', width: 1, height: 1 })
    expect(cache.peek(3)).toBeNull()
    cache.forget(1)
    expect(cache.peek(1)).toBeNull()
    expect(cache.peek(2)).not.toBeNull()
    expect(cache.size()).toBe(1)
  })

  it('关闭预览即释放全部缓存（clear 后 size=0，且不再可取）', () => {
    const cache = new PreviewCache()
    cache.remember(7, { dataUrl: 'data:image/png;base64,X', width: 4, height: 4 })
    cache.remember(8, { dataUrl: 'data:image/png;base64,Y', width: 4, height: 4 })
    cache.clear()
    expect(cache.size()).toBe(0)
    expect(cache.peek(7)).toBeNull()
    expect(cache.peek(8)).toBeNull()
  })

  it('结构性无磁盘写路径：模块源码不引入 fs / 不写文件（与 373 探针 S6d 同口径）', () => {
    const src = readFileSync(join(__dirname, '../../src/main/desktop/preview-cache.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)|writeFile|createWriteStream/)
  })
})
