import { describe, expect, it, vi } from 'vitest'
import { IconCache, shortcutIconSource } from '../../src/main/desktop/icons'

/** 图标提取缓存（工单05 验收：提取纯逻辑 vitest 覆盖） */
describe('IconCache', () => {
  it('成功即缓存，二次取不重提取', async () => {
    const extract = vi.fn(async () => 'data:image/png;base64,AAA')
    const cache = new IconCache(extract)
    expect(await cache.fetch('k1', 'C:\\a.lnk')).toBe('data:image/png;base64,AAA')
    expect(await cache.fetch('k1', 'C:\\a.lnk')).toBe('data:image/png;base64,AAA')
    expect(extract).toHaveBeenCalledTimes(1)
    expect(cache.peek('k1')).toBe('data:image/png;base64,AAA')
    expect(cache.needsWork('k1')).toBe(false)
  })

  it('并发同键共用同一 Promise，只提取一次', async () => {
    let resolveFn!: (v: string | null) => void
    const extract = vi.fn(() => new Promise<string | null>((res) => { resolveFn = res }))
    const cache = new IconCache(extract)
    const p1 = cache.fetch('k1', 'C:\\a.lnk')
    const p2 = cache.fetch('k1', 'C:\\a.lnk')
    await Promise.resolve() // fetch 经微任务才调提取器
    resolveFn('data:1')
    expect(await p1).toBe('data:1')
    expect(await p2).toBe('data:1')
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('提取失败重试至上限后退避缓存 null（毒键不每拍重提取）', async () => {
    const extract = vi.fn(async () => { throw new Error('boom') })
    const cache = new IconCache(extract, 3)
    for (let round = 0; round < 2; round++) {
      expect(await cache.fetch('k1', 'C:\\a.lnk')).toBeNull()
      expect(cache.needsWork('k1')).toBe(true) // 未达上限不缓存，下一拍可重试
    }
    expect(extract).toHaveBeenCalledTimes(2)
    expect(await cache.fetch('k1', 'C:\\a.lnk')).toBeNull() // 第 3 次：达上限
    expect(extract).toHaveBeenCalledTimes(3)
    expect(cache.needsWork('k1')).toBe(false)
    expect(cache.peek('k1')).toBeNull() // null 也是已解析值
    expect(await cache.fetch('k1', 'C:\\a.lnk')).toBeNull()
    expect(extract).toHaveBeenCalledTimes(3) // 此后不再提取
  })

  it('提取器解析 null（合法空图标）直接缓存，不计失败', async () => {
    const extract = vi.fn(async () => null)
    const cache = new IconCache(extract)
    expect(await cache.fetch('k1', 'C:\\a.lnk')).toBeNull()
    expect(await cache.fetch('k1', 'C:\\a.lnk')).toBeNull()
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('提取器同步抛错同样走失败计数（不穿透调用方）', async () => {
    const extract = vi.fn(() => { throw new Error('sync boom') }) as unknown as () => Promise<string | null>
    const cache = new IconCache(extract, 1)
    await expect(cache.fetch('k1', 'C:\\a.lnk')).resolves.toBeNull()
    expect(cache.needsWork('k1')).toBe(false) // 上限 1 已耗尽
  })

  it('不同键各自独立缓存', async () => {
    const extract = vi.fn(async (p: string) => `icon:${p}`)
    const cache = new IconCache(extract)
    expect(await cache.fetch('k1', 'C:\\a.lnk')).toBe('icon:C:\\a.lnk')
    expect(await cache.fetch('k2|9', 'C:\\b.txt')).toBe('icon:C:\\b.txt')
    expect(extract).toHaveBeenCalledTimes(2)
  })
})

/** 快捷方式图标源决策（工单01；工单06 演进为携带图标索引、目录可作目标）：
 * 图标定位优先 / 目标回落 / 死链 null，exists 判定注入可离线测 */
describe('shortcutIconSource', () => {
  // 注入式存在性判定：路径含 MISSING 即不存在（离线无需真文件系统）
  const exists = (p: string) => !p.includes('MISSING')
  const ICON = 'C:\\apps\\app.ico'
  const EXE = 'C:\\apps\\app.exe'

  it('声明的图标定位存在 → 优先对图标定位本体提取，并随其索引', () => {
    expect(shortcutIconSource(ICON, EXE, exists, 7)).toEqual({ source: ICON, iconIndex: 7 })
  })

  it('未声明图标定位（空串/null/undefined）→ 回落目标，索引归 0', () => {
    expect(shortcutIconSource('', EXE, exists, 7)).toEqual({ source: EXE, iconIndex: 0 })
    expect(shortcutIconSource(null, EXE, exists, 7)).toEqual({ source: EXE, iconIndex: 0 })
    expect(shortcutIconSource(undefined, EXE, exists)).toEqual({ source: EXE, iconIndex: 0 })
  })

  it('声明了但文件不存在 → 回落目标（0 号图标）', () => {
    expect(shortcutIconSource('C:\\MISSING\\icon.ico', EXE, exists, 3)).toEqual({ source: EXE, iconIndex: 0 })
  })

  it('双缺失（定位与目标都不可用）→ null（调用方回落对 lnk 本体提取）', () => {
    expect(shortcutIconSource('C:\\MISSING\\icon.ico', 'C:\\MISSING\\app.exe', exists, 3)).toBeNull()
    expect(shortcutIconSource('', null, exists)).toBeNull()
  })

  it('目标也缺失/未声明 → null；exists 判定只认注入的结论', () => {
    expect(shortcutIconSource('', 'C:\\MISSING\\app.exe', exists)).toBeNull()
    // 目录（exists=false）不算可用源：决策不猜路径形态，只认判定
    expect(shortcutIconSource(ICON, EXE, () => false, 3)).toBeNull()
  })

  it('目录目标被存在性判真即可用（工单06：.lnk 可指向文件夹，目录图标交 getFileIcon）', () => {
    const DIR = 'D:\\work\\02专项工作'
    expect(shortcutIconSource('', DIR, exists, 0)).toEqual({ source: DIR, iconIndex: 0 })
    // 图标定位缺失而目标为目录：同样成立，索引归 0
    expect(shortcutIconSource(null, DIR, exists, 5)).toEqual({ source: DIR, iconIndex: 0 })
  })
})
