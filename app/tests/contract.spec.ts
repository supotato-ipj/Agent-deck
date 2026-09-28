import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/main/kernel'
import { defaultAppearance, defaultDesktopLayout, defaultPlugins, defaultSearchConfig, defaultTools, defaultWeather } from '../src/main/config'
import type { AppConfig } from '../src/main/config'
import type { PanelSnapshot, PluginInfo } from '../src/shared/contract'
import { flush, harness } from './search/harness'

/** 内核契约缝（spec：在 Node 中直接驱动 cordis 内核，断言桥接 API 的请求/响应与变更推送）。 */

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ct-'))
  fs.mkdirSync(path.join(d, 'user'), { recursive: true })
  fs.mkdirSync(path.join(d, 'common'), { recursive: true })
  return d
}

function desktopOpts(dir: string, over: Record<string, unknown> = {}) {
  // 摆位存储一律内存假源：内核级测试绝不触 LOCALAPPDATA 真文件
  let storeText: string | null = null
  const base = {
    roots: { user: path.join(dir, 'user'), common: path.join(dir, 'common') },
    deps: {
      readStoreText: () => storeText,
      writeStoreText: (_f: string, text: string) => {
        storeText = text
      },
    },
  }
  return { ...base, ...over, deps: { ...base.deps, ...((over.deps as object) ?? {}) } }
}

/** 离线 usage：假源 + 空目录（不触 native 真源与本机 LOCALAPPDATA） */
function usageOpts(dir: string) {
  return {
    dir: path.join(dir, 'usage'),
    deps: {
      runningPidExes: () => new Map<number, string>(),
      foregroundExe: () => null,
      readPrior: async () => new Map(),
    },
  }
}

/** 全离线内核选项基座：usage 一并假源化；搜索泵定时器不装（07 契约测试手动驱动） */
function kernelOpts(dir: string, over: Record<string, unknown> = {}) {
  return { tickIntervalMs: 0, hardwareIntervalMs: 0, usageIntervalMs: 0, searchIntervalMs: 0, desktop: desktopOpts(dir), usage: usageOpts(dir), ...over }
}

/** 设置桩（工单08）：config 落 tmp 文件，断言持久化不触真 config.json */
function settingsOpts(dir: string): { settings: { file: string; config: AppConfig } } {
  const config: AppConfig = {
    panel: { x: 0, y: 0, width: 100, height: 100 },
    weather: defaultWeather(),
    desktop: defaultDesktopLayout(),
    search: defaultSearchConfig(),
    appearance: defaultAppearance(),
    tools: defaultTools(),
    plugins: defaultPlugins(),
  }
  return { settings: { file: path.join(dir, 'config.json'), config } }
}

describe('内核桥接契约', () => {
  it('panel/snapshot 返回时钟快照', async () => {
    const ctx = createKernel(kernelOpts(tmpDir()))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.clock.epochMs).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(snap.clock.iso))).toBe(false)
      expect(Math.abs(snap.clock.epochMs - Date.now())).toBeLessThan(5000)
    } finally {
      await ctx.stop()
    }
  })

  it('panel/changed 订阅推送快照，退订后停止', async () => {
    const ctx = createKernel(kernelOpts(tmpDir()))
    await ctx.start()
    try {
      const received: PanelSnapshot[] = []
      const off = ctx.bridge.subscribe('panel/changed', (s) => received.push(s))
      ctx.bridge.tick()
      ctx.bridge.tick()
      expect(received).toHaveLength(2)
      expect(received[1].clock.epochMs).toBeGreaterThanOrEqual(received[0].clock.epochMs)
      off()
      ctx.bridge.tick()
      expect(received).toHaveLength(2)
    } finally {
      await ctx.stop()
    }
  })

  it('未知方法拒绝', async () => {
    const ctx = createKernel(kernelOpts(tmpDir()))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('nope' as never, null as never)).rejects.toThrow(/未知桥接方法/)
    } finally {
      await ctx.stop()
    }
  })
})

describe('内核桥接契约（工单05 桌面承载扩展）', () => {
  it('panel/snapshot 含桌面项池（fingerprint + items）；desktop/icon 可取图标', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'note.txt'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async (p: string) => `icon:${path.basename(p)}`,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.items.map((i) => [i.name, i.zone])).toEqual([['Probe.lnk', 'app'], ['note.txt', 'doc']])
      expect(snap.desktop.fingerprint).toBeTruthy()
      const key = snap.desktop.items[0].iconKey
      await expect(ctx.bridge.invoke('desktop/icon', { key })).resolves.toEqual({ dataUrl: `icon:Probe.lnk` })
    } finally {
      await ctx.stop()
    }
  })

  it('panel/snapshot 含编排计划与桌面几何（工单06）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'a.docx'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => d.name)).toEqual(['Probe.lnk'])
      expect(snap.desktop.plan.docs.map((d) => [d.name, d.group])).toEqual([['a.docx', 'office']])
      expect(snap.layout.docMaxRows).toBeGreaterThan(0)
      expect(snap.layout.docZone).toMatchObject({ left: expect.any(Number), top: expect.any(Number), maxWidth: expect.any(Number) })
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/launch：池内路径启动成功，池外路径拒绝（不执行任意路径）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    const opened: string[] = []
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async (p: string) => {
            opened.push(p)
            return ''
          },
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      const target = snap.desktop.items[0].path
      await expect(ctx.bridge.invoke('desktop/launch', { path: target })).resolves.toEqual({ ok: true })
      expect(opened).toEqual([target])
      const outside = await ctx.bridge.invoke('desktop/launch', { path: 'C:\\Windows\\System32\\cmd.exe' })
      expect(outside.ok).toBe(false)
      expect(opened).toHaveLength(1)
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/move：摆位经桥接落位、跨区换区；非法参照拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'n.docx'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      const moved = await ctx.bridge.invoke('desktop/move', { name: 'B.lnk', zone: 'app', beforeName: 'A.lnk' })
      expect(moved).toEqual({ ok: true })
      let snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => d.name)).toEqual(['B.lnk', 'A.lnk'])
      // 跨区：文档入 dock
      const cross = await ctx.bridge.invoke('desktop/move', { name: 'n.docx', zone: 'app', beforeName: null })
      expect(cross).toEqual({ ok: true })
      snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.items.find((i) => i.name === 'n.docx')?.zone).toBe('app')
      expect(snap.desktop.plan.docs).toEqual([])
      // 非法参照（在另一分区）
      const bad = await ctx.bridge.invoke('desktop/move', { name: 'B.lnk', zone: 'doc', beforeName: 'A.lnk' })
      expect(bad.ok).toBe(false)
      expect(bad.error).toBeTruthy()
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/reset-layout：清摆位回出厂编排', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.lnk'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      await ctx.bridge.invoke('desktop/move', { name: 'B.lnk', zone: 'app', beforeName: 'A.lnk' })
      const r = await ctx.bridge.invoke('desktop/reset-layout', null)
      expect(r).toEqual({ ok: true, cleared: 1 })
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => [d.name, d.source])).toEqual([['A.lnk', 'recommended'], ['B.lnk', 'recommended']])
    } finally {
      await ctx.stop()
    }
  })
})

describe('内核桥接契约（工单07 搜索扩展）', () => {
  it('search/activate → query 防抖到期直连假引擎 → search/state 与 search/results 事件回推', async () => {
    const dir = tmpDir()
    const h = harness()
    const ctx = createKernel(kernelOpts(dir, { search: { deps: h.deps } }))
    await ctx.start()
    try {
      const states: string[] = []
      const results: Array<{ total: number; items: Array<{ path: string }> }> = []
      ctx.bridge.subscribe('search/state', (p) => states.push(p.state))
      ctx.bridge.subscribe('search/results', (p) => results.push(p))

      await expect(ctx.bridge.invoke('search/activate', null)).resolves.toEqual({ state: 'active' })
      expect(states).toEqual(['active'])
      // 待机态之外喂词不成立（未激活时 accepted=false）
      await ctx.bridge.invoke('search/deactivate', null)
      await expect(ctx.bridge.invoke('search/query', { query: 'x' })).resolves.toEqual({ accepted: false })
      await ctx.bridge.invoke('search/activate', null)

      await expect(ctx.bridge.invoke('search/query', { query: 'probe' })).resolves.toEqual({ accepted: true })
      h.advance(100)
      ctx.search!.tick()
      await flush()
      expect(h.calls).toHaveLength(0) // 防抖窗口内
      h.advance(100)
      ctx.search!.tick()
      await flush()
      expect(h.calls).toEqual([{ query: 'probe', limit: 8, offset: 0 }])
      expect(results).toHaveLength(1)
      expect(results[0].items[0].path).toBe('C:\\probe.txt')
    } finally {
      await ctx.stop()
    }
  })

  it('search/action：Enter 打开 / Ctrl+Enter 定位；path 护栏 = 最近一次结果集', async () => {
    const dir = tmpDir()
    const h = harness()
    const ctx = createKernel(kernelOpts(dir, { search: { deps: h.deps } }))
    await ctx.start()
    try {
      await ctx.bridge.invoke('search/activate', null)
      await ctx.bridge.invoke('search/query', { query: 'probe' })
      h.advance(250)
      ctx.search!.tick()
      await flush()
      await expect(ctx.bridge.invoke('search/action', { path: 'C:\\probe.txt', reveal: false })).resolves.toEqual({ ok: true })
      expect(h.opened).toEqual(['C:\\probe.txt'])
      await expect(ctx.bridge.invoke('search/action', { path: 'C:\\probe.txt', reveal: true })).resolves.toEqual({ ok: true })
      expect(h.revealed).toEqual(['C:\\probe.txt'])
      // 结果集外的路径拒绝执行（任意路径执行防线，desktop/launch 同款护栏）
      await expect(ctx.bridge.invoke('search/action', { path: 'C:\\Windows\\System32\\cmd.exe', reveal: false }))
        .resolves.toMatchObject({ ok: false })
      expect(h.opened).toHaveLength(1)
    } finally {
      await ctx.stop()
    }
  })

  it('连接失败经桥接回推引擎离线态（ENGINE OFFLINE 数据源）', async () => {
    const dir = tmpDir()
    const h = harness()
    h.goOffline()
    const ctx = createKernel(kernelOpts(dir, { search: { deps: h.deps } }))
    await ctx.start()
    try {
      const states: string[] = []
      ctx.bridge.subscribe('search/state', (p) => states.push(p.state))
      await ctx.bridge.invoke('search/activate', null)
      await ctx.bridge.invoke('search/query', { query: 'probe' })
      h.advance(250)
      ctx.search!.tick()
      await flush()
      expect(states).toEqual(['active', 'offline'])
    } finally {
      await ctx.stop()
    }
  })
})

describe('内核桥接契约（工单08 设置浮层扩展）', () => {
  it('panel/snapshot 携带 settings（初值 = config.appearance.cardOpacity）', async () => {
    const dir = tmpDir()
    const so = settingsOpts(dir)
    so.settings.config.appearance.cardOpacity = 0.3
    const ctx = createKernel(kernelOpts(dir, so))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.settings).toEqual({ cardOpacity: 0.3 })
    } finally {
      await ctx.stop()
    }
  })

  it('settings/set-card-opacity：clamp 生效、settings/changed 即时回推、快照与磁盘同步', async () => {
    const dir = tmpDir()
    const so = settingsOpts(dir)
    const ctx = createKernel(kernelOpts(dir, so))
    await ctx.start()
    try {
      const changed: Array<{ cardOpacity: number }> = []
      ctx.bridge.subscribe('settings/changed', (s) => changed.push(s))

      await expect(ctx.bridge.invoke('settings/set-card-opacity', { opacity: 0.25 }))
        .resolves.toEqual({ cardOpacity: 0.25 })
      // clamp 到边界
      await expect(ctx.bridge.invoke('settings/set-card-opacity', { opacity: 1.7 }))
        .resolves.toEqual({ cardOpacity: 1 })
      await expect(ctx.bridge.invoke('settings/set-card-opacity', { opacity: -3 }))
        .resolves.toEqual({ cardOpacity: 0 })

      expect(changed).toEqual([{ cardOpacity: 0.25 }, { cardOpacity: 1 }, { cardOpacity: 0 }])
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.settings).toEqual({ cardOpacity: 0 })
      // 持久化：config.json 整份回写（重启保持的数据源）
      const onDisk = JSON.parse(fs.readFileSync(so.settings.file, 'utf8'))
      expect(onDisk.appearance).toEqual({ cardOpacity: 0 })
    } finally {
      await ctx.stop()
    }
  })

  it('settings/set-card-opacity：非有限数字拒绝（契约违规不 clamp 吞掉）', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir, settingsOpts(dir)))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('settings/set-card-opacity', { opacity: 'dark' as never }))
        .rejects.toThrow(/cardOpacity/)
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.settings).toEqual({ cardOpacity: 0.55 })
    } finally {
      await ctx.stop()
    }
  })
})

describe('内核桥接契约（工单09 会话行直达扩展）', () => {
  it('session/focus：工具在跑则聚焦既有窗口（不经启动）', async () => {
    const dir = tmpDir()
    const focused: number[] = []
    const launched: string[] = []
    const ctx = createKernel(kernelOpts(dir, {
      focus: {
        tools: { zcode: { launch: 'C:\\ZCode.exe', processes: ['zcode'] } },
        deps: {
          listWindows: () => [{ hwnd: 0x3000, pid: 88, exe: 'ZCode.exe', visible: true, minimized: false }],
          focusWindow: (h: number) => { focused.push(h); return true },
          launch: async (e: string) => { launched.push(e); return '' },
          env: {},
        },
      },
    }))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('session/focus', { tool: 'zcode' }))
        .resolves.toEqual({ ok: true, action: 'focused', hwnd: 0x3000 })
      expect(focused).toEqual([0x3000])
      expect(launched).toEqual([])
    } finally {
      await ctx.stop()
    }
  })

  it('session/focus：工具未运行则启动；未知工具静默降级不抛', async () => {
    const dir = tmpDir()
    const launched: string[] = []
    const ctx = createKernel(kernelOpts(dir, {
      focus: {
        tools: { zcode: { launch: 'C:\\ZCode.exe', processes: ['zcode'] } },
        deps: {
          listWindows: () => [],
          focusWindow: () => true,
          launch: async (e: string) => { launched.push(e); return '' },
          env: {},
        },
      },
    }))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('session/focus', { tool: 'zcode' })).resolves.toEqual({ ok: true, action: 'launched' })
      expect(launched).toEqual(['C:\\ZCode.exe'])
      // 未知工具：响应降级而非 reject——渲染层不需 try/catch 也不会崩面板
      await expect(ctx.bridge.invoke('session/focus', { tool: 'ghost' }))
        .resolves.toMatchObject({ ok: false, action: 'degraded' })
      expect(launched).toHaveLength(1)
      // 降级后面板照常：快照仍可取
      await expect(ctx.bridge.invoke('panel/snapshot', null)).resolves.toBeTruthy()
    } finally {
      await ctx.stop()
    }
  })
})

describe('内核桥接契约（工单10 桌面组件扩展）', () => {
  /** 落一个插件目录：manifest + 入口资产 */
  function writePlugin(root: string, manifest: Record<string, unknown>): string {
    const dir = path.join(root, String(manifest.id))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
    fs.writeFileSync(path.join(dir, 'card.js'), 'export default {}', 'utf8')
    return dir
  }

  const manifest = (over: Record<string, unknown> = {}) => ({
    id: 'sample', name: '样例插件', version: '1.0.0', entry: './card.js', capabilities: ['clock'], ...over,
  })

  it('未配置插件根时快照带空 plugins 段（契约在场，不必装插件才成立）', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.plugins).toEqual([])
    } finally {
      await ctx.stop()
    }
  })

  it('放入插件 → 快照带可 import 的 entry；移除 → 段内消失（无需重启面板）', async () => {
    const dir = tmpDir()
    const root = path.join(dir, 'plugins')
    const ctx = createKernel(kernelOpts(dir, { plugins: { roots: [root], watch: false } }))
    await ctx.start()
    try {
      writePlugin(root, manifest())
      ctx.plugins!.rescan()
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.plugins).toHaveLength(1)
      expect(snap.plugins[0]).toMatchObject({ id: 'sample', status: 'ok', capabilities: ['clock'], error: null })
      expect(snap.plugins[0].entry).toContain('deck-plugin://sample/card.js?v=')

      fs.rmSync(path.join(root, 'sample'), { recursive: true, force: true })
      ctx.plugins!.rescan()
      expect((await ctx.bridge.invoke('panel/snapshot', null)).plugins).toEqual([])
    } finally {
      await ctx.stop()
    }
  })

  it('plugins/changed 独立于 1Hz 快照即时推送（热插拔不等下一拍）', async () => {
    const dir = tmpDir()
    const root = path.join(dir, 'plugins')
    const ctx = createKernel(kernelOpts(dir, { plugins: { roots: [root], watch: false } }))
    await ctx.start()
    try {
      const received: PluginInfo[][] = []
      const off = ctx.bridge.subscribe('plugins/changed', (list) => received.push(list))
      writePlugin(root, manifest())
      ctx.plugins!.rescan()
      expect(received).toHaveLength(1)
      expect(received[0].map((p) => p.id)).toEqual(['sample'])
      off()
      writePlugin(root, manifest({ id: 'second' }))
      ctx.plugins!.rescan()
      expect(received).toHaveLength(1) // 退订后不再收
    } finally {
      await ctx.stop()
    }
  })

  it('坏插件以 error 态在列而非静默消失（面板据此静默降级）', async () => {
    const dir = tmpDir()
    const root = path.join(dir, 'plugins')
    const broken = path.join(root, 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'plugin.json'), '{ not json', 'utf8')
    const ctx = createKernel(kernelOpts(dir, { plugins: { roots: [root], watch: false } }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.plugins).toHaveLength(1)
      expect(snap.plugins[0]).toMatchObject({ id: 'broken', status: 'error', entry: '' })
      expect(snap.plugins[0].error).toBeTruthy()
    } finally {
      await ctx.stop()
    }
  })

  it('源码级守卫：渲染层不碰 fs（插件资产只经协议下发，读盘只在主进程）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/renderer/plugins.ts'), 'utf8')
    expect(src).not.toMatch(/require\(|node:fs/)
    const preload = fs.readFileSync(path.resolve(__dirname, '../src/preload/index.ts'), 'utf8')
    expect(preload).not.toMatch(/node:fs|readFileSync/) // 渲染层唯一的特权面只做 IPC 转发
  })
})

describe('隐私守卫（工单07：查询词只发往本机 Listary API、不入使用日志）', () => {
  it('行为级：完整搜索流跑过后，使用日志目录里没有任何文件、查询词不落盘', async () => {
    const dir = tmpDir()
    const h = harness()
    const ctx = createKernel(kernelOpts(dir, {
      usage: usageOpts(dir),
      search: { deps: h.deps },
    }))
    await ctx.start()
    try {
      await ctx.bridge.invoke('search/activate', null)
      await ctx.bridge.invoke('search/query', { query: 'SECRET-QUERY-WORDS' })
      h.advance(250)
      ctx.search!.tick()
      await flush()
      ctx.usage!.collect() // 使用日志采集轮照常跑（真服务写盘）
      const usageDir = path.join(dir, 'usage')
      const files = fs.existsSync(usageDir) ? fs.readdirSync(usageDir) : []
      for (const f of files) {
        expect(fs.readFileSync(path.join(usageDir, f), 'utf8')).not.toContain('SECRET-QUERY-WORDS')
      }
    } finally {
      await ctx.stop()
    }
  })

  it('源码级：搜索链路不引用使用日志、不直接写盘；查询目标收口本机回环', () => {
    const files = [
      'src/main/search/engine.ts',
      'src/main/search/client.ts',
      'src/main/services/search.ts',
    ]
    for (const rel of files) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
      expect(src, `${rel} 不得引用使用日志`).not.toMatch(/usage\/log|appendEvent|UsageService/)
      expect(src, `${rel} 不得直接写盘`).not.toMatch(/writeFileSync|appendFileSync/)
      expect(src, `${rel} 不得出现硬编码 http(s) URL`).not.toMatch(/https?:\/\//)
    }
    const client = fs.readFileSync(path.resolve(__dirname, '../src/main/search/client.ts'), 'utf8')
    expect(client).toContain('BASE_HOST') // 目标主机只从 engine 常量取（127.0.0.1）
  })

  it('源码级：会话行直达只认 exe 进程名，不读窗口标题（ADR-0002 边界）', () => {
    // 全量守卫在 tests/usage/log.spec.ts（覆盖 src/main 全部 .ts）；此处只补该守卫没覆盖的两条：
    // ① 另一条读标题的 API SendMessageW ② 窗口候选结构不得带 title 字段
    for (const rel of ['src/main/focus/plan.ts', 'src/main/focus/adapter.ts', 'src/main/services/focus.ts']) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
      expect(src, `${rel} 不得经 SendMessageW 读窗口标题`).not.toMatch(/SendMessageW/)
      expect(src, `${rel} 窗口候选不得带标题字段`).not.toMatch(/^\s*title\s*[?:]/m)
    }
  })
})
