// 证据分类账纯核（spec #281）——TS 测 JS 核，先例：tests/accept/manifest-check.spec.ts。
// seam＝原始 git 行流：rev-list --objects 行（`<sha> <path>`）与 cat-file --batch-check 行
// （`<sha> <type> <size>`／`<sha> missing`）→ 纯核解析 → 聚合（按扩展名/按二级目录，降序）。
// 喂真实形状的原始行样例（多版本同名文件、无扩展名 blob、深层目录、tree/commit/missing
// 混入、--since 增量场景），断言聚合数字与排序；不断言内部结构。CLI 壳（spawn git）不测。
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

const {
  aggregate,
  extensionOf,
  directoryOf,
  parseRevListObjects,
  parseBatchCheck,
  ledgerFromRawLines,
  NO_EXTENSION,
  ROOT_DIR,
} = require('../scripts/lib/ledger-core.js') as {
  aggregate: (rows: Array<{ path: string; size: number }>) => Ledger
  extensionOf: (p: string) => string
  directoryOf: (p: string) => string
  parseRevListObjects: (stdout: string) => { shas: string[]; pathsBySha: Map<string, string> }
  parseBatchCheck: (stdout: string, pathsBySha: Map<string, string>) => Array<{ path: string; size: number }>
  ledgerFromRawLines: (revListOut: string, batchCheckOut: string) => Ledger
  NO_EXTENSION: string
  ROOT_DIR: string
}

type CatKind = 'blob' | 'tree' | 'commit' | 'missing'

/** 一条 rev-list 对象：rev 行是 `<sha> <path>`（path 空则裸 sha）；cat-file 行形状由 kind/size 定 */
interface FxEntry {
  sha: string
  path: string
  kind: CatKind
  size: number
}

/** 40 位十六进制 sha（同 rev-list 实际输出的形状），计数器生成保证互异 */
let shaCounter = 0
function newSha(): string {
  shaCounter += 1
  return shaCounter.toString(16).padStart(40, '0')
}
function entry(path: string, kind: CatKind, size: number): FxEntry {
  return { sha: newSha(), path, kind, size }
}

/** 真实形状对象清单：多版本同名 PNG（历代重拍累积）+ 文本审计链 + 深层目录 + 根级文件 + 无扩展名家族 */
function fxEntries(): FxEntry[] {
  return [
    // 同一 path 两个历史版本（重拍两次，8M 级——正是要量化的累积）
    entry('app/accept/evidence/03-tray-baseline.png', 'blob', 8_000_000),
    entry('app/accept/evidence/03-tray-baseline.png', 'blob', 8_100_000),
    entry('app/accept/evidence/08-opacity-low.png', 'blob', 7_500_000),
    // 文本审计链（分级口径里随轮入库的那部分）
    entry('app/accept/evidence/03-battery.log.txt', 'blob', 12_000),
    entry('app/accept/evidence/03-runtime-events.jsonl', 'blob', 340_000),
    // 深层目录：二级目录聚合取前两级
    entry('app/src/main/trayhost/protocol.ts', 'blob', 9_000),
    entry('.scratch/listary-search/evidence/04-idle-desktop.png', 'blob', 2_000_000),
    entry('archive/wallpaper-assets/backup/original/img/pixel.png', 'blob', 1_000),
    // 根级文件（二级目录 → 根目录桶）
    entry('README.md', 'blob', 5_000),
    // 无扩展名家族：裸名、点开头裸名、末尾点
    entry('LICENSE', 'blob', 1_100),
    entry('.gitignore', 'blob', 900),
    entry('app/dist/something.', 'blob', 300),
  ]
}

interface FxRaw {
  entries: FxEntry[]
  revListOut: string
  batchCheckOut: string
}

/** rev-list/cat-file 两段原始行流组装：cat-file 按 rev-list 行序逐条应答，kind 定行形状 */
function assembleRaw(entries: FxEntry[]): { revListOut: string; batchCheckOut: string } {
  const revListOut = entries
    .map((e) => (e.path ? `${e.sha} ${e.path}` : e.sha))
    .join('\n') + '\n'
  const batchCheckOut = entries
    .map((e) => (e.kind === 'missing' ? `${e.sha} missing` : `${e.sha} ${e.kind} ${e.size}`))
    .join('\n') + '\n'
  return { revListOut, batchCheckOut }
}

/** 全史真实形状行流：混入 commit 裸行（--all 首行）与 tree 行，再加一条 rev-list 给出、
    cat-file 应答 missing 的 PNG（对象取不到的真实形状）——三者都必须被核剔除 */
function fxRaw(): FxRaw {
  const entries = [entry('', 'commit', 245), entry('app', 'tree', 312), ...fxEntries()]
  const lost = entry('app/accept/evidence/02-lost-run.png', 'missing', 6_400_000)
  entries.push(lost)
  return { entries, ...assembleRaw(entries) }
}

describe('原始行解析（从壳下沉进核的两段）', () => {
  it('rev-list 行：commit 裸行无 path、shas 首现序去重、同 sha 多行末次 path 胜出、path 内空格原样保留', () => {
    const a = newSha()
    const b = newSha()
    const out = ['', `${a}`, `${b} docs/old.md`, `${a} docs/new.md`, `  ${b}  x/y.md  `, ''].join('\n')
    const { shas, pathsBySha } = parseRevListObjects(out)
    expect(shas).toEqual([a, b])
    expect(pathsBySha.get(a)).toBe('docs/new.md')
    expect(pathsBySha.get(b)).toBe('x/y.md')
    const s = newSha()
    expect(parseRevListObjects(`${s} docs/notes/my note.md\n`).pathsBySha.get(s)).toBe('docs/notes/my note.md')
  })

  it('cat-file 行：blob 才入行集，tree/commit/missing 剔除；未知 sha 空 path；短行/负尺寸/非数字跳过', () => {
    const blobA = newSha()
    const treeT = newSha()
    const commitC = newSha()
    const unknown = newSha()
    const dirty = newSha()
    const map = new Map([
      [blobA, 'a/one.png'],
      [treeT, 'app'],
      [commitC, ''],
    ])
    const rows = parseBatchCheck(
      [
        `${blobA} blob 100`,
        `${treeT} tree 312`,
        `${commitC} commit 245`,
        `${unknown} blob 200`,
        `${dirty} missing`,
        `${dirty} blob -5`,
        `${dirty} blob abc`,
        `${dirty} blob`,
        '',
        '   ',
      ].join('\n') + '\n',
      map,
    )
    expect(rows).toEqual([
      { path: 'a/one.png', size: 100 },
      { path: '', size: 200 },
    ])
  })
})

describe('壳流程等价（两段式调用 = 顶层一步到账）', () => {
  it('parseRevListObjects →（壳在此喂 cat-file）→ parseBatchCheck → aggregate 与 ledgerFromRawLines 同结果', () => {
    const raw = fxRaw()
    const { shas, pathsBySha } = parseRevListObjects(raw.revListOut)
    // 壳把 shas 逐行喂 cat-file stdin：请求集＝rev-list 列出的全部对象（首现序去重）
    const listedShas = new Set(raw.entries.map((e) => e.sha))
    expect(shas.length).toBe(listedShas.size)
    expect(new Set(shas)).toEqual(listedShas)
    const rows = parseBatchCheck(raw.batchCheckOut, pathsBySha)
    // 行集＝12 条 blob（commit/tree/missing 不入行集），聚合与顶层一步完全同数字
    expect(rows.length).toBe(12)
    expect(aggregate(rows)).toEqual(ledgerFromRawLines(raw.revListOut, raw.batchCheckOut))
  })
})

describe('扩展名聚合（原始行流喂入，字节降序）', () => {
  it('多版本同名 PNG 两行各计：png 桶 count=5 bytes=25_601_000（重拍累积不去重；missing PNG 不计）', () => {
    const raw = fxRaw()
    const r = ledgerFromRawLines(raw.revListOut, raw.batchCheckOut)
    const png = r.byExtension.find((b) => b.key === 'png')
    expect(png).toEqual({ key: 'png', bytes: 25_601_000, count: 5 })
  })

  it('大小写归一：.PNG 与 .png 同桶', () => {
    const { revListOut, batchCheckOut } = assembleRaw([
      entry('a/b/one.png', 'blob', 100),
      entry('a/b/two.PNG', 'blob', 200),
    ])
    expect(ledgerFromRawLines(revListOut, batchCheckOut).byExtension).toEqual([{ key: 'png', bytes: 300, count: 2 }])
  })

  it('无扩展名桶：裸名/点开头/末尾点都归 (无扩展名)，扩展名小写归一', () => {
    expect(extensionOf('LICENSE')).toBe(NO_EXTENSION)
    expect(extensionOf('.gitignore')).toBe(NO_EXTENSION)
    expect(extensionOf('app/dist/something.')).toBe(NO_EXTENSION)
    expect(extensionOf('a/b/x.JSONL')).toBe('jsonl')
    const { revListOut, batchCheckOut } = assembleRaw([
      entry('LICENSE', 'blob', 1_100),
      entry('.gitignore', 'blob', 900),
      entry('app/dist/something.', 'blob', 300),
    ])
    const r = ledgerFromRawLines(revListOut, batchCheckOut)
    expect(r.byExtension).toEqual([{ key: NO_EXTENSION, bytes: 2_300, count: 3 }])
  })

  it('排序：字节降序，平字节时计数降序，再平按 key 码点升序（全确定性）', () => {
    const { revListOut, batchCheckOut } = assembleRaw([
      entry('x/bb/aa.png', 'blob', 100),
      entry('x/aa/zz.log', 'blob', 300),
      entry('x/cc/mm.jsonl', 'blob', 300),
      entry('x/aa/bb.md', 'blob', 100),
      entry('x/aa/aa.md', 'blob', 100),
    ])
    const r = ledgerFromRawLines(revListOut, batchCheckOut)
    expect(r.byExtension.map((b) => b.key)).toEqual(['jsonl', 'log', 'md', 'png'])
    expect(r.byExtension.find((b) => b.key === 'md')).toEqual({ key: 'md', bytes: 200, count: 2 })
  })

  it('真实形状全表：扩展名序列与占比基数对（25.6M png 占绝对大头；commit/tree/missing 行不计）', () => {
    const raw = fxRaw()
    const r = ledgerFromRawLines(raw.revListOut, raw.batchCheckOut)
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
    const raw = fxRaw()
    const r = ledgerFromRawLines(raw.revListOut, raw.batchCheckOut)
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

  it('空行流 → 空桶空数组（输出空表，不炸）', () => {
    expect(ledgerFromRawLines('', '').byDirectory).toEqual([])
    expect(ledgerFromRawLines('', '').byExtension).toEqual([])
    expect(ledgerFromRawLines('', '').total).toEqual({ bytes: 0, count: 0 })
    expect(aggregate([]).byDirectory).toEqual([])
  })
})

describe('增量场景（--since 范围的原始行流喂同一核）', () => {
  it('基线以来新引入行流喂同一核：PNG 增量为 0 时 byExtension 无 png 桶（缺席而非 0 行假象）', () => {
    const since = assembleRaw([
      entry('', 'commit', 231), // 范围内 commit 行：裸 sha
      entry('docs/agents/battery-governance.md', 'blob', 4_200),
      entry('app/accept/evidence/03-verdict.txt', 'blob', 41_000),
      entry('app/accept/evidence/03-runtime-events.jsonl', 'blob', 300_000),
    ])
    const r = ledgerFromRawLines(since.revListOut, since.batchCheckOut)
    expect(r.byExtension.find((b) => b.key === 'png')).toBeUndefined()
    expect(r.total.bytes).toBe(4_200 + 41_000 + 300_000)
    expect(r.total.count).toBe(3)
    // 同一核喂全史行流，数字必须与单独聚合一致（聚合核不感知范围语义）
    const raw = fxRaw()
    const full = ledgerFromRawLines(raw.revListOut, raw.batchCheckOut)
    expect(full.total.count).toBe(12)
    expect(full.total.count).toBeGreaterThan(r.total.count)
  })
})

describe('防御：脏行流跳过不炸（测量工具不吃脏行）', () => {
  it('rev-list 空行/纯空白、cat-file 短行/负尺寸/非数字/missing → 跳过，只有合法 blob 入账', () => {
    const good = newSha()
    const revListOut = ['', '   ', `${good} ok/a.png`, `${newSha()} docs/ghost.md`].join('\n') + '\n'
    const batchCheckOut = [
      `${good} blob 10`,
      'garbage-line', // 单 token 短行跳过
      `${newSha()} blob -5`,
      `${newSha()} blob NaN`,
      `${newSha()} missing`,
      '',
    ].join('\n') + '\n'
    const r = ledgerFromRawLines(revListOut, batchCheckOut)
    expect(r.total).toEqual({ bytes: 10, count: 1 })
  })

  it('aggregate 直喂行集仍防御：path 非字符串 / size 非有限 / 负尺寸 / 非数组输入 → 跳过或空结果', () => {
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
