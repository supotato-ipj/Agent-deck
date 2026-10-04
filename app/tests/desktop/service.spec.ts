/**
 * 桌面承载服务测试（工单05 扫描/失败沿用/图标/launch + 工单06 编排/摆位/监听/频次）。
 * 依赖束全假源，纯离线。
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { DesktopService } from '../../src/main/services/desktop'
import type { DesktopDirEntry } from '../../src/main/desktop/scan'
import type { ScoreItem } from '../../src/main/usage/score'

function entry(name: string, over: Partial<DesktopDirEntry> = {}): DesktopDirEntry {
  return { name, isDirectory: false, isHidden: false, mtimeMs: 1000, ...over }
}

interface WorldOptions {
  store?: string | null
  scores?: (items: ScoreItem[], resolve: (p: string) => string | null) => Map<string, number>
  targets?: Record<string, string>
}

function fakeWorld(user: DesktopDirEntry[], common: DesktopDirEntry[] = [], opts: WorldOptions = {}) {
  const extract = vi.fn(async (p: string) => `icon:${p}`)
  const open = vi.fn(async () => '')
  const reveal = vi.fn()
  const copyText = vi.fn()
  const watchCalls: Array<() => void> = []
  const watch = vi.fn((_roots: { user: string; common: string }, onChange: () => void) => {
    watchCalls.push(onChange)
    return () => {}
  })
  let userEntries = user
  let commonEntries = common
  let failScan = false
  let storeText: string | null = opts.store ?? null
  const written: string[] = []
  const ctx = new Context()
  const svc = new DesktopService(ctx, {
    roots: { user: 'C:\\u', common: 'C:\\c' },
    deps: {
      listDir: (dir: string) => {
        if (failScan) throw new Error('dir gone')
        return dir === 'C:\\u' ? userEntries : commonEntries
      },
      extractIcon: extract,
      open,
      reveal,
      copyText,
      watch,
      readShortcutTarget: (p: string) => (opts.targets ?? {})[p] ?? null,
      readStoreText: () => storeText,
      writeStoreText: (_f, text) => {
        storeText = text
        written.push(text)
      },
      iconScores: opts.scores ?? (() => new Map()),
    },
  })
  return {
    ctx,
    svc,
    extract,
    open,
    reveal,
    copyText,
    watchCalls,
    written,
    get storeText() {
      return storeText
    },
    setEntries(v: { user?: DesktopDirEntry[]; common?: DesktopDirEntry[] }) {
      if (v.user) userEntries = v.user
      if (v.common) commonEntries = v.common
    },
    failNextScans() { failScan = true },
    healScans() { failScan = false },
  }
}

describe('DesktopService（工单05 扫描与启动）', () => {
  it('扫描合并去重入池：state 给条目与指纹，随刷新收敛', async () => {
    const w = fakeWorld(
      [entry('Kimi Code.lnk'), entry('note.txt')],
      [entry('Kimi Code.lnk', { mtimeMs: 9 }), entry('WeChat.lnk')],
    )
    await w.ctx.start()
    try {
      const s = w.svc.state()
      expect(s.items.map((i) => i.name).sort()).toEqual(['Kimi Code.lnk', 'WeChat.lnk', 'note.txt'])
      expect(s.items.find((i) => i.name === 'Kimi Code.lnk')?.path).toBe('C:\\u\\Kimi Code.lnk')
      expect(s.fingerprint).toBeTruthy()

      w.setEntries({ user: [entry('Kimi Code.lnk'), entry('note.txt'), entry('new', { isDirectory: true })] })
      w.svc.refresh()
      expect(w.svc.state().items).toHaveLength(4)
      expect(w.svc.state().fingerprint).not.toBe(s.fingerprint)
    } finally {
      await w.ctx.stop()
    }
  })

  it('扫描失败沿用上一轮条目（桌面不闪空；与会话「失败给空表」语义之别）', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    const before = w.svc.state()
    w.failNextScans()
    w.svc.refresh()
    expect(w.svc.state()).toEqual(before)
    w.healScans()
    w.svc.refresh()
    expect(w.svc.state().items.map((i) => i.name)).toEqual(['a.lnk'])
    await w.ctx.stop()
  })

  it('刷新为新键预热图标；icon() 缓存命中不重提取', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    try {
      const key = w.svc.state().items[0].iconKey
      await new Promise((r) => setTimeout(r, 0)) // 预热 Promise 落定
      expect(w.extract).toHaveBeenCalledWith('C:\\u\\a.lnk')
      expect(await w.svc.icon(key)).toBe('icon:C:\\u\\a.lnk')
      expect(w.extract).toHaveBeenCalledTimes(1)
    } finally {
      await w.ctx.stop()
    }
  })

  it('launch：池内路径经 open 启动；任意路径拒绝；open 报错透传', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    try {
      const ok = await w.svc.launch('C:\\u\\a.lnk')
      expect(ok).toEqual({ ok: true })
      expect(w.open).toHaveBeenCalledWith('C:\\u\\a.lnk')

      const outside = await w.svc.launch('C:\\Windows\\System32\\cmd.exe')
      expect(outside.ok).toBe(false)
      expect(w.open).toHaveBeenCalledTimes(1)

      w.open.mockResolvedValueOnce('找不到应用程序')
      const err = await w.svc.launch('C:\\u\\a.lnk')
      expect(err).toEqual({ ok: false, error: '找不到应用程序' })
    } finally {
      await w.ctx.stop()
    }
  })

  it('icon() 对渲染层迟到的旧键：按缓存键反解路径仍可提取', async () => {
    const w = fakeWorld([entry('a.lnk', { mtimeMs: 5 })])
    await w.ctx.start()
    try {
      // 快照轮之间 mtime 变过：渲染层拿到的键可能不在当前预热队列
      const staleKey = `C:\\u\\a.lnk|999`
      expect(await w.svc.icon(staleKey)).toBe('icon:C:\\u\\a.lnk')
    } finally {
      await w.ctx.stop()
    }
  })

  it('reveal/copyPath（工单24）：池内路径放行（定位/剪贴板各走各的依赖），池外拒绝', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    try {
      expect(w.svc.reveal('C:\\u\\a.lnk')).toEqual({ ok: true })
      expect(w.reveal).toHaveBeenCalledTimes(1)
      expect(w.reveal).toHaveBeenCalledWith('C:\\u\\a.lnk')
      expect(w.svc.copyPath('C:\\u\\a.lnk')).toEqual({ ok: true })
      expect(w.copyText).toHaveBeenCalledTimes(1)
      expect(w.copyText).toHaveBeenCalledWith('C:\\u\\a.lnk')

      const outsideReveal = w.svc.reveal('C:\\Windows\\System32\\cmd.exe')
      expect(outsideReveal).toEqual({ ok: false, error: '桌面项不在当前扫描池内' })
      const outsideCopy = w.svc.copyPath('C:\\Windows\\System32\\cmd.exe')
      expect(outsideCopy).toEqual({ ok: false, error: '桌面项不在当前扫描池内' })
      expect(w.reveal).toHaveBeenCalledTimes(1)
      expect(w.copyText).toHaveBeenCalledTimes(1)
    } finally {
      await w.ctx.stop()
    }
  })
})

describe('DesktopService（工单06 编排与摆位）', () => {
  it('出厂编排：dock 按频次降序、同分稳定；文档按组聚合新在上', async () => {
    const w = fakeWorld(
      [entry('hot.lnk'), entry('cold.lnk'), entry('mid.lnk'), entry('old.docx', { mtimeMs: 100 }), entry('new.docx', { mtimeMs: 900 })],
      [],
      {
        scores: () => new Map([['hot', 9], ['mid', 5], ['cold', 1]]), // display 名打分
      },
    )
    await w.ctx.start()
    try {
      const { plan } = w.svc.state()
      expect(plan.dock.map((d) => d.name)).toEqual(['hot.lnk', 'mid.lnk', 'cold.lnk'])
      expect(plan.dock.every((d) => d.source === 'recommended')).toBe(true)
      expect(plan.docs.map((d) => d.name)).toEqual(['new.docx', 'old.docx'])
      expect(plan.docs.every((d) => d.group === 'office')).toBe(true)
    } finally {
      await w.ctx.stop()
    }
  })

  it('手钉占前段不被推荐顶替（store 注入）', async () => {
    const w = fakeWorld(
      [entry('pin.lnk'), entry('hot.lnk')],
      [],
      {
        store: JSON.stringify({ version: 1, pinned: ['pin.lnk'], dock: [], docs: [] }),
        scores: () => new Map([['hot', 99], ['pin', 0]]),
      },
    )
    await w.ctx.start()
    try {
      const dock = w.svc.state().plan.dock
      expect(dock.map((d) => [d.name, d.source])).toEqual([['pin.lnk', 'pinned'], ['hot.lnk', 'recommended']])
    } finally {
      await w.ctx.stop()
    }
  })

  it('move：区内摆位即时重编排并落盘；重启（重建服务）后位置保持', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('b.lnk'), entry('c.lnk')])
    await w.ctx.start()
    try {
      const r = w.svc.move('c.lnk', 'app', 'a.lnk')
      expect(r).toEqual({ ok: true })
      expect(w.svc.state().plan.dock.map((d) => d.name)).toEqual(['c.lnk', 'a.lnk', 'b.lnk'])
      expect(w.written).toHaveLength(1)
      // 显式摆位名单只记被拖过的条目（c 排在 a 前 = placed 段先于 recommended 段）
      expect(JSON.parse(w.storeText!)).toMatchObject({ dock: ['c.lnk'] })
    } finally {
      await w.ctx.stop()
    }
    // 用同一份落盘文本重建服务：位置保持（工单验收「重启面板后位置保持」的机制核）
    const w2 = fakeWorld([entry('a.lnk'), entry('b.lnk'), entry('c.lnk')], [], { store: w.storeText })
    await w2.ctx.start()
    try {
      expect(w2.svc.state().plan.dock.map((d) => [d.name, d.source])).toEqual([
        ['c.lnk', 'placed'],
        ['a.lnk', 'recommended'],
        ['b.lnk', 'recommended'],
      ])
    } finally {
      await w2.ctx.stop()
    }
  })

  it('move 跨区拖拽即换区（文档类条目入 dock、zone 覆盖入状态）', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('note.docx')])
    await w.ctx.start()
    try {
      expect(w.svc.move('note.docx', 'app', 'a.lnk')).toEqual({ ok: true })
      const s = w.svc.state()
      expect(s.items.find((i) => i.name === 'note.docx')?.zone).toBe('app')
      expect(s.plan.dock.map((d) => d.name)).toEqual(['note.docx', 'a.lnk'])
      expect(s.plan.docs).toEqual([])
    } finally {
      await w.ctx.stop()
    }
  })

  it('move 校验：池外名字、参照不在目标分区、以自身为参照均拒绝', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('note.docx')])
    await w.ctx.start()
    try {
      expect(w.svc.move('ghost.lnk', 'app', null).ok).toBe(false)
      expect(w.svc.move('a.lnk', 'app', 'note.docx').ok).toBe(false) // 参照在另一分区
      expect(w.svc.move('a.lnk', 'app', 'a.lnk').ok).toBe(false)
      expect(w.written).toHaveLength(0)
    } finally {
      await w.ctx.stop()
    }
  })

  it('resetLayout：清除摆位保留手钉，编排回到出厂（推荐按频次）', async () => {
    const w = fakeWorld(
      [entry('pin.lnk'), entry('hot.lnk'), entry('cold.lnk')],
      [],
      {
        store: JSON.stringify({ version: 1, pinned: ['pin.lnk'], dock: ['cold.lnk'], docs: [] }),
        scores: () => new Map([['hot', 9], ['cold', 1]]),
      },
    )
    await w.ctx.start()
    try {
      expect(w.svc.state().plan.dock.map((d) => d.source)).toEqual(['pinned', 'placed', 'recommended'])
      const r = w.svc.resetLayout()
      expect(r).toEqual({ ok: true, cleared: 1 })
      expect(w.svc.state().plan.dock.map((d) => [d.name, d.source])).toEqual([
        ['pin.lnk', 'pinned'],
        ['hot.lnk', 'recommended'],
        ['cold.lnk', 'recommended'],
      ])
      expect(JSON.parse(w.storeText!)).toEqual({ version: 1, pinned: ['pin.lnk'], dock: [], docs: [] })
    } finally {
      await w.ctx.stop()
    }
  })

  it('损坏 store 自愈为出厂态', async () => {
    const w = fakeWorld([entry('a.lnk')], [], { store: '{ 坏掉的' })
    await w.ctx.start()
    try {
      expect(w.svc.state().plan.dock.map((d) => d.name)).toEqual(['a.lnk'])
      expect(w.svc.storeForTest()).toEqual({ version: 1, pinned: [], dock: [], docs: [] })
    } finally {
      await w.ctx.stop()
    }
  })

  it('频次经 usage 拉取（lnk 目标反查路径到位，resolve 可用）', async () => {
    const targets: Record<string, string> = { 'C:\\u\\Kimi.lnk': 'C:\\P\\Kimi.exe' }
    let sawTarget = false
    const w = fakeWorld([entry('Kimi.lnk'), entry('Other.lnk')], [], {
      targets,
      scores: (items, resolve) => {
        const kimi = items.find((i) => i.display === 'Kimi')
        sawTarget = kimi?.target === 'C:\\P\\Kimi.exe'
        expect(resolve('C:\\taskbar\\Other.lnk')).toBeNull()
        return new Map([['Kimi', 5]])
      },
    })
    await w.ctx.start()
    try {
      expect(sawTarget).toBe(true)
      expect(w.svc.state().plan.dock.map((d) => d.name)).toEqual(['Kimi.lnk', 'Other.lnk'])
    } finally {
      await w.ctx.stop()
    }
  })

  it('fs.watch 触发即刷新（新建自动入池不等 1Hz tick）', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    try {
      expect(w.watchCalls).toHaveLength(1) // 安装一次（两根共用）
      w.setEntries({ user: [entry('a.lnk'), entry('new.txt')] })
      w.watchCalls[0]()
      expect(w.svc.state().items.map((i) => i.name)).toContain('new.txt')
    } finally {
      await w.ctx.stop()
    }
  })

  it('编排变化翻转指纹（渲染层 diff 依据）', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('b.lnk')])
    await w.ctx.start()
    try {
      const before = w.svc.state().fingerprint
      w.svc.move('b.lnk', 'app', 'a.lnk')
      expect(w.svc.state().fingerprint).not.toBe(before)
    } finally {
      await w.ctx.stop()
    }
  })
})

describe('DesktopService（工单22 批量拖拽摆位）', () => {
  it('moveBatch：整组按选区插入序迁移到落点（区内），落盘一次', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('b.lnk'), entry('c.lnk'), entry('d.lnk')])
    await w.ctx.start()
    try {
      const r = w.svc.moveBatch(['d.lnk', 'b.lnk'], 'app', 'a.lnk')
      expect(r).toEqual({ ok: true, moved: ['d.lnk', 'b.lnk'], skipped: [] })
      expect(w.svc.state().plan.dock.map((d) => d.name)).toEqual(['d.lnk', 'b.lnk', 'a.lnk', 'c.lnk'])
      expect(w.written).toHaveLength(1)
      expect(JSON.parse(w.storeText!)).toMatchObject({ pinned: [], dock: ['d.lnk', 'b.lnk'], docs: [] })
    } finally {
      await w.ctx.stop()
    }
  })

  it('moveBatch 跨区：落点分区即整组目标分区（应用组拖入文档区）', async () => {
    const w = fakeWorld([
      entry('a.lnk'), entry('b.lnk'),
      entry('n1.docx', { mtimeMs: 100 }), entry('n2.docx', { mtimeMs: 200 }),
    ])
    await w.ctx.start()
    try {
      const r = w.svc.moveBatch(['a.lnk', 'b.lnk'], 'doc', null)
      expect(r).toEqual({ ok: true, moved: ['a.lnk', 'b.lnk'], skipped: [] })
      const s = w.svc.state()
      expect(s.items.find((i) => i.name === 'a.lnk')?.zone).toBe('doc')
      expect(s.items.find((i) => i.name === 'b.lnk')?.zone).toBe('doc')
      // lnk 归 other 组、docx 归 office 组（组序固定：office 在前）；组内显式摆位排首段、相对序保持
      expect(s.plan.docs.map((d) => [d.name, d.group])).toEqual([
        ['n2.docx', 'office'], ['n1.docx', 'office'], ['a.lnk', 'other'], ['b.lnk', 'other'],
      ])
      expect(s.plan.dock).toEqual([])
    } finally {
      await w.ctx.stop()
    }
  })

  it('moveBatch 含手钉：手钉跳过、其余落位；skipped 如实回报，pinned 清单不动', async () => {
    const w = fakeWorld(
      [entry('pin.lnk'), entry('hot.lnk'), entry('cold.lnk')],
      [],
      { store: JSON.stringify({ version: 1, pinned: ['pin.lnk'], dock: [], docs: [] }) },
    )
    await w.ctx.start()
    try {
      const r = w.svc.moveBatch(['cold.lnk', 'pin.lnk'], 'app', 'hot.lnk')
      expect(r).toEqual({ ok: true, moved: ['cold.lnk'], skipped: ['pin.lnk'] })
      const s = w.svc.state()
      expect(s.plan.dock.map((d) => [d.name, d.source])).toEqual([
        ['pin.lnk', 'pinned'],
        ['cold.lnk', 'placed'],
        ['hot.lnk', 'recommended'],
      ])
      expect(JSON.parse(w.storeText!)).toMatchObject({ pinned: ['pin.lnk'], dock: ['cold.lnk'] })
    } finally {
      await w.ctx.stop()
    }
  })

  it('moveBatch：手钉拖去文档区同样跳过（批量永不变更手钉栏位，挪手钉走单选跨区通道）', async () => {
    const w = fakeWorld(
      [entry('pin.lnk'), entry('note.docx')],
      [],
      { store: JSON.stringify({ version: 1, pinned: ['pin.lnk'], dock: [], docs: [] }) },
    )
    await w.ctx.start()
    try {
      const r = w.svc.moveBatch(['pin.lnk'], 'doc', 'note.docx')
      expect(r).toEqual({ ok: true, moved: [], skipped: ['pin.lnk'] })
      expect(w.written).toHaveLength(0) // 全跳过 = 无变化不落盘
      expect(w.svc.state().items.find((i) => i.name === 'pin.lnk')?.zone).toBe('app')
    } finally {
      await w.ctx.stop()
    }
  })

  it('moveBatch：池外名字跳过、重复名字防御，其余照常', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('b.lnk')])
    await w.ctx.start()
    try {
      const r = w.svc.moveBatch(['ghost.lnk', 'a.lnk', 'a.lnk'], 'app', null)
      expect(r).toEqual({ ok: true, moved: ['a.lnk'], skipped: ['ghost.lnk'] })
      expect(w.svc.state().plan.dock.map((d) => d.name)).toEqual(['a.lnk', 'b.lnk'])
    } finally {
      await w.ctx.stop()
    }
  })

  it('moveBatch 参照校验整批拒绝：池外参照/他区参照/被拖组内参照/空名单，一个都不摆', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('b.lnk'), entry('note.docx')])
    await w.ctx.start()
    try {
      expect(w.svc.moveBatch(['a.lnk'], 'app', 'ghost.lnk')).toEqual({
        ok: false, moved: [], skipped: [], error: '参照条目不在当前扫描池内',
      })
      expect(w.svc.moveBatch(['a.lnk'], 'app', 'note.docx')).toEqual({
        ok: false, moved: [], skipped: [], error: '参照条目不在目标分区',
      })
      expect(w.svc.moveBatch(['a.lnk', 'b.lnk'], 'app', 'b.lnk')).toEqual({
        ok: false, moved: [], skipped: [], error: '参照条目在被拖组内',
      })
      expect(w.svc.moveBatch([], 'app', null)).toEqual({
        ok: false, moved: [], skipped: [], error: '批量摆位名单为空',
      })
      expect(w.written).toHaveLength(0)
      expect(w.svc.state().plan.dock.map((d) => d.name)).toEqual(['a.lnk', 'b.lnk'])
    } finally {
      await w.ctx.stop()
    }
  })

  it('moveBatch 落盘重启后整组位置保持', async () => {
    const w = fakeWorld([entry('a.lnk'), entry('b.lnk'), entry('c.lnk')])
    await w.ctx.start()
    try {
      w.svc.moveBatch(['c.lnk', 'a.lnk'], 'app', null)
    } finally {
      await w.ctx.stop()
    }
    const w2 = fakeWorld([entry('a.lnk'), entry('b.lnk'), entry('c.lnk')], [], { store: w.storeText })
    await w2.ctx.start()
    try {
      expect(w2.svc.state().plan.dock.map((d) => [d.name, d.source])).toEqual([
        ['c.lnk', 'placed'],
        ['a.lnk', 'placed'],
        ['b.lnk', 'recommended'],
      ])
    } finally {
      await w2.ctx.stop()
    }
  })
})
