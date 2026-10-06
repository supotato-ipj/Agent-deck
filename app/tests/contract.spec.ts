import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/main/kernel'
import { defaultAppearance, defaultAutostart, defaultDesktopLayout, defaultPlugins, defaultSearchConfig, defaultTaskbar, defaultTools, defaultWeather } from '../src/main/config'
import type { AppConfig } from '../src/main/config'
import { PLUGIN_CAPABILITIES } from '../src/shared/contract'
import type { DesktopItem, PanelSnapshot, PluginInfo, TaskbarState, TaskbarStatus, TaskbarSystemAction } from '../src/shared/contract'
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
    autostart: defaultAutostart(),
    taskbar: defaultTaskbar(),
  }
  return { settings: { file: path.join(dir, 'config.json'), config } }
}

// 完整起内核的用例在 CI 冷 runner 上初始化远慢于开发机（本地 <400ms，GH runner 曾超 5s），统一放宽到 30s
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
  }, 30_000)

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
  }, 30_000)

  it('未知方法拒绝', async () => {
    const ctx = createKernel(kernelOpts(tmpDir()))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('nope' as never, null as never)).rejects.toThrow(/未知桥接方法/)
    } finally {
      await ctx.stop()
    }
  }, 30_000)
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

  it('desktop/reveal + desktop/copy-path（工单24）：池内路径经桥接执行，池外拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    const revealed: string[] = []
    const copied: string[] = []
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          reveal: (p: string) => { revealed.push(p) },
          copyText: (t: string) => { copied.push(t) },
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      const target = snap.desktop.items[0].path
      await expect(ctx.bridge.invoke('desktop/reveal', { path: target })).resolves.toEqual({ ok: true })
      await expect(ctx.bridge.invoke('desktop/copy-path', { path: target })).resolves.toEqual({ ok: true })
      expect(revealed).toEqual([target])
      expect(copied).toEqual([target])
      const outsideReveal = await ctx.bridge.invoke('desktop/reveal', { path: 'C:\\Windows\\System32\\cmd.exe' })
      expect(outsideReveal.ok).toBe(false)
      const outsideCopy = await ctx.bridge.invoke('desktop/copy-path', { path: 'C:\\Windows\\System32\\cmd.exe' })
      expect(outsideCopy.ok).toBe(false)
      expect(revealed).toHaveLength(1)
      expect(copied).toHaveLength(1)
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/copy-paths（工单26 多选菜单）：池内整份执行（多行 \\n），任一池外整份拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.docx'), 'stub')
    const copied: string[] = []
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          copyText: (t: string) => { copied.push(t) },
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      const pathOf = (name: string) => (snap.desktop.items as DesktopItem[]).find((i) => i.name === name)!.path
      await expect(ctx.bridge.invoke('desktop/copy-paths', { paths: [pathOf('A.lnk'), pathOf('B.docx')] })).resolves.toEqual({ ok: true })
      expect(copied).toEqual([`${pathOf('A.lnk')}\n${pathOf('B.docx')}`])
      const outside = await ctx.bridge.invoke('desktop/copy-paths', { paths: [pathOf('A.lnk'), 'C:\\Windows\\System32\\cmd.exe'] })
      expect(outside).toEqual({ ok: false, error: '桌面项不在当前扫描池内' })
      expect(copied).toHaveLength(1) // 整份拒绝：剪贴板不写半份名单
      await expect(ctx.bridge.invoke('desktop/copy-paths', { paths: [] })).resolves
        .toEqual({ ok: false, error: '复制路径名单为空' })
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/trash（工单27）：池内整份送回收站并同拍清除摆位；池外整份拒绝；失败条目如实回报', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.docx'), 'stub')
    const trashedFiles: string[] = []
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          trash: async (p: string) => {
            if (p.endsWith('B.docx')) return '拒绝访问。'
            trashedFiles.push(p)
            return ''
          },
        },
      }),
    }))
    await ctx.start()
    try {
      // 先造显式摆位（A.lnk 入 dock placed 段），删除后须同拍清除
      await ctx.bridge.invoke('desktop/move', { name: 'A.lnk', zone: 'app', beforeName: null })
      const snap0 = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap0.desktop.plan.dock.map((d) => [d.name, d.source])).toEqual([['A.lnk', 'placed']])
      const pathOf = (name: string) => (snap0.desktop.items as DesktopItem[]).find((i) => i.name === name)!.path
      // 部分失败：A 成功、B 权限拒绝——ok=false + failed + error 明细（菜单层提示依据）
      const r = await ctx.bridge.invoke('desktop/trash', { paths: [pathOf('A.lnk'), pathOf('B.docx')] })
      expect(r).toEqual({ ok: false, trashed: ['A.lnk'], failed: ['B.docx'], error: 'B.docx：拒绝访问。' })
      expect(trashedFiles).toEqual([pathOf('A.lnk')])
      // A 的显式摆位同拍清除：条目还在池（假源不真删盘面），但编排退回推荐段
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock).toEqual([{ name: 'A.lnk', source: 'recommended' }])
      // 池外整份拒绝（copy-paths 同款护栏）：不删半份
      const outside = await ctx.bridge.invoke('desktop/trash', { paths: [pathOf('B.docx'), 'C:\\Windows\\System32\\cmd.exe'] })
      expect(outside).toEqual({ ok: false, trashed: [], failed: [], error: '桌面项不在当前扫描池内' })
      expect(trashedFiles).toHaveLength(1)
      await expect(ctx.bridge.invoke('desktop/trash', { paths: [] })).resolves
        .toEqual({ ok: false, trashed: [], failed: [], error: '删除名单为空' })
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/clipboard-copy + desktop/clipboard-cut（工单29）：池内整份写入（多文件有序 + effect），任一池外整份拒绝；空名单拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.docx'), 'stub')
    const writes: Array<{ paths: string[]; effect: string }> = []
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          writeClipboardFiles: async (paths: readonly string[], effect: 'copy' | 'move') => {
            writes.push({ paths: [...paths], effect })
            return ''
          },
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      const pathOf = (name: string) => (snap.desktop.items as DesktopItem[]).find((i) => i.name === name)!.path
      // 复制：多文件整份、有序（序 = 名单序 = 选区插入序）
      await expect(ctx.bridge.invoke('desktop/clipboard-copy', { paths: [pathOf('B.docx'), pathOf('A.lnk')] }))
        .resolves.toEqual({ ok: true })
      expect(writes).toEqual([{ paths: [pathOf('B.docx'), pathOf('A.lnk')], effect: 'copy' }])
      // 剪切：effect=move（粘贴为搬移）
      await expect(ctx.bridge.invoke('desktop/clipboard-cut', { paths: [pathOf('A.lnk')] }))
        .resolves.toEqual({ ok: true })
      expect(writes).toHaveLength(2)
      expect(writes[1]).toEqual({ paths: [pathOf('A.lnk')], effect: 'move' })
      // 池外整份拒绝（copy-paths/trash 同款护栏）：剪贴板不写半份名单
      const outside = await ctx.bridge.invoke('desktop/clipboard-copy', { paths: [pathOf('B.docx'), 'C:\\Windows\\System32\\cmd.exe'] })
      expect(outside).toEqual({ ok: false, error: '桌面项不在当前扫描池内' })
      expect(writes).toHaveLength(2)
      // 空名单拒绝（信封错误）
      await expect(ctx.bridge.invoke('desktop/clipboard-copy', { paths: [] })).resolves
        .toEqual({ ok: false, error: '复制名单为空' })
      await expect(ctx.bridge.invoke('desktop/clipboard-cut', { paths: [] })).resolves
        .toEqual({ ok: false, error: '剪切名单为空' })
      expect(writes).toHaveLength(2)
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/rename（工单28）：池内改名真落盘、摆位同拍迁移；冲突与非法名拒绝；池外拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.docx'), 'stub')
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
      // 先造显式摆位（B.docx 入 docs placed 段），改名后须原位迁移（位置不丢）
      await ctx.bridge.invoke('desktop/move', { name: 'B.docx', zone: 'doc', beforeName: null })
      // 快捷方式显示名输入（不带 .lnk）→ 内核补回原扩展
      const r = await ctx.bridge.invoke('desktop/rename', { name: 'A.lnk', to: 'Renamed' })
      expect(r).toEqual({ ok: true, to: 'Renamed.lnk' })
      expect(fs.existsSync(path.join(dir, 'user', 'A.lnk'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'user', 'Renamed.lnk'))).toBe(true)
      const snap1 = await ctx.bridge.invoke('panel/snapshot', null)
      expect((snap1.desktop.items as DesktopItem[]).map((i) => i.name).sort()).toEqual(['B.docx', 'Renamed.lnk'])
      // B.docx 改名：docs 摆位名单同拍带走新名（下一拍快照按显式摆位承载）
      const r2 = await ctx.bridge.invoke('desktop/rename', { name: 'B.docx', to: 'Report.docx' })
      expect(r2).toEqual({ ok: true, to: 'Report.docx' })
      const snap2 = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap2.desktop.plan.docs.map((d) => [d.name, d.group])).toEqual([['Report.docx', 'office']])
      // 重名冲突：目标已存在 → ok=false，盘面与摆位原样
      const conflict = await ctx.bridge.invoke('desktop/rename', { name: 'Report.docx', to: 'Renamed.lnk' })
      expect(conflict.ok).toBe(false)
      expect(fs.existsSync(path.join(dir, 'user', 'Report.docx'))).toBe(true)
      // 非法文件名：ok=false（fs 不被触碰）
      const invalid = await ctx.bridge.invoke('desktop/rename', { name: 'Report.docx', to: 'bad|name' })
      expect(invalid.ok).toBe(false)
      // 池外名字：pin 同款按名护栏（含已改走的旧名）
      const outside = await ctx.bridge.invoke('desktop/rename', { name: 'B.docx', to: 'X.docx' })
      expect(outside).toEqual({ ok: false, error: '桌面项不在当前扫描池内' })
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

  it('desktop/move-batch：整组按序落位、手钉跳过回报、无效参照整批拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'C.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'n.docx'), 'stub')
    const pinned = JSON.stringify({ version: 1, pinned: ['C.lnk'], dock: [], docs: [] })
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          readStoreText: () => pinned,
        },
      }),
    }))
    await ctx.start()
    try {
      // 选区插入序 [B.lnk, A.lnk] 整组迁到文档区末尾；C.lnk 手钉跳过
      const moved = await ctx.bridge.invoke('desktop/move-batch', { names: ['B.lnk', 'A.lnk', 'C.lnk'], zone: 'doc', beforeName: null })
      expect(moved).toEqual({ ok: true, moved: ['B.lnk', 'A.lnk'], skipped: ['C.lnk'] })
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.items.find((i) => i.name === 'B.lnk')?.zone).toBe('doc')
      expect(snap.desktop.items.find((i) => i.name === 'C.lnk')?.zone).toBe('app')
      expect(snap.desktop.plan.dock.map((d) => [d.name, d.source])).toEqual([['C.lnk', 'pinned']])
      // 无效参照（参照条目在被拖组内——批量特有的整批校验；他区/池外参照同拒）：整批拒绝
      const bad = await ctx.bridge.invoke('desktop/move-batch', { names: ['A.lnk', 'C.lnk'], zone: 'app', beforeName: 'C.lnk' })
      expect(bad.ok).toBe(false)
      expect(bad.error).toBeTruthy()
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/pin + desktop/unpin（工单25）：手钉清单变更即时重编排，池外名字拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'hot.lnk'), 'stub')
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
      // 钉到应用区：文档类条目进 dock 前段（pinned），占栏位不被推荐顶替
      const pinned = await ctx.bridge.invoke('desktop/pin', { name: 'n.docx' })
      expect(pinned).toEqual({ ok: true })
      let snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => [d.name, d.source])).toEqual([
        ['n.docx', 'pinned'],
        ['A.lnk', 'recommended'],
        ['hot.lnk', 'recommended'],
      ])
      expect(snap.desktop.plan.docs).toEqual([])
      expect(snap.desktop.items.find((i) => i.name === 'n.docx')?.zone).toBe('app')
      // 取消手钉：回归归类（文档类回文档区）
      const unpinned = await ctx.bridge.invoke('desktop/unpin', { name: 'n.docx' })
      expect(unpinned).toEqual({ ok: true })
      snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => d.source)).toEqual(['recommended', 'recommended'])
      expect(snap.desktop.plan.docs.map((d) => d.name)).toEqual(['n.docx'])
      expect(snap.desktop.items.find((i) => i.name === 'n.docx')?.zone).toBe('doc')
      // 池外名字拒绝（move 同款护栏）
      await expect(ctx.bridge.invoke('desktop/pin', { name: 'ghost.lnk' }))
        .resolves.toMatchObject({ ok: false, error: '桌面项不在当前扫描池内' })
      await expect(ctx.bridge.invoke('desktop/unpin', { name: 'ghost.lnk' }))
        .resolves.toMatchObject({ ok: false, error: '桌面项不在当前扫描池内' })
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

describe('内核桥接契约（工单03 Qoder 状态块退役）', () => {
  /** 落一个插件目录：manifest + 入口资产（工单10 同款最小形态） */
  function writePlugin(root: string, manifest: Record<string, unknown>): void {
    const dir = path.join(root, String(manifest.id))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
    fs.writeFileSync(path.join(dir, 'card.js'), 'export default {}', 'utf8')
  }

  it('插件能力表无 qoder：快照段移除后能力声明不撒谎', () => {
    expect(PLUGIN_CAPABILITIES).not.toContain('qoder')
  })

  it('旧 manifest 声明的 qoder 能力按未知能力串静默丢弃，manifest 仍有效', async () => {
    const dir = tmpDir()
    const root = path.join(dir, 'plugins')
    const ctx = createKernel(kernelOpts(dir, { plugins: { roots: [root], watch: false } }))
    await ctx.start()
    try {
      writePlugin(root, {
        id: 'legacy-qoder', name: '旧状态卡', version: '1.0.0', entry: './card.js',
        capabilities: ['qoder', 'clock'],
      })
      ctx.plugins!.rescan()
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.plugins[0]).toMatchObject({ id: 'legacy-qoder', status: 'ok', capabilities: ['clock'] })
    } finally {
      await ctx.stop()
    }
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

describe('内核桥接契约（工单49 任务栏）', () => {
  /** 任务栏桩：config 落 tmp 文件（断言持久化不触真 config.json）+ 假按键源 */
  function taskbarOpts(dir: string, over: Record<string, unknown> = {}) {
    const sent: string[] = []
    const so = settingsOpts(dir)
    return {
      sent,
      opts: {
        ...so,
        taskbar: {
          file: so.settings.file,
          config: so.settings.config,
          deps: { sendSystemKeys: (action: TaskbarSystemAction) => { sent.push(action); return true } },
          ...over,
        },
      },
    }
  }

  it('taskbar/get-state：初值随 config taskbar 段（缺省启用；enabled:false 即禁用）', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('taskbar/get-state', null))
        .resolves.toEqual({ enabled: true, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })
    } finally {
      await ctx.stop()
    }
    const dir2 = tmpDir()
    const t2 = taskbarOpts(dir2, { enabled: false })
    const ctx2 = createKernel(kernelOpts(dir2, t2.opts))
    await ctx2.start()
    try {
      await expect(ctx2.bridge.invoke('taskbar/get-state', null))
        .resolves.toEqual({ enabled: false, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })
    } finally {
      await ctx2.stop()
    }
  }, 30_000)

  it('taskbar/set-enabled：切换即时回推 taskbar/changed、整份回写 config.json；同值幂等不重推', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      const changed: TaskbarState[] = []
      ctx.bridge.subscribe('taskbar/changed', (s) => changed.push(s))
      await expect(ctx.bridge.invoke('taskbar/set-enabled', { enabled: false })).resolves
        .toEqual({ enabled: false, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })
      await expect(ctx.bridge.invoke('taskbar/get-state', null)).resolves
        .toEqual({ enabled: false, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })
      await expect(ctx.bridge.invoke('taskbar/set-enabled', { enabled: true })).resolves
        .toEqual({ enabled: true, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })
      // 幂等：同值不重复推事件
      await ctx.bridge.invoke('taskbar/set-enabled', { enabled: true })
      expect(changed.map((s) => s.enabled)).toEqual([false, true])
      const onDisk = JSON.parse(fs.readFileSync(t.opts.taskbar.file, 'utf8'))
      expect(onDisk.taskbar).toEqual({ enabled: true, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })
    } finally {
      await ctx.stop()
    }
  }, 30_000)

  it('taskbar/set-enabled：非布尔值拒绝（契约违规不静默吞掉）', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('taskbar/set-enabled', { enabled: 'off' as never }))
        .rejects.toThrow(/taskbar\.enabled/)
      await expect(ctx.bridge.invoke('taskbar/get-state', null)).resolves
        .toEqual({ enabled: true, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] })
    } finally {
      await ctx.stop()
    }
  }, 30_000)

  it('taskbar/system-action：开始菜单/任务视图经桥到达按键合成源；未知动作抛 BridgeError', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('taskbar/system-action', { action: 'start-menu' })).resolves.toEqual({ ok: true })
      await expect(ctx.bridge.invoke('taskbar/system-action', { action: 'task-view' })).resolves.toEqual({ ok: true })
      expect(t.sent).toEqual(['start-menu', 'task-view'])
      await expect(ctx.bridge.invoke('taskbar/system-action', { action: 'ghost' as never }))
        .rejects.toThrow(/未知任务栏系统动作/)
    } finally {
      await ctx.stop()
    }
  }, 30_000)

  it('taskbar/system-action：合成被系统拒收回报 ok:false（不 reject——点击语义不需 try/catch）', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir, { deps: { sendSystemKeys: () => false } })
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('taskbar/system-action', { action: 'start-menu' })).resolves.toEqual({ ok: false })
    } finally {
      await ctx.stop()
    }
  }, 30_000)

  it('插件卸载（内核停）：补发 enabled:false 终态帧，效果层经「禁用即销窗」收窗', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    const changed: TaskbarState[] = []
    ctx.bridge.subscribe('taskbar/changed', (s) => changed.push(s))
    await ctx.stop()
    expect(changed).toEqual([{ enabled: false, metrics: ['cpu', 'gpu', 'ram', 'net-down', 'net-up'] }])
  }, 30_000)
})

describe('内核桥接契约（工单55 任务栏右组）', () => {
  function taskbarOpts(dir: string, over: Record<string, unknown> = {}) {
    const sent: string[] = []
    const so = settingsOpts(dir)
    return {
      sent,
      opts: {
        ...so,
        taskbar: {
          file: so.settings.file,
          config: so.settings.config,
          deps: { sendSystemKeys: (action: TaskbarSystemAction) => { sent.push(action); return true } },
          ...over,
        },
      },
    }
  }

  it('taskbar/system-action：通知中心/快速设置/显示桌面经桥到达按键合成源', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('taskbar/system-action', { action: 'notification-center' })).resolves.toEqual({ ok: true })
      await expect(ctx.bridge.invoke('taskbar/system-action', { action: 'quick-settings' })).resolves.toEqual({ ok: true })
      await expect(ctx.bridge.invoke('taskbar/system-action', { action: 'toggle-desktop' })).resolves.toEqual({ ok: true })
      expect(t.sent).toEqual(['notification-center', 'quick-settings', 'toggle-desktop'])
    } finally {
      await ctx.stop()
    }
  }, 30_000)

  it('taskbar/set-metrics：勾选子集即时回推 taskbar/changed、整份回写 config.json（重启保持的依据）；同值幂等不重推', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      const changed: TaskbarState[] = []
      ctx.bridge.subscribe('taskbar/changed', (s) => changed.push(s))
      await expect(ctx.bridge.invoke('taskbar/set-metrics', { metrics: ['ram', 'cpu'] })).resolves
        .toEqual({ enabled: true, metrics: ['cpu', 'ram'] })
      await expect(ctx.bridge.invoke('taskbar/get-state', null)).resolves
        .toEqual({ enabled: true, metrics: ['cpu', 'ram'] })
      // 空子集合法（摘要整格隐藏）
      await expect(ctx.bridge.invoke('taskbar/set-metrics', { metrics: [] })).resolves
        .toEqual({ enabled: true, metrics: [] })
      // 幂等：同值不重复推事件
      await ctx.bridge.invoke('taskbar/set-metrics', { metrics: [] })
      expect(changed.map((s) => s.metrics)).toEqual([['cpu', 'ram'], []])
      const onDisk = JSON.parse(fs.readFileSync(t.opts.taskbar.file, 'utf8'))
      expect(onDisk.taskbar).toEqual({ enabled: true, metrics: [] })
    } finally {
      await ctx.stop()
    }
  }, 30_000)

  it('taskbar/set-metrics：未知指标名拒绝（契约违规不静默吞掉），全不勾选之外的开关互不影响', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      await ctx.bridge.invoke('taskbar/set-metrics', { metrics: ['gpu'] })
      await expect(ctx.bridge.invoke('taskbar/set-metrics', { metrics: ['cpu', 'ghost'] as never }))
        .rejects.toThrow(/taskbar\.metrics/)
      await expect(ctx.bridge.invoke('taskbar/get-state', null)).resolves
        .toEqual({ enabled: true, metrics: ['gpu'] })
      // 勾选子集不被开关切换冲掉（setEnabled 只动 enabled 位）
      await ctx.bridge.invoke('taskbar/set-enabled', { enabled: false })
      await expect(ctx.bridge.invoke('taskbar/get-state', null)).resolves
        .toEqual({ enabled: false, metrics: ['gpu'] })
    } finally {
      await ctx.stop()
    }
  }, 30_000)

  it('taskbar/status：每拍快照随 tick 回推时钟 + 硬件仪表（右组 1Hz 数据源）', async () => {
    const dir = tmpDir()
    const t = taskbarOpts(dir)
    const ctx = createKernel(kernelOpts(dir, t.opts))
    await ctx.start()
    try {
      const received: TaskbarStatus[] = []
      const off = ctx.bridge.subscribe('taskbar/status', (s) => received.push(s))
      ctx.bridge.tick()
      expect(received).toHaveLength(1)
      expect(received[0].clock.epochMs).toBeGreaterThan(0)
      expect(typeof received[0].hardware.cpu).toBe('number')
      off()
      ctx.bridge.tick()
      expect(received).toHaveLength(1)
    } finally {
      await ctx.stop()
    }
  }, 30_000)
})

describe('内核桥接契约（工单30 粘贴与剪贴板态）', () => {
  it('desktop/clipboard-state 只读可贴态 + desktop/paste 无文件整份拒绝（菜单置灰依据）', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          readClipboardFiles: async () => null,
        },
      }),
    }))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('desktop/clipboard-state', null)).resolves.toEqual({ pasteable: false })
      await expect(ctx.bridge.invoke('desktop/paste', null)).resolves
        .toEqual({ ok: false, pasted: [], failed: [], error: '剪贴板没有可粘贴的文件' })
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/paste（copy）：递归复制落用户桌面根；同名「 - 副本」递增多份不互相覆盖', async () => {
    const dir = tmpDir()
    const staging = path.join(dir, 'staging')
    fs.mkdirSync(path.join(staging, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(staging, 'DECK30.txt'), 'v1')
    fs.writeFileSync(path.join(staging, 'docs', 'inner.txt'), 'inner')
    fs.writeFileSync(path.join(dir, 'user', 'DECK30.txt'), 'original') // 冲突靶子
    const clip = {
      paths: [path.join(staging, 'DECK30.txt'), path.join(staging, 'docs')],
      effect: 'copy' as const,
    }
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          readClipboardFiles: async () => clip,
        },
      }),
    }))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('desktop/clipboard-state', null)).resolves.toEqual({ pasteable: true })
      await expect(ctx.bridge.invoke('desktop/paste', null)).resolves
        .toEqual({ ok: true, pasted: ['DECK30 - 副本.txt', 'docs'], failed: [] })
      // 冲突不覆盖：原名与副本各有内容
      expect(fs.readFileSync(path.join(dir, 'user', 'DECK30.txt'), 'utf8')).toBe('original')
      expect(fs.readFileSync(path.join(dir, 'user', 'DECK30 - 副本.txt'), 'utf8')).toBe('v1')
      expect(fs.existsSync(path.join(dir, 'user', 'docs', 'inner.txt'))).toBe(true) // 文件夹递归复制
      // 再贴一份：续号「 - 副本 2」不互相覆盖（文件夹同款）
      await expect(ctx.bridge.invoke('desktop/paste', null)).resolves
        .toEqual({ ok: true, pasted: ['DECK30 - 副本 2.txt', 'docs - 副本'], failed: [] })
      expect(fs.readFileSync(path.join(dir, 'user', 'DECK30 - 副本 2.txt'), 'utf8')).toBe('v1')
      expect(fs.existsSync(path.join(dir, 'user', 'docs - 副本', 'inner.txt'))).toBe(true)
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/paste（move）：rename 落盘源离位；部分失败信封（成功保留 + failed 明细）', async () => {
    const dir = tmpDir()
    const staging = path.join(dir, 'staging')
    fs.mkdirSync(staging, { recursive: true })
    const srcA = path.join(staging, 'A.txt')
    fs.writeFileSync(srcA, 'move-me')
    const clip = {
      paths: [srcA, path.join(staging, 'GHOST.txt')], // GHOST 不在盘上：真 fs 落败 → 部分失败
      effect: 'move' as const,
    }
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
          readClipboardFiles: async () => clip,
        },
      }),
    }))
    await ctx.start()
    try {
      const r = await ctx.bridge.invoke('desktop/paste', null)
      expect(r.ok).toBe(false)
      expect(r.pasted).toEqual(['A.txt'])
      expect(r.failed).toEqual(['GHOST.txt'])
      expect(r.error).toContain('GHOST.txt')
      expect(fs.existsSync(srcA)).toBe(false) // move 语义：源离位
      expect(fs.readFileSync(path.join(dir, 'user', 'A.txt'), 'utf8')).toBe('move-me')
    } finally {
      await ctx.stop()
    }
  })
})
