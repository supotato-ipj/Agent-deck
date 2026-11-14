// 启动序列编排（工单481，ADR-0032 骨架屏形态）：纯函数域的离线家族。
// 票面验收标准「单测：启动序列编排（先后序与上界）纯函数」的实现位。
// 断言全部走外部行为：计划给出的步序、相位族覆盖、每一步的阻塞语义与外部等待
// 显式上界——不钉实现内部结构（工单纪律：单测不碰内部实现）。
//
// 修序依据（#478 诊断轮实锤）：
//   ④ 自启项维护同步 spawnSync PowerShell（热态 1.2~2.7s、上界 20s）→ autostart-apply
//     必须是「发起不等待」的后补步且带显式上界；
//   ③ `await desktopWorkspace.start()` 无上界 → workspace-start 后补步必须带显式上界；
//   ② 装配等待以 KERNEL_START_BOUND_MS 显式上界竞速（cordis 3.x 服务实体在 start 完成
//     前恒 undefined、骨架窗控制器强依赖服务实体——装配全后补化不可行，实证见
//     planBootSequence 头注；真正拖慢开机的首拍/工作区/自启项三段全部后补化）。
import { describe, expect, it } from 'vitest'
import {
  AUTOSTART_HELPER_BOUND_MS,
  KERNEL_START_BOUND_MS,
  PANEL_DATA_BOUND_MS,
  WORKSPACE_START_BOUND_MS,
  boundWait,
  planBootSequence,
  type BootPhaseName,
} from '../src/main/boot-sequence'

/** #473 验收电池 EXPECTED_PHASES 同源契约（accept/battery.js P473 段）——骨架屏
 * 改造后相位族必须继续完整，不得因重排丢相位。 */
const EXPECTED_PHASES: readonly BootPhaseName[] = [
  'config-loaded',
  'autostart-applied',
  'kernel-started',
  'panel-data-ready',
  'window-wired',
  'panel-visible',
]

describe('启动序列编排：主线（骨架先行）', () => {
  const plan = planBootSequence()

  it('主线步序钉死：配置 → 自启项发起 → 内核发起 → 骨架窗接线 → 托盘与钩子 → 骨架首显', () => {
    expect(plan.mainline.map((s) => s.label)).toEqual([
      'config-load',
      'autostart-apply',
      'kernel-start',
      'skeleton-windows',
      'tray-and-hooks',
      'skeleton-reveal',
    ])
  })

  it('自启项维护是「发起不等待」的后补步（#478④ 实锤：同步 PowerShell 不再阻塞主线），且带显式上界', () => {
    const step = plan.mainline.find((s) => s.label === 'autostart-apply')!
    expect(step.blocking).toBe(false)
    expect(step.boundMs).toBe(AUTOSTART_HELPER_BOUND_MS)
    expect(step.boundMs!).toBeGreaterThan(0)
  })

  it('内核装配等待带显式上界（#478②：装配不再无界阻塞——上界竞速，超时干净失败交拉回）', () => {
    const step = plan.mainline.find((s) => s.label === 'kernel-start')!
    expect(step.blocking).toBe(true)
    expect(step.boundMs).toBe(KERNEL_START_BOUND_MS)
    expect(step.timeoutEvent).toBe('kernel-start-timeout')
  })

  it('骨架窗接线与托盘钩子是纯内存步：阻塞但不携带外部等待（首帧不卡外部等待）', () => {
    for (const label of ['skeleton-windows', 'tray-and-hooks']) {
      const step = plan.mainline.find((s) => s.label === label)!
      expect(step.blocking, `${label} 必须阻塞完成才继续`).toBe(true)
      expect(step.boundMs, `${label} 不得阻塞在外部等待上`).toBeNull()
    }
  })

  it('主线不等待数据面首拍（骨架屏语义：首显先于数据）——panel-data 不在主线', () => {
    expect(plan.mainline.some((s) => s.label === 'panel-data')).toBe(false)
  })

  it('相位族覆盖 #473 契约全六相位（骨架屏改造后相位戳继续完整）', () => {
    const phases = [...plan.mainline, ...plan.backfill]
      .map((s) => s.phase)
      .filter((p): p is BootPhaseName => p !== null)
    for (const expected of EXPECTED_PHASES) {
      expect(phases, `缺相位 ${expected}`).toContain(expected)
    }
  })
})

describe('启动序列编排：后补链（全部有界）', () => {
  const plan = planBootSequence()

  it('后补链步序钉死：数据面首拍 → 桌面工作区启动 → Agent 服务族（装配等待已上移主线有界竞速）', () => {
    expect(plan.backfill.map((s) => s.label)).toEqual([
      'panel-data',
      'workspace-start',
      'agent-services',
    ])
  })

  it('后补链一切外部等待带显式上界（票面③：启动链无无界等待）', () => {
    for (const step of plan.backfill) {
      if (step.label === 'agent-services') continue // 纯内存步：无外部等待
      expect(step.boundMs, `后补步 ${step.label} 缺显式上界`).toBeGreaterThan(0)
    }
  })

  it('桌面工作区启动带显式上界（#478③ 实锤：await desktopWorkspace.start() 无界点收口）', () => {
    const step = plan.backfill.find((s) => s.label === 'workspace-start')!
    expect(step.boundMs).toBe(WORKSPACE_START_BOUND_MS)
    expect(step.timeoutEvent).toBe('workspace-start-timeout')
  })

  it('内核装配等待与数据面首拍的上界取自模块常量（数值契约可读）', () => {
    expect(plan.mainline.find((s) => s.label === 'kernel-start')!.boundMs).toBe(KERNEL_START_BOUND_MS)
    expect(plan.backfill.find((s) => s.label === 'panel-data')!.boundMs).toBe(PANEL_DATA_BOUND_MS)
  })

  it('上界常量为正且有限（无界等待的静态反面）', () => {
    for (const bound of [AUTOSTART_HELPER_BOUND_MS, KERNEL_START_BOUND_MS, PANEL_DATA_BOUND_MS, WORKSPACE_START_BOUND_MS]) {
      expect(bound).toBeGreaterThan(0)
      expect(Number.isFinite(bound)).toBe(true)
    }
  })
})

describe('外部等待上界原语 boundWait', () => {
  it('承诺在上界内落定 → settled 且携带值', async () => {
    const outcome = await boundWait(Promise.resolve('ok'), 1000)
    expect(outcome).toEqual({ kind: 'settled', value: 'ok' })
  })

  it('承诺超出上界 → timeout 在上界量级内返回（降级放行，不悬挂）', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 2000))
    const t0 = Date.now()
    const outcome = await boundWait(slow, 30)
    const took = Date.now() - t0
    expect(outcome).toEqual({ kind: 'timeout' })
    expect(took).toBeLessThan(1000)
  })

  it('超时后原承诺才拒绝：不得炸出未处理拒绝（降级路径不崩进程）', async () => {
    const rejections: unknown[] = []
    const handler = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', handler)
    try {
      const doomed = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('late-fail')), 60))
      const outcome = await boundWait(doomed, 10)
      expect(outcome).toEqual({ kind: 'timeout' })
      await new Promise((r) => setTimeout(r, 150))
      expect(rejections, '迟到拒绝必须被上界原语吞掉（不进 unhandledRejection）').toEqual([])
    } finally {
      process.off('unhandledRejection', handler)
    }
  })

  it('上界内拒绝：拒绝原样传播（真失败不冒充超时降级）', async () => {
    const err = new Error('real-failure')
    await expect(boundWait(Promise.reject(err), 1000)).rejects.toBe(err)
  })
})
