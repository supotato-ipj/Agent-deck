// 收栏态的组布局（工单253）：挤撞守卫不得按**退场邻组**裁剪已唤出的组。
//
// 缺陷机制（工单243 真机取证）：收栏态栏面退场（各组 pill 全部 display:none）⇒ 挤撞守卫
// 量到的邻组宽度是 **0** ⇒ 已唤出的组被按 0 宽裁剪：开始/推荐组被裁成 18px 的空壳（两枚
// 36px 按钮全被裁掉）、应用组只剩 54px 的「⋯」溢出钮 ⇒ 应用图标与推荐条目**点不到**。
//
// 接缝 = app/src/renderer/taskbar.ts 这个渲染入口本身（真 import）+ 最小 DOM 桩
// （tests/renderer/taskbar-dom-stub.ts）。桩按真 DOM 口径建模 display:none ⇒ 退场组实测
// 矩形全零、max-width 收窄生效——与真浏览器同款，缺陷在桩里原样复现。
//
// 断言面（工单243 想断言而断言不了的那条）：唤出后的组**矩形可点**——组矩形不退化成空壳，
// 且主进程据此命中的热区宽度与组矩形一致。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { installTaskbarDomStub } from './taskbar-dom-stub'
import type { TaskbarDomStub } from './taskbar-dom-stub'
import type { TaskbarState } from '../../src/shared/contract'

/** 面板启动态：三个手钉应用（应用组在场，条目要进得了栏）+ 无推荐位 + 无托盘 */
const STATE: TaskbarState = {
  enabled: true,
  hiddenButtons: [],
  recommendations: [],
  excluded: [],
  metrics: [],
  apps: [
    { exe: 'C:\\Apps\\Alpha.exe', label: 'Alpha', pinned: true, running: false, title: null, iconKey: null },
    { exe: 'C:\\Apps\\Beta.exe', label: 'Beta', pinned: true, running: false, title: null, iconKey: null },
    { exe: 'C:\\Apps\\Gamma.exe', label: 'Gamma', pinned: true, running: false, title: null, iconKey: null },
  ],
  tray: [],
  trayOverflowLimit: 5,
  maximizeRetract: true,
}

/** 拉起渲染入口（真 import —— 副作用真跑），等 taskbar-ready 落地即就绪 */
async function bootTaskbar(): Promise<TaskbarDomStub> {
  const stub = installTaskbarDomStub({ state: STATE })
  vi.resetModules()
  await import('../../src/renderer/taskbar')
  await stub.whenReady()
  return stub
}

/** 下发档位（主进程 taskbar/bar-mode 事件面） */
function setBarMode(stub: TaskbarDomStub, mode: 'visible' | 'maximize-retract' | 'fullscreen-yield'): void {
  stub.emit('taskbar/bar-mode', { mode, reason: 'test' })
}

/** 最近一次热区声明（收栏态 = 唤出条命中区 + 已唤出 pill 的命中区） */
function lastHotZones(stub: TaskbarDomStub): Array<{ id: string; x: number; y: number; w: number; h: number }> {
  return stub.hotZones().at(-1) as Array<{ id: string; x: number; y: number; w: number; h: number }>
}

describe('收栏态的组布局（工单253：挤撞守卫不得按退场邻组裁剪已唤出的组）', () => {
  let stub: TaskbarDomStub | null = null

  beforeEach(() => {
    // 假时钟：渲染入口 boot 里起 25ms 对账拍——桩里不该有它插手（悬停/宽限不参与本组断言）
    vi.useFakeTimers()
  })

  afterEach(() => {
    stub?.cleanup()
    stub = null
    vi.useRealTimers()
  })

  it('唤出的组不被退场邻组裁扁：组矩形保持收栏前的宽度（可点）', async () => {
    stub = await bootTaskbar()
    const before = stub.element('pill-start').getBoundingClientRect()
    expect(before.width).toBeGreaterThan(0)

    // 进收栏态：栏面退场（各组 pill display:none ⇒ 邻组实测宽度 0）
    setBarMode(stub, 'maximize-retract')
    // 唤出开始组（点条即弹）
    stub.stripFor('start')!.dispatch('click')

    const after = stub.element('pill-start').getBoundingClientRect()
    expect(after.width).toBe(before.width)
  })

  it('唤出的组有等宽的命中区（主进程据此 hit-test ⇒ 真的点得到）', async () => {
    stub = await bootTaskbar()
    const before = stub.element('pill-start').getBoundingClientRect()

    setBarMode(stub, 'maximize-retract')
    stub.stripFor('start')!.dispatch('click')

    const zone = lastHotZones(stub).find((z) => z.id === 'summon:pill:start')
    expect(zone).toBeTruthy()
    expect(zone!.w).toBe(before.width)
    expect(zone!.w).toBeGreaterThan(0)
  })

  it('收栏态应用组渲染真实条目（不被空带容量夹取全塞进「⋯」溢出）', async () => {
    stub = await bootTaskbar()
    setBarMode(stub, 'maximize-retract')

    const apps = stub.element('pill-apps')
    expect(apps.querySelectorAll('.tb-app').length).toBe(STATE.apps!.length)
    expect(apps.querySelector('.tb-overflow')).toBeNull()
  })

  it('唤出条与弹出组同源：条的横向区间 = 弹出组的横向区间（位置记忆不打架）', async () => {
    stub = await bootTaskbar()
    setBarMode(stub, 'maximize-retract')
    stub.stripFor('apps')!.dispatch('click')

    const strip = stub.stripFor('apps')!
    const pill = stub.element('pill-apps').getBoundingClientRect()
    expect(strip.style.left).toBe(`${Math.round(pill.x)}px`)
    expect(strip.style.width).toBe(`${Math.round(pill.width)}px`)
  })

  it('全屏让位 → 收栏的接力：让位态量不到矩形，缓存不得被零值覆写（工单253）', async () => {
    stub = await bootTaskbar()
    // 全屏让位（整窗退场 ⇒ 一切元素实测矩形为零）
    setBarMode(stub, 'fullscreen-yield')
    // 再进收栏态：应用组的容量仍取收栏前那一帧（条与组同源）
    setBarMode(stub, 'maximize-retract')

    const apps = stub.element('pill-apps')
    expect(apps.querySelectorAll('.tb-app').length).toBe(STATE.apps!.length)
    expect(apps.querySelector('.tb-overflow')).toBeNull()
  })
})
