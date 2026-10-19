import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { SettingsState } from '../../shared/contract'
import { defaultAppearance, saveConfig } from '../config'
import type { AppConfig } from '../config'
import { BridgeError } from './bridge'

export interface SettingsServiceOptions {
  /** config.json 绝对路径（缺省 = 不落盘，仅内存态——离线测试省配置桩） */
  file?: string
  /** 已加载的 config（可变引用：写透明度/停用集即整份回写该对象） */
  config?: AppConfig
}

/**
 * 设置服务（工单08，工单101 扩卡片显隐）：面板内设置浮层的数据面。
 * 透明度全局滑杆经内核契约 settings/set-card-opacity 到这里——clamp 0..1、整份回写
 * config.json（重启保持）、settings/changed 即时回推（渲染层不等 1Hz 快照）。
 * 渲染层只管画：input 即时改 CSS 变量、invoke 落内核；文字实色不变是渲染层只动底色
 * alpha 的结构性结果。
 *
 * 卡片显隐（工单101）：settings/set-card-enabled 增删 config.plugins.disabled 停用集，
 * 同款「校验 → 先写盘后提交 → emit changed」纪律；另发 settings/cards-changed 供插件
 * 宿主重扫清单（停用包从快照 plugins 段剔除，渲染层随之卸载、热区随之消失）。
 */
export class SettingsService extends Service {
  private readonly file: string | null
  private readonly appConfig: AppConfig | null
  private current: SettingsState

  constructor(ctx: Context, options: SettingsServiceOptions = {}) {
    super(ctx, 'settings')
    this.file = options.file ?? null
    this.appConfig = options.config ?? null
    this.current = {
      cardOpacity: options.config?.appearance?.cardOpacity ?? defaultAppearance().cardOpacity,
      disabledCards: [...(options.config?.plugins?.disabled ?? [])],
    }
  }

  state(): SettingsState {
    return { ...this.current, disabledCards: [...this.current.disabledCards] }
  }

  /** 设置透明度：clamp 到 0..1（非有限数字属契约违规，拒绝而非吞掉）、落盘、回推事件。
   * 先写盘后提交内存态（写失败即抛）：内存、config 对象引用与磁盘三者一致。 */
  setCardOpacity(opacity: number): SettingsState {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
      throw new BridgeError(`cardOpacity 须为有限数字，收到 ${String(opacity)}`)
    }
    const cardOpacity = Math.min(1, Math.max(0, opacity))
    if (cardOpacity === this.current.cardOpacity) return this.state()
    if (this.appConfig && this.file) {
      saveConfig(this.file, { ...this.appConfig, appearance: { ...this.appConfig.appearance, cardOpacity } })
      this.appConfig.appearance = { cardOpacity }
    }
    this.current = { ...this.current, cardOpacity }
    this.ctx.emit('settings/changed', this.state())
    return this.state()
  }

  /**
   * 卡片显隐开关（工单101）：enabled=false 把 id 加进停用集、true 移出。
   * 同态幂等空转（不落盘不推事件）；先写盘后提交（config.plugins 引用与内存态同步更新，
   * 写失败即抛且两边都不动）；随后 settings/changed（渲染层对齐开关列表）与
   * settings/cards-changed（插件宿主重扫清单）双回推。
   * 未知 id 不拒：停用集只按 id 过滤清单，包未在场时条目静默待命（目录回来仍保持停用）。
   */
  setCardEnabled(id: string, enabled: boolean): SettingsState {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new BridgeError(`插件包 id 须为非空字符串，收到 ${String(id)}`)
    }
    if (typeof enabled !== 'boolean') {
      throw new BridgeError(`enabled 须为布尔值，收到 ${String(enabled)}`)
    }
    const target = id.trim()
    const prev = this.current.disabledCards
    const next = enabled
      ? prev.filter((v) => v !== target)
      : prev.includes(target) ? prev : [...prev, target]
    if (next.length === prev.length && next.every((v, i) => v === prev[i])) return this.state()
    if (this.appConfig && this.file) {
      saveConfig(this.file, { ...this.appConfig, plugins: { ...this.appConfig.plugins, disabled: [...next] } })
      this.appConfig.plugins = { ...this.appConfig.plugins, disabled: [...next] }
    }
    this.current = { ...this.current, disabledCards: [...next] }
    this.ctx.emit('settings/changed', this.state())
    this.ctx.emit('settings/cards-changed', { disabled: [...next] })
    return this.state()
  }
}
