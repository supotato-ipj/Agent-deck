import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { PluginConfigState } from '../../shared/contract'
import { readStoreText, writeStoreText } from '../desktop/adapter'
import { userDataPath } from '../paths'
import {
  PLUGIN_CONFIG_MAX_BYTES,
  loadPluginConfig,
  mergePluginConfig,
  serializePluginConfig,
  validPluginConfigId,
} from '../plugins/config-store'
import { BridgeError } from './bridge'

export interface PluginConfigDeps {
  /** 存储读取真源（缺省 desktop/adapter 的 fs 真源——测试可注入内存假源） */
  readStoreText?: (file: string) => string | null
  /** 存储写入真源（缺省 desktop/adapter 的 tmp+rename 原子写单一出处） */
  writeStoreText?: (file: string, text: string) => void
}

export interface PluginConfigServiceOptions {
  /** 命名空间存储目录（缺省 userData/plugin-config——每个插件 id 一个 <id>.json） */
  dir?: string
  deps?: PluginConfigDeps
}

/**
 * 插件私有状态存储（工单178，ADR-0014 决策 (c)）：一对桥接方法 `plugin-config/get|set`
 * 背后的主进程实现，按插件 id 命名空间落 userData 下每 id 一个文件。
 *
 * **命名空间隔离是约定式、不是强制式**——与 ADR-0014 Consequences 记载一致，代码不与文档
 * 有出入：`invoke` 是全表透传的单一 handler（panel-ipc 的 ipcMain.handle），主进程无从分辨
 * 调用方，`id` 由调用方自证。任何插件都能自证别人的 id 去读写别人的命名空间，这里没有
 * 任何机制拦它。本服务只做两件有强制力的事：id 形态收口（防路径穿越出目录）与体积上限；
 * 「只能写自己那一份」写成契约的固有约束，落地靠自律（ADR-0014 同 ADR-0010：控制面在代码
 * 里尚不存在）。
 *
 * 持久化强度沿用项目既有惯例：逐键校验、坏值逐键回退记 warning（不整体失败）、坏 JSON
 * 视同空对象（损坏自愈，下次保存覆写）、tmp+rename 原子写、超限拒收如实回报不静默截断。
 *
 * 只在主进程执行；数据面（utilityProcess 子进程）与渲染层都不碰这块盘。
 */
export class PluginConfigService extends Service {
  private readonly dir: string
  private readonly read: (file: string) => string | null
  private readonly write: (file: string, text: string) => void

  constructor(ctx: Context, options: PluginConfigServiceOptions = {}) {
    super(ctx, 'pluginConfig')
    this.dir = options.dir ?? userDataPath('plugin-config')
    this.read = options.deps?.readStoreText ?? readStoreText
    this.write = options.deps?.writeStoreText ?? writeStoreText
  }

  /** 读取：该 id 名下整份状态。从未写过 = 空对象；坏 JSON 视同空对象并记 warning。 */
  get(id: unknown): PluginConfigState {
    const file = this.fileOf(id)
    const { config, warnings } = loadPluginConfig(this.read(file))
    this.logWarnings(warnings)
    return { config, warnings }
  }

  /**
   * 写入：patch 逐键合并到既有状态后整份落盘。
   *
   * 坏值逐键回退（保留既有值）并记 warning，其余键照常写——不整体失败。
   * 合并后的整份体积超限则拒收并抛 BridgeError：此时**一个字节都不写**（不静默截断、
   * 不留半份），调用方拿到的就是一次明确的拒绝。
   * 写为 tmp+rename 原子替换：中途失败原文件不动。
   */
  set(id: unknown, patch: unknown): PluginConfigState {
    const file = this.fileOf(id)
    const base = loadPluginConfig(this.read(file))
    const { config, warnings } = mergePluginConfig(base.config, patch)
    this.logWarnings([...base.warnings, ...warnings])
    const text = serializePluginConfig(config)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > PLUGIN_CONFIG_MAX_BYTES) {
      throw new BridgeError(
        `plugin-config 载荷超限（${bytes} 字节 > 上限 ${PLUGIN_CONFIG_MAX_BYTES} 字节），已拒收、未落盘`,
      )
    }
    this.write(file, text)
    return { config, warnings: [...base.warnings, ...warnings] }
  }

  /** id 形态收口 + 命名空间文件路径。防的是寻址安全（路径穿越），不是命名空间隔离。 */
  private fileOf(id: unknown): string {
    if (!validPluginConfigId(id)) {
      throw new BridgeError(`plugin-config 插件 id 非法（非小写主机名字符集）: ${String(id)}`)
    }
    return `${this.dir}/${id}.json`
  }

  /** 自愈记录如实记 warning（内核侧只有日志这一条出口，任务栏布局迁移同款） */
  private logWarnings(warnings: string[]): void {
    for (const w of warnings) console.warn(`deck-plugin-config: ${w}`)
  }
}
