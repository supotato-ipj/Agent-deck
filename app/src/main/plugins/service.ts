import fs from 'node:fs'
import path from 'node:path'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { PluginInfo, PluginManifest } from '../../shared/contract'
import { PLUGIN_SCHEME } from './assets'
import { readManifest } from './manifest'
import { listPluginDirs, watchPluginRoots } from './watch'

/**
 * 桌面组件宿主（工单10 插件体系）：插件目录即安装位，放入即被识别。
 *
 * 宿主只做四件事，边界刻意收窄：
 * 1. 扫根 → 读 plugin.json → manifest 契约校验（纯逻辑在 manifest.ts）
 * 2. 为每个插件登记一个实例，走 cordis 子集生命周期：装载 ready() / 卸载 dispose()
 * 3. 目录看门狗（fs.watch）触发重扫，变更以 `plugins/changed` 推给渲染层
 * 4. 快照段 `plugins` 携带清单，entry 已解析成可直接 import 的协议 URL
 *
 * 前端资产的读盘与投喂都在主进程（渲染层 contextIsolation + sandbox 不变）：
 * 插件文件永远不经渲染层触碰，资产经 deck-plugin:// 协议下发。
 * 插件拿到的快照按 manifest 的 capabilities 裁剪，裁剪在渲染层做（只有它能组装视图）。
 */

/** 未声明 order 的插件排在显式声明之后 */
export const DEFAULT_PLUGIN_ORDER = 1000

/** id 的合法字符集，与 manifest 校验同源（错误条目的兜底 id 也要守这条） */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/** 插件生命周期契约（cordis 3.x 圈定的子集：装载钩子 + 拆卸钩子 + ctx 注入） */
export interface PluginInstance {
  readonly info: PluginInfo
  readonly manifest: PluginManifest
  /** 插件目录绝对路径（协议资产根） */
  readonly dir: string
  /** 装载：插件侧主进程资源在此建立（ctx 即内核上下文，依赖注入自此可用） */
  ready(ctx: Context): void | Promise<void>
  /** 卸载：释放 ready 建立的一切 */
  dispose(): void | Promise<void>
}

export interface PluginHostOptions {
  /** 插件根目录，按序扫描；同 id 先到先得（内置根在前） */
  roots: string[]
  /**
   * 停用集读取缝（工单101 卡片显隐开关）：返回当前停用的插件包 id 列表，清单装配时剔除。
   * 读缝而非拷贝：设置服务改写 config.plugins.disabled 后无需重建宿主，重扫即生效；
   * 缺省恒空 = 全启用（离线装配不接设置域）。
   */
  disabledIds?: () => readonly string[]
  /** 目录看门狗（默认开；离线测试可关，改用显式 rescan 驱动） */
  watch?: boolean
  /** 看门狗风暴合并窗口（ms） */
  settleMs?: number
  /** 实例工厂（测试注入以观测生命周期；生产用默认实现） */
  createInstance?: (ctx: Context, manifest: PluginManifest, dir: string, info: PluginInfo) => PluginInstance
}

/** 一轮扫描的结果单元 */
interface Scanned {
  id: string
  dir: string
  manifest: PluginManifest | null
  error: string | null
  /** 资产指纹：manifest 原文 + 入口文件 mtime/size——任一变动即视为换了一代资产 */
  fingerprint: string
}

/** 坏插件的兜底 id：目录名清洗成合法主机名，让用户看得懂是哪个插件坏了 */
function fallbackId(dir: string): string {
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '')
  return base === '' ? 'broken' : base
}

function statOf(file: string): string {
  try {
    const s = fs.statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'missing'
  }
}

function fingerprintOf(dir: string, manifest: PluginManifest): string {
  return `${JSON.stringify(manifest)}|${statOf(path.join(dir, manifest.entry.replace(/^\.\//, '')))}`
}

/** 清单排序：order 小者在前，同 order 按 id 字典序（结果稳定，不随扫描顺序抖动） */
function byMountOrder(a: PluginInfo, b: PluginInfo): number {
  return (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export class PluginHostService extends Service {
  private readonly roots: string[]
  private readonly disabledIds: () => readonly string[]
  private readonly watchEnabled: boolean
  private readonly settleMs: number | undefined
  private readonly factory: NonNullable<PluginHostOptions['createInstance']>
  /** 在装实例：id → 实例（Map 查表，防原型链——09 踩坑 1 的纪律） */
  private readonly live = new Map<string, PluginInstance>()
  /** 资产指纹与代号：id → (fingerprint, revision) */
  private readonly generations = new Map<string, { fingerprint: string; revision: number }>()
  private listing: PluginInfo[] = []
  private stopped = false

  constructor(ctx: Context, options: PluginHostOptions) {
    super(ctx, 'plugins')
    this.roots = [...(options.roots ?? [])]
    this.disabledIds = options.disabledIds ?? (() => [])
    this.watchEnabled = options.watch ?? true
    this.settleMs = options.settleMs
    this.factory = options.createInstance ?? defaultInstance
    // 首扫在构造期完成：快照带插件清单，与其它服务同一节奏（不做则面板首帧无组件）
    this.rescan()
    if (this.watchEnabled && this.roots.length) {
      ctx.on('dispose', watchPluginRoots(this.roots, () => this.rescan(), { settleMs: this.settleMs }))
    }
    // 停用集变化即重扫（工单101）：设置服务落盘后发出，清单随即剔除/恢复——
    // 渲染层经既有 plugins/changed 即时路径卸载/重挂，包文件全程不动
    ctx.on('settings/cards-changed', () => this.rescan())
    ctx.on('dispose', () => this.disposeAll())
  }

  /** 当前清单（快照段 `plugins` 的来源；坏插件以 error 态在列，面板据此静默降级；
   * 停用包已被剔除——工单101，恢复出厂/资产指纹互不影响） */
  info(): PluginInfo[] {
    return this.listing
  }

  /** 协议资产根：插件 id → 目录；未登记 id（含原型键名）一律 undefined */
  dirOf(id: string): string | undefined {
    return this.live.get(id)?.dir
  }

  /** 在装插件的 id → 目录（协议处理器据此随插件增删实时扩缩资产根） */
  allDirs(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [id, instance] of this.live) out.set(id, instance.dir)
    return out
  }

  /**
   * 全量重扫：新增 → 装载、消失 → 卸载、资产变化 → 换代号重载。
   * 清单无实质变化时不发事件（1Hz tick 与看门狗同频时无谓刷新）。
   * 停用集过滤（工单101）在装配最上游：被停用的 id 视同本次没扫到——在装实例走
   * 既有「消失 → 卸载」链、清单自然不含（快照 plugins 段天然无停用包），包文件不动。
   */
  rescan(): PluginInfo[] {
    const disabled = new Set(this.disabledIds())
    const scanned = this.scan().filter((item) => !disabled.has(item.id))
    const seen = new Set<string>()

    for (const item of scanned) {
      seen.add(item.id)
      const previous = this.generations.get(item.id)
      const changed = !previous || previous.fingerprint !== item.fingerprint
      if (changed) {
        // 换了一代资产：先卸旧再装新（重载语义），代号递增供渲染层绕开 ESM 模块缓存
        this.unload(item.id)
        this.generations.set(item.id, { fingerprint: item.fingerprint, revision: (previous?.revision ?? 0) + 1 })
      }
      const info = this.toInfo(item)
      if (changed) {
        // 坏插件（manifest 无效）不建实例：没有契约就没有可执行的声明
        if (item.manifest) this.install(item.manifest, item.dir, info)
      }
    }

    for (const id of [...this.live.keys()]) if (!seen.has(id)) this.unload(id)
    for (const id of [...this.generations.keys()]) if (!seen.has(id)) this.generations.delete(id)

    const listing = scanned
      .map((item) => this.toInfo(item))
      .sort(byMountOrder)
    if (JSON.stringify(listing) !== JSON.stringify(this.listing)) {
      this.listing = listing
      this.ctx.emit('plugins/changed', listing)
    }
    return this.listing
  }

  /** 卸载单个插件（内部原语：重扫发现消失/换代会用到；对外的卸载动作是移除插件目录） */
  unload(id: string): boolean {
    const instance = this.live.get(id)
    if (!instance) return false
    this.live.delete(id)
    try {
      instance.dispose()
    } catch (err) {
      console.warn(`deck-plugins: ${id} 卸载钩子抛错（已摘除，不影响其余插件）：${err instanceof Error ? err.message : err}`)
    }
    return true
  }

  /**
   * 两轮扫描：**有效 manifest 绝对优先**于坏目录。
   * 先让所有根的有效插件按根序登记 id（先到先得），再把坏目录按未占用的兜底 id 补进来——
   * 一个写坏的插件不该因为目录名撞了内置 id 就把内置组件顶掉，反之亦然。
   */
  private scan(): Scanned[] {
    const valid: Scanned[] = []
    const broken: Scanned[] = []
    const claimed = new Set<string>()

    for (const root of this.roots) {
      for (const dir of listPluginDirs(root)) {
        const parsed = readManifest(dir)
        if (parsed.manifest) valid.push({
          id: parsed.manifest.id,
          dir,
          manifest: parsed.manifest,
          error: null,
          fingerprint: fingerprintOf(dir, parsed.manifest),
        })
        else broken.push({ id: fallbackId(dir), dir, manifest: null, error: parsed.error ?? 'manifest 无效', fingerprint: '' })
      }
    }

    const out: Scanned[] = []
    for (const item of valid) {
      if (claimed.has(item.id)) {
        console.warn(`deck-plugins: 插件 id 重复（${item.id}），按扫描根先到先得，忽略 ${item.dir}`)
        continue
      }
      claimed.add(item.id)
      out.push(item)
    }
    for (const item of broken) {
      if (claimed.has(item.id)) continue
      claimed.add(item.id)
      out.push(item)
    }
    return out
  }

  /** 快照条目：entry 解析为协议 URL 并带代号；坏插件 entry 为空串（无从 import） */
  private toInfo(item: Scanned): PluginInfo {
    const manifest = item.manifest
    const revision = this.generations.get(item.id)?.revision ?? 0
    if (!manifest) {
      return {
        id: item.id, name: item.id, version: '', entry: '', capabilities: [],
        order: DEFAULT_PLUGIN_ORDER, status: 'error', error: item.error, revision,
      }
    }
    // 入口资产缺失即坏插件：投递一个打不开的组件比不投递更糟（面板只剩空白与报错）
    if (statOf(path.join(item.dir, manifest.entry.replace(/^\.\//, ''))) === 'missing') {
      return {
        id: manifest.id, name: manifest.name, version: manifest.version, entry: '',
        capabilities: manifest.capabilities,
        ...(manifest.mount ? { mount: manifest.mount } : {}),
        order: manifest.order ?? DEFAULT_PLUGIN_ORDER,
        status: 'error', error: `入口资产不存在: ${manifest.entry}`, revision,
      }
    }
    const rel = manifest.entry.replace(/^\.\//, '')
    return {
      id: manifest.id, name: manifest.name, version: manifest.version,
      entry: `${PLUGIN_SCHEME}://${manifest.id}/${rel}?v=${revision}`,
      capabilities: manifest.capabilities,
      ...(manifest.mount ? { mount: manifest.mount } : {}),
      order: manifest.order ?? DEFAULT_PLUGIN_ORDER,
      status: 'ok', error: null, revision,
    }
  }

  private install(manifest: PluginManifest, dir: string, info: PluginInfo): void {
    const instance = this.factory(this.ctx, manifest, dir, info)
    this.live.set(manifest.id, instance)
    try {
      void instance.ready(this.ctx)
    } catch (err) {
      console.warn(`deck-plugins: ${manifest.id} 装载钩子抛错（已摘除）：${err instanceof Error ? err.message : err}`)
      this.live.delete(manifest.id)
    }
  }

  private disposeAll(): void {
    if (this.stopped) return // ctx.on('dispose') 可能多次触发，实例只卸一次
    this.stopped = true
    for (const id of [...this.live.keys()]) this.unload(id)
  }
}

/** 默认实例：契约即全部——装载时无主进程资源可建，卸载时无资源可放（钩子留作契约位） */
function defaultInstance(_ctx: Context, manifest: PluginManifest, dir: string, info: PluginInfo): PluginInstance {
  return {
    info,
    manifest,
    dir,
    ready() { /* 插件主进程侧资源自此建立；10a 的桌面组件只渲染，无主进程工作 */ },
    dispose() { /* 与 ready 成对释放 */ },
  }
}
