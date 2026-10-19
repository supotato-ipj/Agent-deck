/**
 * 任务栏弹窗菜单通路纯函数测试（工单193，tray-plan.spec 同形态）：落位算式与开层裁决
 * 零 Electron——效果层（BrowserWindow 载体）由真机验收覆盖（49/55 电池）。
 * 落位式与托盘溢出浮层（工单162 overflow.ts placeAndShow）同源同式：锚点上方 8px 出层、
 * 水平居中于锚点、工作区四缘内衬 4px 夹取——底部任务栏语境即「向上弹、贴边夹取」。
 */
import { describe, expect, it } from 'vitest'
import { clampPopupBounds, planPopupOpen } from '../../src/main/taskbar/popup-plan'

/** 主屏示意工作区（1920 宽、底部留 64 条带后的 1040 高） */
const WA = { x: 0, y: 0, width: 1920, height: 1040 }

describe('弹窗落位（锚点上方弹出 + 工作区夹取）', () => {
  it('空旷处：水平居中于锚点、整窗悬在锚点上方 8px', () => {
    expect(clampPopupBounds({ x: 960, y: 1000 }, { w: 220, h: 120 }, WA))
      .toEqual({ x: 850, y: 872 })
  })

  it('底部任务栏语境（锚点近工作区底缘）：向上弹出、底缘不越界', () => {
    const p = clampPopupBounds({ x: 500, y: 1038 }, { w: 220, h: 120 }, WA)
    expect(p.y).toBe(1038 - 120 - 8)
    expect(p.y + 120).toBeLessThanOrEqual(WA.y + WA.height)
  })

  it('右缘贴边：水平夹到工作区右缘内衬 4px，纵向仍锚上方', () => {
    const p = clampPopupBounds({ x: 1900, y: 500 }, { w: 220, h: 120 }, WA)
    expect(p.x).toBe(WA.width - 220 - 4)
    expect(p.y).toBe(500 - 120 - 8)
  })

  it('左缘贴边：水平夹到工作区左缘内衬 4px', () => {
    expect(clampPopupBounds({ x: 30, y: 500 }, { w: 220, h: 120 }, WA).x).toBe(4)
  })

  it('顶缘贴边（锚点过高退化语境）：纵向夹到工作区顶缘内衬 4px', () => {
    expect(clampPopupBounds({ x: 960, y: 12 }, { w: 220, h: 120 }, WA).y).toBe(4)
  })

  it('非整锚点/非整窗宽四舍五入（夹取不触发时取整即落位）', () => {
    expect(clampPopupBounds({ x: 1000.6, y: 500.4 }, { w: 200, h: 100 }, WA))
      .toEqual({ x: 901, y: 392 })
  })
})

describe('弹窗开层请求裁决（create/reload/show 三态——通路开层契约）', () => {
  it('无窗首开 → create（建常驻浮层窗 + 载页 + 待 ready 定位弹出）', () => {
    expect(planPopupOpen({ exists: false, url: null }, { url: 'scheme://host/taskbar-menu.html?menu=app&exe=A' })).toBe('create')
  })

  it('窗在场且载页 URL 未变 → show（行集随 changed 常活自渲，即刻重锚定定位）', () => {
    const u = 'scheme://host/taskbar-menu.html?menu=app&exe=A'
    expect(planPopupOpen({ exists: true, url: u }, { url: u })).toBe('show')
  })

  it('窗在场但目标已变（URL 变）→ reload（重载行集再弹出——右键换目标原生语义）', () => {
    expect(planPopupOpen({ exists: true, url: 'scheme://host/taskbar-menu.html?menu=app&exe=A' }, { url: 'scheme://host/taskbar-menu.html?menu=app&exe=B' })).toBe('reload')
  })
})
