// 档位循环 × 唤出态的 DOM 归零（工单249）：渲染**接线层**的回归。
//
// 接缝 = app/src/renderer/taskbar.ts 这个渲染入口本身（不是纯逻辑缝）：主进程下发档位
// （taskbar/bar-mode）→ 唤出态归零 → 唤出条几何存证帧。离线可测的前提是给渲染入口配
// 一份最小 DOM 桩（tests/renderer/taskbar-dom-stub.ts，与 plugins/doc-group-cards 的
// DOM 桩同款理由：仓库不装 jsdom/happy-dom）。
//
// F1（阻断合并的缺陷）：.summon-popped 类在「收栏 → 唤出某组 → 常驻 → 再收栏」循环后
// 残留 ⇒ 未唤出的组在收栏态**整组可见**、却**不在热区集内**（看得见、点不着）。
// F2：唤出条几何存证帧（taskbar-summon-strips）在档位循环后被去重吞掉 ⇒ 验收侧
// 「等收栏后的新帧」会超时。
//
// 本文件的用例打的是**真接线**：真渲染入口、真档位事件、真 DOM 类——不是照抄一份逻辑。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { installTaskbarDomStub } from './taskbar-dom-stub'
import type { TaskbarDomStub } from './taskbar-dom-stub'
import type { TaskbarState } from '../../src/shared/contract'

/** 面板启动态：一个手钉应用（应用组在场 ⇒ 该组有唤出条）+ 无推荐位 + 无托盘 */
const STATE: TaskbarState = {
  enabled: true,
  hiddenButtons: [],
  recommendations: [],
  excluded: [],
  metrics: [],
  apps: [{ exe: 'C:\\Apps\\Alpha.exe', label: 'Alpha', pinned: true, running: false, title: null, iconKey: null }],
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
function setBarMode(stub: TaskbarDomStub, mode: 'visible' | 'maximize-retract'): void {
  stub.emit('taskbar/bar-mode', { mode, reason: 'test' })
}

/** 最近一次热区声明里的命中区 id（收栏态 = 唤出条命中区 + 已唤出 pill 的命中区） */
function pillZoneIds(stub: TaskbarDomStub): string[] {
  const zones = stub.hotZones().at(-1) as Array<{ id: string }>
  return zones.map((z) => z.id)
}

describe('档位循环 × 唤出态（工单249 渲染接线层）', () => {
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

  it('F1：收栏 → 唤出某组 → 常驻 → 再收栏，未唤出的组不得在收栏态残留', async () => {
    stub = await bootTaskbar()

    // ① 进收栏态：栏面退场，各组唤出条待命
    setBarMode(stub, 'maximize-retract')
    expect(stub.element('pill-apps').classList.contains('summon-popped')).toBe(false)

    // ② 唤出「应用组」：点条即弹（不吃 150ms 悬停延迟）——该组 pill 带 .summon-popped 复现
    const strip = stub.stripFor('apps')
    expect(strip).not.toBeNull()
    strip!.dispatch('click')
    expect(stub.element('pill-apps').classList.contains('summon-popped')).toBe(true)

    // ③ 切常驻：唤出态归零（该组不再弹出）
    setBarMode(stub, 'visible')

    // ④ 再收栏：收栏态栏面上**不得有未唤出的组残留**
    setBarMode(stub, 'maximize-retract')
    expect(stub.element('pill-apps').classList.contains('summon-popped')).toBe(false)
  })

  it('F1 附：看得见就得点得着——带 .summon-popped 的组必须有对应的 pill 命中区', async () => {
    stub = await bootTaskbar()
    setBarMode(stub, 'maximize-retract')
    stub.stripFor('apps')!.dispatch('click')

    // 正对照：刚唤出时，组可见 ⇔ 该组有 pill 命中区（条退场、pill 顶上）
    expect(stub.element('pill-apps').classList.contains('summon-popped')).toBe(true)
    expect(pillZoneIds(stub)).toContain('summon:pill:apps')

    // 档位循环之后：不得出现「看得见、点不着」（残态可见但不在热区集内）
    setBarMode(stub, 'visible')
    setBarMode(stub, 'maximize-retract')
    const shown = stub.element('pill-apps').classList.contains('summon-popped')
    const hasZone = pillZoneIds(stub).includes('summon:pill:apps')
    expect(shown && !hasZone).toBe(false)
  })

  it('F2：唤出条几何存证帧——第二次进收栏态要再发一帧（等帧不得超时）', async () => {
    stub = await bootTaskbar()
    expect(stub.notifyCount('taskbar-summon-strips')).toBe(0)

    setBarMode(stub, 'maximize-retract')
    expect(stub.notifyCount('taskbar-summon-strips')).toBe(1)

    setBarMode(stub, 'visible')
    setBarMode(stub, 'maximize-retract')
    expect(stub.notifyCount('taskbar-summon-strips')).toBe(2)
  })

  it('F2 附：几何未变（栏布局没动）也照样再发一帧——档位切换不该被去重吞掉', async () => {
    stub = await bootTaskbar()
    setBarMode(stub, 'maximize-retract')
    const first = stub.notifyCalls('taskbar-summon-strips').at(-1)

    setBarMode(stub, 'visible')
    setBarMode(stub, 'maximize-retract')
    const second = stub.notifyCalls('taskbar-summon-strips').at(-1)

    // 两帧几何相同（栏布局没动），但**帧确实再发了一记**
    expect(second).toEqual(first)
    expect(stub.notifyCount('taskbar-summon-strips')).toBe(2)
  })
})
