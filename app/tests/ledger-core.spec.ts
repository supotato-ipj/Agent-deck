// 证据分类账聚合纯核（spec #281）——TS 测 JS 核，先例：tests/accept/manifest-check.spec.ts。
// seam＝纯函数入口：blob 行集 [{path,size}] → 按扩展名/按二级目录的字节+计数聚合（降序）。
// 喂真实形状样例（多版本同名文件、无扩展名 blob、深层目录、增量场景），断言聚合数字与
// 排序；不断言内部结构。CLI 壳（scripts/evidence-ledger.js）不测。
import { describe, expect, it } from 'vitest'

interface Bucket {
  key: string
  bytes: number
  count: number
}
interface Ledger {
  total: { bytes: number; count: number }
  byExtension: Bucket[]
  byDirectory: Bucket[]
}

const { aggregate, extensionOf, directoryOf, NO_EXTENSION, ROOT_DIR } = require('../scripts/lib/ledger-core.js') as {
  aggregate: (rows: Array<{ path: string; size: number }>) => Ledger
  extensionOf: (p: string) => string
  directoryOf: (p: string) => string
  NO_EXTENSION: string
  ROOT_DIR: string
}

/** 真实形状行集：多版本同名 PNG（历代重拍累积）+ 文本审计链 + 深层目录 + 根级文件 + 无扩展名 */
function fxRows(): Array<{ path: string; size: number }> {
  return [
    // 同一 path 两个历史版本（重拍两次，8M 级——正是要量化的累积）
    { path: 'app/accept/evidence/03-tray-baseline.png', size: 8_000_000 },
    { path: 'app/accept/evidence/03-tray-baseline.png', size: 8_100_000 },
    { path: 'app/accept/evidence/08-opacity-low.png', size: 7_500_000 },
    // 文本审计链（分级口径里随轮入库的那部分）
    { path: 'app/accept/evidence/03-battery.log.txt', size: 12_000 },
    { path: 'app/accept/evidence/03-runtime-events.jsonl', size: 340_000 },
    // 深层目录：二级目录聚合取前两级
    { path: 'app/src/main/trayhost/protocol.ts', size: 9_000 },
    { path: '.scratch/listary-search/evidence/04-idle-desktop.png', size: 2_000_000 },
    { path: 'archive/wallpaper-assets/backup/original/img/pixel.png', size: 1_000 },
    // 根级文件（二级目录 → 根目录桶）
    { path: 'README.md', size: 5_000 },
    // 无扩展名家族：裸名、点开头裸名、末尾点
    { path: 'LICENSE', size: 1_100 },
    { path: '.gitignore', size: 900 },
    { path: 'app/dist/something.', size: 300 },
  ]
}

describe('扩展名聚合（字节降序）', () => {
  it('多版本同名 PNG 两行各计：png 桶 count=5 bytes=25_601_000（重拍累积不去重）', () => {
    const r = aggregate(fxRows())
    const png = r.byExtension.find((b) => b.key === 'png')
    expect(png).toEqual({ key: 'png', bytes: 25_601_000, count: 5 })
  })

  it('大小写归一：.PNG 与 .png 同桶', () => {
    const r = aggregate([
      { path: 'a/b/one.png', size: 100 },
      { path: 'a/b/two.PNG', size: 200 },
    ])
    expect(r.byExtension).toEqual([{ key: 'png', bytes: 300, count: 2 }])
  })

  it('无扩展名桶：裸名/点开头/末尾点都归 (无扩展名)，扩展名小写归一', () => {
    expect(extensionOf('LICENSE')).toBe(NO_EXTENSION)
    expect(extensionOf('.gitignore')).toBe(NO_EXTENSION)
    expect(extensionOf('app/dist/something.')).toBe(NO_EXTENSION)
    expect(extensionOf('a/b/x.JSONL')).toBe('jsonl')
    const r = aggregate([
      { path: 'LICENSE', size: 1_100 },
      { path: '.gitignore', size: 900 },
      { path: 'app/dist/something.', size: 300 },
    ])
    expect(r.byExtension).toEqual([{ key: NO_EXTENSION, bytes: 2_300, count: 3 }])
  })

  it('排序：字节降序，平字节时计数降序，再平按 key 码点升序（全确定性）', () => {
    const r = aggregate([
      { path: 'x/bb/aa.png', size: 100 },
      { path: 'x/aa/zz.log', size: 300 },
      { path: 'x/cc/mm.jsonl', size: 300 },
      { path: 'x/aa/bb.md', size: 100 },
      { path: 'x/aa/aa.md', size: 100 },
    ])
    expect(r.byExtension.map((b) => b.key)).toEqual(['jsonl', 'log', 'md', 'png'])
    expect(r.byExtension.find((b) => b.key === 'md')).toEqual({ key: 'md', bytes: 200, count: 2 })
  })

  it('真实形状全表：扩展名序列与占比基数对（25.6M png 占绝对大头）', () => {
    const r = aggregate(fxRows())
    expect(r.byExtension.map((b) => b.key)).toEqual(['png', 'jsonl', 'txt', 'ts', 'md', NO_EXTENSION])
    expect(r.total.bytes).toBe(25_601_000 + 340_000 + 12_000 + 9_000 + 5_000 + 2_300)
    expect(r.total.count).toBe(12)
  })
})

describe('二级目录聚合（前两级路径）', () => {
  it('深层路径取前两级；根级文件归 (根目录)', () => {
    expect(directoryOf('app/accept/evidence/03-tray-baseline.png')).toBe('app/accept')
    expect(directoryOf('docs/adr/0004-x.md')).toBe('docs/adr')
    expect(directoryOf('README.md')).toBe(ROOT_DIR)
    const r = aggregate(fxRows())
    expect(r.byDirectory.map((b) => b.key)).toEqual([
      'app/accept',
      '.scratch/listary-search',
      'app/src',
      '(根目录)',
      'archive/wallpaper-assets',
      'app/dist',
    ])
    const appAccept = r.byDirectory.find((b) => b.key === 'app/accept')
    expect(appAccept).toEqual({ key: 'app/accept', bytes: 8_000_000 + 8_100_000 + 7_500_000 + 12_000 + 340_000, count: 5 })
  })

  it('排序：字节降序；空桶输出空数组', () => {
    expect(aggregate([]).byDirectory).toEqual([])
    expect(aggregate([]).byExtension).toEqual([])
    expect(aggregate([]).total).toEqual({ bytes: 0, count: 0 })
  })
})

describe('增量场景（--since 喂同一聚合核）', () => {
  it('基线以来新引入行集喂同一核：PNG 增量如实出现/为 0 时 byExtension 无 png 桶', () => {
    const fullHistory = fxRows()
    // 分级入库后的增量轮：只有文本审计链、无任何 PNG——png 桶必须缺席而非 0 行假象
    const sinceRows = fullHistory.filter((r) => !r.path.endsWith('.png'))
    const since = aggregate(sinceRows)
    expect(since.byExtension.find((b) => b.key === 'png')).toBeUndefined()
    expect(since.total.bytes).toBe(340_000 + 12_000 + 9_000 + 5_000 + 2_300)
    // 同一核喂全史行集，数字必须与单独聚合一致（聚合核不感知范围语义）
    const full = aggregate(fullHistory)
    expect(full.total.count).toBe(12)
    expect(full.total.count).toBeGreaterThan(since.total.count)
  })
})

describe('防御：脏行跳过不炸（测量工具不吃脏行）', () => {
  it('path 非字符串 / size 非有限 / 负尺寸 / 非数组输入 → 跳过或空结果', () => {
    const r = aggregate([
      { path: 'ok/a.png', size: 10 },
      { path: 42 as never, size: 999 },
      { path: 'ok/b.png', size: Number.NaN },
      { path: 'ok/c.png', size: -5 },
      null as never,
    ])
    expect(r.total).toEqual({ bytes: 10, count: 1 })
    expect(aggregate(undefined as never).total).toEqual({ bytes: 0, count: 0 })
  })
})
