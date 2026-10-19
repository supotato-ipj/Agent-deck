// 五菜单浮层宿主工厂（spec188 评审修复收口）：app/rec/blank/tier/wins 五面宿主逐文件
// ~85% 同形（同三方法接口、同 {ctx,log} 装配、同视口帽惰性帽片段、同 open/close/dispose
// 转发），差异只在域参数——收成单参工厂，五文件变五调用点。收口纪律（spec154
// requireNonEmptyId 先例）：事件存证名族与浮层窗 title/query 逐字不变（menu-host.spec
// 锚测试钉住：装配参数与开层 URL 逐字对照）。
// 域参数四样：窗 title（验收按 pid+标题寻窗，各面独立防歧义）、存证事件家族前缀
// （opened/resized/closed/ready/close/open 六名按此派生）、载页 ?menu= 寻址域、开层
// URL 组装（域参数 exe/name/title 的有无与次序是逐字锚，由调用点全权持有）。
import { screen } from 'electron'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { taskbarMenuUrl } from '../plugins/protocol'
import { startPopupMenuCarrier } from './popup'

/** 菜单浮层宿主公共接口（五面同形：条带页转发/显式收层/随行销毁三方法） */
export interface MenuHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/**
 * 菜单浮层宿主工厂：条带页开层请求（<family>-open）→ 调用点 buildUrl 组装 URL（返回
 * 空串 = 空身份是噪声不开层）→ 通用载体（popup.ts：首开建窗 / 换目标重载 / 同目标重
 * 锚定——右键恒重开语义由 open 幂等承载）；收层请求（<family>-close，payload.reason
 * 落存证、缺席落 request）与显式 close/dispose 直转载体。
 */
export function startMenuHost(options: {
  ctx: Context
  log: EventLog | null
  /** 浮层窗标题：验收控制器按 pid + 标题寻窗（各面独立标题，窗常驻防寻窗歧义） */
  title: string
  /** 存证事件家族前缀（如 taskbar-app-menu）：opened/resized/closed/ready/close/open 按此派生 */
  family: string
  /** 载页 ?menu= 寻址域（行集由载页按域适配器自足推导） */
  menu: string
  /** 开层 URL 组装（域参数各异：exe/name/title 有无与次序逐字保持）；空串 = 空身份不开层 */
  buildUrl: (base: string, maxH: number, payload: Record<string, unknown> | undefined) => string
}): MenuHost {
  const carrier = startPopupMenuCarrier({
    ctx: options.ctx,
    log: options.log,
    title: options.title,
    events: {
      opened: `${options.family}-opened`,
      resized: `${options.family}-resized`,
      closed: `${options.family}-closed`,
    },
    readyEvent: `${options.family}-ready`,
    closeEvent: `${options.family}-close`,
    // 渲染层自诊断前缀随家族派生（taskbar-app-menu → app-menu，五面同构逐字等值）
    diagPrefix: options.family.replace(/^taskbar-/, ''),
    bridgeChannels: ['taskbar/changed'],
  })

  // 视口帽随工作区下发（app-menu 先例同式；开层首拍才取工作区——宿主装配拍可能早于
  // app ready，screen 未就绪即取会炸）
  let maxH = 0
  return {
    onStripNotify(type, payload) {
      if (type === `${options.family}-open`) {
        if (!maxH) maxH = Math.max(320, screen.getPrimaryDisplay().workArea.height - 80)
        const url = options.buildUrl(`${taskbarMenuUrl()}?menu=${options.menu}`, maxH, payload)
        if (!url) return // 空身份是噪声：不开层
        carrier.open({ url })
      } else if (type === `${options.family}-close`) {
        carrier.close(String((payload as { reason?: unknown } | undefined)?.reason ?? 'request'))
      }
    },
    close(reason) {
      carrier.close(reason)
    },
    dispose() {
      carrier.dispose()
    },
  }
}
