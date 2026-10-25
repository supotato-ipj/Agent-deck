import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { PluginHostService, type PluginInstance, type PluginHostOptions } from '../../src/main/plugins/service'
import { PLUGIN_SCHEME } from '../../src/main/plugins/assets'
import type { PluginInfo, PluginManifest } from '../../src/shared/contract'

/**
 * 桌面组件宿主（工单10 契约缝）：插件目录扫描 → manifest 契约 → 生命周期（加载/卸载/重载）
 * → 变更推送。文件系统是真 fs，Electron 零依赖；watch 可关以便确定性驱动。
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plug-'))
}

/** 落一个插件目录：manifest + 入口资产 */
function writePlugin(root: string, manifest: Record<string, unknown>, entryText = 'export default {}'): string {
  const dir = path.join(root, String(manifest.id))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
  const entry = String(manifest.entry ?? './card.js')
  fs.writeFileSync(path.join(dir, entry.replace(/^\.\//, '')), entryText, 'utf8')
  return dir
}

function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'clock', name: '时钟', version: '1.0.0', entry: './card.js', capabilities: ['clock'], ...over }
}

/** 起一台内核（tick 全关，离线自足）；返回 ctx 与事件收集器 */
async function boot(roots: string[], over: Partial<PluginHostOptions> = {}) {
  const ctx = new Context()
  ctx.plugin(PluginHostService, { roots, watch: false, ...over })
  const events: PluginInfo[][] = []
  await ctx.start()
  ctx.on('plugins/changed', (list) => events.push(list))
  return { ctx, events }
}

describe('插件目录扫描（工单10 桌面组件宿主）', () => {
  it('空根目录 → 空清单，不抛', async () => {
    const root = tmpDir()
    const { ctx } = await boot([root])
    expect(ctx.plugins.info()).toEqual([])
    await ctx.stop()
  })

  it('根目录不存在 → 空清单，不抛（插件目录可晚于面板启动创建）', async () => {
    const { ctx } = await boot([path.join(tmpDir(), 'not-created-yet')])
    expect(ctx.plugins.info()).toEqual([])
    await ctx.stop()
  })

  it('合法插件被识别，entry 解析为可直接 import 的协议 URL', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    const { ctx } = await boot([root])
    const [info] = ctx.plugins.info()
    expect(info).toMatchObject({
      id: 'clock', name: '时钟', version: '1.0.0',
      capabilities: ['clock'], status: 'ok', error: null,
    })
    expect(info.entry.startsWith(`${PLUGIN_SCHEME}://clock/card.js?v=`)).toBe(true)
    await ctx.stop()
  })

  it('坏 manifest 不静默消失：以 error 态在列，entry 为空（渲染层无从 import）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest({ id: undefined }))
    const { ctx } = await boot([root])
    const [info] = ctx.plugins.info()
    expect(info.status).toBe('error')
    expect(info.error).toMatch(/id/)
    expect(info.entry).toBe('')
    await ctx.stop()
  })

  it('manifest 合法但入口资产缺失 → error 态（坏插件不投递半残组件）', async () => {
    const root = tmpDir()
    const dir = fs.mkdtempSync(path.join(root, 'ghost-'))
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(baseManifest({ id: 'ghost' })), 'utf8')
    const { ctx } = await boot([root])
    const info = ctx.plugins.info().find((p) => p.id === 'ghost')
    expect(info?.status).toBe('error')
    expect(info?.error).toMatch(/entry|不存在|缺失/)
    await ctx.stop()
  })

  it('同 id 跨根先到先得（内置根在前 = 内置组件不被同名用户插件顶替）', async () => {
    const builtin = tmpDir()
    const user = tmpDir()
    writePlugin(builtin, baseManifest({ name: '内置时钟' }))
    writePlugin(user, baseManifest({ name: '冒名时钟' }))
    const { ctx } = await boot([builtin, user])
    expect(ctx.plugins.info()).toHaveLength(1)
    expect(ctx.plugins.info()[0].name).toBe('内置时钟')
    await ctx.stop()
  })

  it('排序：order 小者在前；同 order 按 id 字典序（结果稳定，不随扫描顺序抖动）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest({ id: 'zzz', order: 10 }))
    writePlugin(root, baseManifest({ id: 'aaa', order: 10 }))
    writePlugin(root, baseManifest({ id: 'mmm', order: 1 }))
    const { ctx } = await boot([root])
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['mmm', 'aaa', 'zzz'])
    await ctx.stop()
  })

  it('原型键 id 可寻址（09 踩坑 1 的纪律：查表全程 Map，无原型链命中）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest({ id: 'constructor' }))
    const { ctx } = await boot([root])
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['constructor'])
    expect(ctx.plugins.dirOf('constructor')).toBe(path.join(root, 'constructor'))
    await ctx.stop()
  })

  it('dirOf 对未登记 id 返回 undefined（含原型键名，不落 Object.prototype）', async () => {
    const root = tmpDir()
    const { ctx } = await boot([root])
    expect(ctx.plugins.dirOf('toString')).toBeUndefined()
    expect(ctx.plugins.dirOf('clock')).toBeUndefined()
    await ctx.stop()
  })
})

describe('插件生命周期（cordis 子集：装载 ready / 卸载 dispose / 重载换代号）', () => {
  it('首扫即装载，逐个调 ready（ctx 可注入，插件侧资源随内核生命周期走）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    const seen: string[] = []
    const ctx = new Context()
    ctx.plugin(PluginHostService, {
      roots: [root], watch: false,
      createInstance: (c, manifest, dir, info) => ({
        manifest, dir, info,
        ready: () => { seen.push(`${manifest.id}:${c === (c as unknown as Context) ? 'ctx' : '?'}:${dir === path.join(root, 'clock')}`) },
        dispose: () => { seen.push(`${manifest.id}:disposed`) },
      }),
    })
    await ctx.start()
    expect(seen).toEqual(['clock:ctx:true'])
    await ctx.stop()
  })

  it('重扫：新增插件装载、消失插件卸载（dispose 必调），并推 plugins/changed', async () => {
    const root = tmpDir()
    const disposed: string[] = []
    const ctx = new Context()
    ctx.plugin(PluginHostService, {
      roots: [root], watch: false,
      createInstance: (_c, manifest, dir, info) => ({
        manifest, dir, info, ready: () => {}, dispose: () => { disposed.push(manifest.id) },
      }),
    })
    const events: PluginInfo[][] = []
    await ctx.start()
    ctx.on('plugins/changed', (l) => events.push(l))

    writePlugin(root, baseManifest())
    ctx.plugins.rescan()
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['clock'])

    fs.rmSync(path.join(root, 'clock'), { recursive: true, force: true })
    ctx.plugins.rescan()
    expect(ctx.plugins.info()).toEqual([])
    expect(disposed).toEqual(['clock'])
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual([])
    await ctx.stop()
  })

  it('资产变化即重载：revision 递增、entry URL 随之变化（渲染层绕开 ESM 模块缓存）', async () => {
    const root = tmpDir()
    const dir = writePlugin(root, baseManifest())
    const { ctx } = await boot([root])
    const before = ctx.plugins.info()[0]
    expect(before.status).toBe('ok')

    fs.writeFileSync(path.join(dir, 'card.js'), 'export default { v: 2 }', 'utf8')
    ctx.plugins.rescan()
    const after = ctx.plugins.info()[0]
    expect(after.revision).toBeGreaterThan(before.revision)
    expect(after.entry).not.toBe(before.entry)
    await ctx.stop()
  })

  it('manifest 版本变化同样递增 revision', async () => {
    const root = tmpDir()
    const dir = writePlugin(root, baseManifest())
    const { ctx } = await boot([root])
    const before = ctx.plugins.info()[0].revision
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(baseManifest({ version: '2.0.0' })), 'utf8')
    ctx.plugins.rescan()
    expect(ctx.plugins.info()[0].revision).toBeGreaterThan(before)
    await ctx.stop()
  })

  it('清单未变的重扫不推事件（1Hz tick 与看门狗同频时无谓刷新）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    const { ctx, events } = await boot([root])
    ctx.plugins.rescan()
    ctx.plugins.rescan()
    expect(events).toHaveLength(0)
    await ctx.stop()
  })

  it('内核停机即全场卸载（每个在装实例 dispose）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    writePlugin(root, baseManifest({ id: 'weather', entry: './card.js' }))
    const disposed: string[] = []
    const ctx = new Context()
    ctx.plugin(PluginHostService, {
      roots: [root], watch: false,
      createInstance: (_c, manifest, dir, info) => ({
        manifest, dir, info, ready: () => {}, dispose: () => { disposed.push(manifest.id) },
      }),
    })
    await ctx.start()
    await ctx.stop()
    expect(disposed.sort()).toEqual(['clock', 'weather'])
  })

  it('卸载单个插件：移除其目录 → 只卸那一个，其余在列且清单即时更新', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    writePlugin(root, baseManifest({ id: 'weather' }))
    const disposed: string[] = []
    const ctx = new Context()
    ctx.plugin(PluginHostService, {
      roots: [root], watch: false,
      createInstance: (_c, manifest, dir, info) => ({
        manifest, dir, info, ready: () => {}, dispose: () => { disposed.push(manifest.id) },
      }),
    })
    const events: PluginInfo[][] = []
    await ctx.start()
    ctx.on('plugins/changed', (l) => events.push(l))

    fs.rmSync(path.join(root, 'clock'), { recursive: true, force: true })
    ctx.plugins.rescan()
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['weather'])
    expect(disposed).toEqual(['clock'])
    expect(ctx.plugins.dirOf('clock')).toBeUndefined()
    expect(events.at(-1)?.map((p) => p.id)).toEqual(['weather'])

    // 放回即恢复（不重启面板）；两者 order 缺省同值 → 按 id 字典序
    writePlugin(root, baseManifest())
    ctx.plugins.rescan()
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['clock', 'weather'])
    await ctx.stop()
  })

  it('坏插件重扫后从 error 转 ok（用户改好 manifest 即自愈，无需重启面板）', async () => {
    const root = tmpDir()
    const dir = fs.mkdtempSync(path.join(root, 'fixme-'))
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: '半成品' }), 'utf8')
    const { ctx } = await boot([root])
    expect(ctx.plugins.info()[0].status).toBe('error')

    const fixed = path.join(root, 'fixed')
    fs.mkdirSync(fixed, { recursive: true })
    fs.writeFileSync(path.join(fixed, 'plugin.json'), JSON.stringify(baseManifest({ id: 'fixed' })), 'utf8')
    fs.writeFileSync(path.join(fixed, 'card.js'), 'export default {}', 'utf8')
    fs.rmSync(dir, { recursive: true, force: true })
    ctx.plugins.rescan()
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['fixed'])
    await ctx.stop()
  })
})

describe('插件清单停用集过滤（工单101 卡片显隐开关）', () => {
  /** 可变停用集（模拟 config.plugins.disabled 活引用经设置服务改写） */
  function disabledRef(initial: string[] = []) {
    const state = { disabled: initial }
    return {
      get: () => state.disabled,
      set: (next: string[]) => { state.disabled = next },
    }
  }

  async function bootWithDisabled(roots: string[], ref: ReturnType<typeof disabledRef>, over: Partial<PluginHostOptions> = {}) {
    const ctx = new Context()
    ctx.plugin(PluginHostService, { roots, watch: false, disabledIds: ref.get, ...over })
    const events: PluginInfo[][] = []
    await ctx.start()
    ctx.on('plugins/changed', (list) => events.push(list))
    return { ctx, events }
  }

  it('空停用集默认全启用（缺省读缝恒空，离线装配不接设置域也不炸）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    const { ctx } = await boot([root])
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['clock'])
    await ctx.stop()
  })

  it('停用 = 从清单剔除：包目录原地不动、在装实例走卸载链（dispose 调用、dirOf 摘除）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    writePlugin(root, baseManifest({ id: 'weather' }))
    const ref = disabledRef()
    const disposed: string[] = []
    const ctx = new Context()
    ctx.plugin(PluginHostService, {
      roots: [root], watch: false, disabledIds: ref.get,
      createInstance: (_c, manifest, dir, info) => ({
        manifest, dir, info, ready: () => {}, dispose: () => { disposed.push(manifest.id) },
      }),
    })
    await ctx.start()
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['clock', 'weather'])

    ref.set(['clock'])
    ctx.plugins.rescan()
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['weather'])
    expect(disposed).toEqual(['clock'])
    expect(ctx.plugins.dirOf('clock')).toBeUndefined()
    expect(fs.existsSync(path.join(root, 'clock', 'plugin.json'))).toBe(true) // 包文件不动
    await ctx.stop()
  })

  it('先到先得不受影响：同 id 内置与用户并存时停用按 id 整体生效，不停用则内置胜出', async () => {
    const builtin = tmpDir()
    const user = tmpDir()
    writePlugin(builtin, baseManifest({ name: '内置时钟' }))
    writePlugin(user, baseManifest({ name: '冒名时钟' }))
    const ref = disabledRef()
    const { ctx } = await bootWithDisabled([builtin, user], ref)
    expect(ctx.plugins.info()[0].name).toBe('内置时钟')

    ref.set(['clock'])
    ctx.plugins.rescan()
    expect(ctx.plugins.info()).toEqual([])
    await ctx.stop()
  })

  it('重新启用原位恢复：清单回来（代号重计，entry URL 换新绕开 ESM 缓存）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    const ref = disabledRef(['clock'])
    const { ctx } = await bootWithDisabled([root], ref)
    expect(ctx.plugins.info()).toEqual([])

    ref.set([])
    ctx.plugins.rescan()
    const [info] = ctx.plugins.info()
    expect(info.id).toBe('clock')
    expect(info.status).toBe('ok')
    expect(info.entry).toContain(`${PLUGIN_SCHEME}://clock/card.js?v=1`)
    await ctx.stop()
  })

  it('停用集含未发现 id 无害（目录暂缺的停用条目静默待命，不炸扫描）', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    const ref = disabledRef(['ghost', 'clock'])
    const { ctx } = await bootWithDisabled([root], ref)
    expect(ctx.plugins.info()).toEqual([])

    ref.set(['ghost'])
    ctx.plugins.rescan()
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['clock'])
    await ctx.stop()
  })

  it('settings/cards-changed 事件即重扫：设置服务落盘后无需手动 rescan，清单即时剔除/恢复', async () => {
    const root = tmpDir()
    writePlugin(root, baseManifest())
    const ref = disabledRef()
    const { ctx, events } = await bootWithDisabled([root], ref)
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['clock'])

    // emit 同步触发监听器（rescan 读缝取当拍停用集）：先改写活引用再发事件，与设置服务落盘后提交同序
    ref.set(['clock'])
    ctx.emit('settings/cards-changed', { disabled: ['clock'] })
    expect(ctx.plugins.info()).toEqual([])
    expect(events.at(-1)).toEqual([])

    ref.set([])
    ctx.emit('settings/cards-changed', { disabled: [] })
    expect(ctx.plugins.info().map((p) => p.id)).toEqual(['clock'])
    await ctx.stop()
  })
})

describe('插件目录看门狗（真 fs.watch：放入即被识别，移除即消失）', () => {
  async function waitForEvent(ctx: Context, pred: (l: PluginInfo[]) => boolean, timeoutMs = 5000): Promise<PluginInfo[]> {
    const seen: PluginInfo[][] = []
    const off = ctx.on('plugins/changed', (l) => seen.push(l))
    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
        ctx.plugins.rescan()
        const hit = seen.find(pred)
        if (hit) return hit
      }
    } finally {
      off()
    }
    throw new Error(`等待 plugins/changed 超时，已收到：${JSON.stringify(seen)}`)
  }

  it('插件目录放入 → 无需重启即被识别；删除 → 卡片消失', async () => {
    const root = tmpDir()
    const ctx = new Context()
    ctx.plugin(PluginHostService, { roots: [root], settleMs: 40 })
    await ctx.start()
    try {
      expect(ctx.plugins.info()).toEqual([])
      writePlugin(root, baseManifest({ id: 'sample', name: '样例插件' }))
      const added = await waitForEvent(ctx, (l) => l.some((p) => p.id === 'sample' && p.status === 'ok'))
      expect(added.find((p) => p.id === 'sample')?.entry).toContain(`${PLUGIN_SCHEME}://sample/`)

      fs.rmSync(path.join(root, 'sample'), { recursive: true, force: true })
      await waitForEvent(ctx, (l) => l.length === 0)
      expect(ctx.plugins.info()).toEqual([])
    } finally {
      await ctx.stop()
    }
  })
})
