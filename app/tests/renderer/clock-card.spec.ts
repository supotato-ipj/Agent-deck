/**
 * 时钟呈现去秒（工单477 束③）+ 会话卡重建守卫的渲染层接缝测试。
 * DOM 桩最小近似（仓库不装 jsdom——taskbar-dom-stub 同款理由）：这里证明的不是
 * 「DOM 怎么工作」，而是**呈现接线**——时钟卡文本只显时分、同分钟重复推送不再写
 * DOM（无每秒重绘）、分钟沿才更新；会话卡数据未变不重建行（元素身份延续）、变了才重建。
 * 卡片模块只在 mount/update 内触 DOM：stubGlobal(document) 后直挂即可。
 */
import { describe, expect, it, vi } from 'vitest'
import { hhmmOf } from '../../src/renderer/clock-text'
import clockCard from '../../src/renderer/cards/clock/card'
import sessionsCard from '../../src/renderer/cards/sessions/card'

// —— 最小 DOM 桩：文本写入计数（守卫的外部账）+ 子元素身份 ——

class StubEl {
  children: StubEl[] = []
  parent: StubEl | null = null
  className = ''
  id = ''
  title = ''
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  listeners = new Map<string, Array<() => void>>()
  tag: string
  #text = ''
  writes = 0
  constructor(tag = 'div') {
    this.tag = tag
  }
  get textContent(): string { return this.#text }
  set textContent(v: string) {
    this.#text = v
    this.writes += 1
    if (v === '') this.children = [] // 清空子树语义
  }
  set innerHTML(html: string) {
    // 只解析本仓卡片用的形态：<tag id="x">TEXT</tag>（span/div；不含更深嵌套）
    for (const m of html.matchAll(/<(\w+) id="([^"]+)">(.*?)<\/\1>/g)) {
      const child = new StubEl(m[1])
      child.id = m[2]
      child.textContent = m[3]
      child.parent = this
      this.children.push(child)
    }
  }
  get innerHTML(): string { return '' }
  appendChild(c: StubEl): StubEl {
    c.parent = this
    this.children.push(c)
    return c
  }
  querySelector(sel: string): StubEl | null {
    const id = sel.startsWith('#') ? sel.slice(1) : null
    if (id === null) return null
    const walk = (el: StubEl): StubEl | null => {
      for (const c of el.children) {
        if (c.id === id) return c
        const deep = walk(c)
        if (deep) return deep
      }
      return null
    }
    return walk(this)
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 0, height: 0 }
  }
  addEventListener(type: string, fn: () => void): void {
    const l = this.listeners.get(type) ?? []
    l.push(fn)
    this.listeners.set(type, l)
  }
}

/** 挂载前给全局 document 桩（卡片走 document.createElement） */
function stubDocument(): void {
  vi.stubGlobal('document', { createElement: (tag: string) => new StubEl(tag) })
}

/** 假插件宿主：视图切片 + util（与 plugins.ts 宿主面同形的最小近似） */
function fakeHost(view: { clock?: { iso: string; epochMs: number }; sessions?: Array<Record<string, unknown>> }) {
  const el = new StubEl('div')
  return {
    host: {
      el,
      view,
      util: {
        pad: (v: number) => String(v).padStart(2, '0'),
        pad3: (v: string | number) => String(v).padStart(3, '0'),
        esc: (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;'),
      },
      notify: () => {},
      invoke: () => Promise.resolve({ ok: true }),
    },
    el,
  }
}

describe('hhmmOf（时钟呈现去秒，工单477 束③）', () => {
  it('只显时分：秒位不进文本', () => {
    expect(hhmmOf(new Date(2026, 10, 14, 7, 5, 9).getTime())).toBe('07:05')
    expect(hhmmOf(new Date(2026, 10, 14, 23, 59, 59).getTime())).toBe('23:59')
  })
})

describe('时钟卡（去秒 + 同分钟重复推送不再写 DOM）', () => {
  it('同分钟两次 update：文本仍是上一分钟的（无秒），时间元素写入数不增长（无每秒重绘）', () => {
    stubDocument()
    const base = new Date(2026, 10, 14, 10, 0, 30).getTime() // 10:00:30
    const { host, el } = fakeHost({ clock: { iso: new Date(base).toISOString(), epochMs: base } })
    clockCard.mount(host as never)
    const time = el.querySelector('#clock-time') as StubEl
    expect(time.textContent).toBe('10:00')
    const writesAtMount = time.writes
    // +1s 推送（同分钟）：秒已去——不得再写 DOM
    const t2 = base + 1000
    clockCard.update?.({ ...host, view: { clock: { iso: new Date(t2).toISOString(), epochMs: t2 } } } as never)
    expect(time.textContent).toBe('10:00')
    expect(time.writes).toBe(writesAtMount)
    // 分钟沿：文本更新一次（恰好一次写）
    const t3 = base + 60_000
    clockCard.update?.({ ...host, view: { clock: { iso: new Date(t3).toISOString(), epochMs: t3 } } } as never)
    expect(time.textContent).toBe('10:01')
    expect(time.writes).toBe(writesAtMount + 1)
  })
})

describe('会话卡（数据未变不重建行）', () => {
  const rows = [
    { tool: 'zcode', id: 's1', project: 'delta', state: 'RUN', running: true, age: 30, tasks_done: 1, tasks_total: 3 },
  ]

  it('同数据两次 update：行元素身份延续（不重建 DOM）；数据变化后重建', () => {
    stubDocument()
    const { host, el } = fakeHost({ sessions: rows })
    sessionsCard.mount(host as never)
    const rowsEl = el.querySelector('#session-rows') as StubEl
    expect(rowsEl.children.length).toBe(1)
    const first = rowsEl.children[0]
    sessionsCard.update?.({ ...host, view: { sessions: rows } } as never)
    expect(rowsEl.children[0]).toBe(first) // 身份延续 = 未重建
    const changed = [{ ...rows[0], state: 'DONE' }]
    sessionsCard.update?.({ ...host, view: { sessions: changed } } as never)
    expect(rowsEl.children.length).toBe(1)
    expect(rowsEl.children[0]).not.toBe(first) // 数据变了才重建
  })
})
