/**
 * 设置服务测试（工单08）：透明度 clamp/校验、config 整份回写持久化、
 * settings/changed 事件推送（只变才推）。文件 I/O 走 tmp 目录假源。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultAppearance, defaultAutostart, defaultDesktopLayout, defaultPlugins, defaultSearchConfig, defaultTaskbar, defaultTools, defaultWeather, loadConfig } from '../src/main/config'
import type { AppConfig } from '../src/main/config'
import { SettingsService } from '../src/main/services/settings'
import type { SettingsState } from '../src/shared/contract'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-set-')), 'config.json')
}

function configWith(cardOpacity: number): AppConfig {
  return {
    panel: { x: 0, y: 0, width: 100, height: 100 },
    weather: defaultWeather(),
    desktop: defaultDesktopLayout(),
    search: defaultSearchConfig(),
    appearance: { cardOpacity },
    tools: defaultTools(),
    plugins: defaultPlugins(),
    autostart: defaultAutostart(),
    taskbar: defaultTaskbar(),
  }
}

/** 落盘后的 loadConfig 回读（重启语义）：以任一完整默认 config 为合并兜底 */
function loadConfigSilently(file: string): AppConfig {
  return loadConfig(file, configWith(0.55)).config
}

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function watchEvents(ctx: Context): SettingsState[] {
  const received: SettingsState[] = []
  ctx.on('settings/changed', (s) => received.push(s))
  return received
}

describe('设置服务（工单08）', () => {
  it('初值来自 config.appearance', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService, { config: configWith(0.3) })
    await ctx.start()
    try {
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.3, disabledCards: [] })
    } finally {
      await ctx.stop()
    }
  })

  it('无 config 注入时取默认值（离线测试省配置桩，内存态可用）', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService)
    await ctx.start()
    try {
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.55, disabledCards: [] })
    } finally {
      await ctx.stop()
    }
  })

  it('setCardOpacity clamp 到 0..1 并回推事件', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService, { config: configWith(0.55) })
    await ctx.start()
    const events = watchEvents(ctx)
    try {
      expect(ctx.settings!.setCardOpacity(0.25)).toEqual({ cardOpacity: 0.25, disabledCards: [] })
      expect(ctx.settings!.setCardOpacity(1.7)).toEqual({ cardOpacity: 1, disabledCards: [] })
      expect(ctx.settings!.setCardOpacity(-0.2)).toEqual({ cardOpacity: 0, disabledCards: [] })
      expect(events).toEqual([{ cardOpacity: 0.25, disabledCards: [] }, { cardOpacity: 1, disabledCards: [] }, { cardOpacity: 0, disabledCards: [] }])
    } finally {
      await ctx.stop()
    }
  })

  it('非有限数字拒绝（契约违规，不 clamp 吞掉）', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService, { config: configWith(0.55) })
    await ctx.start()
    try {
      await expect(async () => ctx.settings!.setCardOpacity('dark' as never)).rejects.toThrow(/cardOpacity/)
      await expect(async () => ctx.settings!.setCardOpacity(Number.NaN)).rejects.toThrow(/cardOpacity/)
      await expect(async () => ctx.settings!.setCardOpacity(Number.POSITIVE_INFINITY)).rejects.toThrow(/cardOpacity/)
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.55, disabledCards: [] })
    } finally {
      await ctx.stop()
    }
  })

  it('同值重设幂等：不落盘不推事件', async () => {
    const file = tmpFile()
    tmpDirs.push(path.dirname(file))
    const config = configWith(0.55)
    const ctx = new Context()
    ctx.plugin(SettingsService, { file, config })
    await ctx.start()
    const events = watchEvents(ctx)
    try {
      expect(ctx.settings!.setCardOpacity(0.55)).toEqual({ cardOpacity: 0.55, disabledCards: [] })
      expect(events).toHaveLength(0)
    } finally {
      await ctx.stop()
    }
  })

  it('持久化 = config 整份回写（其余段原样保留，读回一致）', async () => {
    const file = tmpFile()
    tmpDirs.push(path.dirname(file))
    const config = configWith(0.55)
    config.search.port = 39999
    config.panel = { x: 20, y: 30, width: 800, height: 600 }
    const ctx = new Context()
    ctx.plugin(SettingsService, { file, config })
    await ctx.start()
    try {
      ctx.settings!.setCardOpacity(0.2)
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
      expect(onDisk.appearance).toEqual({ cardOpacity: 0.2 })
      expect(onDisk.search).toEqual({ port: 39999, engine: 'auto', everythingPort: 80 })
      expect(onDisk.panel).toEqual({ x: 20, y: 30, width: 800, height: 600 })
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(config)
    } finally {
      await ctx.stop()
    }
  })

  it('落盘失败即拒绝：内存态与 config 引用都不被污染（先写盘后提交）', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-set-fail-'))
    tmpDirs.push(base)
    // 父路径是文件 → mkdirSync 抛 ENOTDIR（saveConfig 原子写的失败面）
    const blocker = path.join(base, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const file = path.join(blocker, 'config.json')
    const config = configWith(0.55)
    const ctx = new Context()
    ctx.plugin(SettingsService, { file, config })
    await ctx.start()
    const events = watchEvents(ctx)
    try {
      await expect(async () => ctx.settings!.setCardOpacity(0.2)).rejects.toThrow()
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.55, disabledCards: [] })
      expect(config.appearance).toEqual({ cardOpacity: 0.55 })
      expect(events).toHaveLength(0)
    } finally {
      await ctx.stop()
    }
  })

  it('无 file 注入时只改内存态，不落盘也不抛', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService, { config: configWith(0.55) })
    await ctx.start()
    try {
      expect(ctx.settings!.setCardOpacity(0.1)).toEqual({ cardOpacity: 0.1, disabledCards: [] })
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.1, disabledCards: [] })
      expect(defaultAppearance()).toEqual({ cardOpacity: 0.55 }) // 默认值未被误改
    } finally {
      await ctx.stop()
    }
  })
})

/**
 * 卡片显隐停用集（工单101）：settings/set-card-enabled 的服务面。停用 = config.plugins.disabled
 * 增删插件包 id（整份回写、先写盘后提交、settings/changed 即时回推），插件宿主经
 * settings/cards-changed 重扫清单剔除/恢复——这里只测数据面，清单过滤在 service.spec.ts。
 */
describe('设置服务·卡片显隐停用集（工单101）', () => {
  /** events: settings/changed；cards: settings/cards-changed（宿主重扫触发缝） */
  function watchers(ctx: Context) {
    const events: SettingsState[] = []
    const cards: Array<{ disabled: string[] }> = []
    ctx.on('settings/changed', (s) => events.push(s))
    ctx.on('settings/cards-changed', (p) => cards.push(p))
    return { events, cards }
  }

  function configWithDisabled(disabled: string[]): AppConfig {
    const config = configWith(0.55)
    config.plugins.disabled = [...disabled]
    return config
  }

  it('初值来自 config.plugins.disabled（重启保留的数据源，默认空集 = 全启用）', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService, { config: configWithDisabled(['search']) })
    await ctx.start()
    try {
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.55, disabledCards: ['search'] })
    } finally {
      await ctx.stop()
    }
  })

  it('停用/启用往返：停用集增删 + settings/changed 与 settings/cards-changed 逐事件推送', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService, { config: configWithDisabled([]) })
    await ctx.start()
    const { events, cards } = watchers(ctx)
    try {
      expect(ctx.settings!.setCardEnabled('search', false))
        .toEqual({ cardOpacity: 0.55, disabledCards: ['search'] })
      expect(ctx.settings!.setCardEnabled('calendar', false))
        .toEqual({ cardOpacity: 0.55, disabledCards: ['search', 'calendar'] })
      expect(ctx.settings!.setCardEnabled('search', true))
        .toEqual({ cardOpacity: 0.55, disabledCards: ['calendar'] })
      expect(events).toEqual([
        { cardOpacity: 0.55, disabledCards: ['search'] },
        { cardOpacity: 0.55, disabledCards: ['search', 'calendar'] },
        { cardOpacity: 0.55, disabledCards: ['calendar'] },
      ])
      expect(cards).toEqual([
        { disabled: ['search'] },
        { disabled: ['search', 'calendar'] },
        { disabled: ['calendar'] },
      ])
    } finally {
      await ctx.stop()
    }
  })

  it('同态幂等空转：已停用再停用 / 已启用再启用，不落盘不推事件', async () => {
    const file = tmpFile()
    tmpDirs.push(path.dirname(file))
    const config = configWithDisabled(['search'])
    const ctx = new Context()
    ctx.plugin(SettingsService, { file, config })
    await ctx.start()
    const { events, cards } = watchers(ctx)
    try {
      expect(ctx.settings!.setCardEnabled('search', false))
        .toEqual({ cardOpacity: 0.55, disabledCards: ['search'] })
      expect(ctx.settings!.setCardEnabled('clock', true))
        .toEqual({ cardOpacity: 0.55, disabledCards: ['search'] })
      expect(events).toHaveLength(0)
      expect(cards).toHaveLength(0)
    } finally {
      await ctx.stop()
    }
  })

  it('非法身份/开关值拒绝（契约违规）：id 须非空字符串、enabled 须布尔，状态不动', async () => {
    const ctx = new Context()
    ctx.plugin(SettingsService, { config: configWithDisabled([]) })
    await ctx.start()
    try {
      await expect(async () => ctx.settings!.setCardEnabled('', false)).rejects.toThrow(/id/)
      await expect(async () => ctx.settings!.setCardEnabled('   ', false)).rejects.toThrow(/id/)
      await expect(async () => ctx.settings!.setCardEnabled(42 as never, false)).rejects.toThrow(/id/)
      await expect(async () => ctx.settings!.setCardEnabled('search', 'yes' as never)).rejects.toThrow(/enabled/)
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.55, disabledCards: [] })
    } finally {
      await ctx.stop()
    }
  })

  it('持久化 = config.plugins 整份回写（其余段原样保留），config 引用同步、loadConfig 回读一致', async () => {
    const file = tmpFile()
    tmpDirs.push(path.dirname(file))
    const config = configWithDisabled([])
    config.search.port = 39999
    config.plugins.dir = 'D:\\deck-plugins'
    const ctx = new Context()
    ctx.plugin(SettingsService, { file, config })
    await ctx.start()
    try {
      ctx.settings!.setCardEnabled('search', false)
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
      expect(onDisk.plugins).toEqual({ dir: 'D:\\deck-plugins', disabled: ['search'] })
      expect(onDisk.search).toEqual({ port: 39999, engine: 'auto', everythingPort: 80 })
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(config)
      // loadConfig 默认合并回读：重启后停用集原样回来（不得丢）
      const reread = loadConfigSilently(file)
      expect(reread.plugins.disabled).toEqual(['search'])
    } finally {
      await ctx.stop()
    }
  })

  it('落盘失败即拒绝：内存态与 config 引用都不被污染（先写盘后提交，与透明度同纪律）', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-set101-fail-'))
    tmpDirs.push(base)
    const blocker = path.join(base, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const file = path.join(blocker, 'config.json')
    const config = configWithDisabled([])
    const ctx = new Context()
    ctx.plugin(SettingsService, { file, config })
    await ctx.start()
    const { events, cards } = watchers(ctx)
    try {
      await expect(async () => ctx.settings!.setCardEnabled('search', false)).rejects.toThrow()
      expect(ctx.settings!.state()).toEqual({ cardOpacity: 0.55, disabledCards: [] })
      expect(config.plugins.disabled).toEqual([])
      expect(events).toHaveLength(0)
      expect(cards).toHaveLength(0)
    } finally {
      await ctx.stop()
    }
  })
})
