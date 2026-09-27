import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { SettingsState } from '../../shared/contract'
import { defaultAppearance, saveConfig } from '../config'
import type { AppConfig } from '../config'
import { BridgeError } from './bridge'

export interface SettingsServiceOptions {
  /** config.json 绝对路径（缺省 = 不落盘，仅内存态——离线测试省配置桩） */
  file?: string
  /** 已加载的 config（可变引用：写透明度即整份回写该对象） */
  config?: AppConfig
}

/**
 * 设置服务（工单08）：面板内设置浮层的数据面。透明度全局滑杆经内核契约
 * settings/set-card-opacity 到这里——clamp 0..1、整份回写 config.json（重启保持）、
 * settings/changed 即时回推（渲染层不等 1Hz 快照）。渲染层只管画：input 即时改
 * CSS 变量、invoke 落内核；文字实色不变是渲染层只动底色 alpha 的结构性结果。
 */
export class SettingsService extends Service {
  private readonly file: string | null
  private readonly appConfig: AppConfig | null
  private current: SettingsState

  constructor(ctx: Context, options: SettingsServiceOptions = {}) {
    super(ctx, 'settings')
    this.file = options.file ?? null
    this.appConfig = options.config ?? null
    this.current = { cardOpacity: options.config?.appearance?.cardOpacity ?? defaultAppearance().cardOpacity }
  }

  state(): SettingsState {
    return { ...this.current }
  }

  /** 设置透明度：clamp 到 0..1（非有限数字属契约违规，拒绝而非吞掉）、落盘、回推事件。
   * 先写盘后提交内存态（写失败即抛）：内存、config 对象引用与磁盘三者一致。 */
  setCardOpacity(opacity: number): SettingsState {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
      throw new BridgeError(`cardOpacity 须为有限数字，收到 ${String(opacity)}`)
    }
    const cardOpacity = Math.min(1, Math.max(0, opacity))
    if (cardOpacity === this.current.cardOpacity) return { ...this.current }
    if (this.appConfig && this.file) {
      saveConfig(this.file, { ...this.appConfig, appearance: { ...this.appConfig.appearance, cardOpacity } })
      this.appConfig.appearance = { cardOpacity }
    }
    this.current = { cardOpacity }
    this.ctx.emit('settings/changed', { ...this.current })
    return { ...this.current }
  }
}
