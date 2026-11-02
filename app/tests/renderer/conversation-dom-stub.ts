/**
 * 对话窗页面的**最小 DOM 桩**（工单364）。
 *
 * 为什么自带桩而不上 jsdom：本仓库没装 jsdom/happy-dom（package.json 里没有，也不为
 * 一条测试加依赖）——与 tests/renderer/taskbar-dom-stub.ts 同款理由。
 *
 * 这份桩只实现 app/src/renderer/conversation.ts 真正用到的那几个面：getElementById /
 * createElement / textContent / innerHTML / appendChild / append / classList / style /
 * value / checked / disabled / addEventListener / dispatch / scrollTop。
 *
 * dispatch 语义同 DOM 的 dispatchEvent（即便元素被禁用也照派发）；真实浏览器里
 * 「用户点被禁用的按钮」由浏览器自己挡掉——页面**静态初始态**禁用正是靠这条兜底
 * （页面脚本没跑起来时也不会留一个能点却无反应的按钮）。
 */
export interface StubEvent {
  type: string
  target: StubElement
  key: string
  shiftKey: boolean
  defaultPrevented: boolean
  preventDefault(): void
}

export type StubListener = (ev: StubEvent) => void

export class StubElement {
  parent: StubElement | null = null
  children: StubElement[] = []
  style: Record<string, string> = {}
  className = ''
  id = ''
  title = ''
  tagName: string
  value = ''
  checked = false
  disabled = false
  scrollTop = 0
  scrollHeight = 0
  innerHTML = ''
  private text = ''
  private listeners = new Map<string, StubListener[]>()

  constructor(tagName = 'div') {
    this.tagName = tagName
  }

  get textContent(): string {
    return this.text
  }

  set textContent(v: string) {
    this.text = v
    this.children = [] // 真 DOM：写 textContent 即清子节点
  }

  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean)
    const self = this
    return {
      contains: (c: string) => list().includes(c),
      add: (...cs: string[]) => {
        const now = list()
        for (const c of cs) if (!now.includes(c)) now.push(c)
        self.className = now.join(' ')
      },
      remove: (...cs: string[]) => {
        self.className = list().filter((c) => !cs.includes(c)).join(' ')
      },
      toggle: (c: string, force?: boolean) => {
        const has = list().includes(c)
        const want = force === undefined ? !has : !!force
        if (want !== has) {
          if (want) self.classList.add(c)
          else self.classList.remove(c)
        }
        return want
      },
    }
  }

  appendChild(node: StubElement): StubElement {
    node.parent = this
    this.children.push(node)
    return node
  }

  append(...nodes: StubElement[]): void {
    for (const n of nodes) this.appendChild(n)
  }

  addEventListener(type: string, fn: StubListener): void {
    const set = this.listeners.get(type) ?? []
    set.push(fn)
    this.listeners.set(type, set)
  }

  /** 派发事件（dispatchEvent 语义：沿 parent 链上溯，禁不禁用都照派） */
  dispatch(type: string, init: Partial<StubEvent> = {}): StubEvent {
    const ev: StubEvent = {
      type,
      target: this,
      key: '',
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() { ev.defaultPrevented = true },
      ...init,
    }
    let n: StubElement | null = this
    while (n) {
      for (const fn of [...(n.listeners.get(type) ?? [])]) fn(ev)
      n = n.parent
    }
    return ev
  }
}

/** 元素及其后代的可见文本（转写内容按此断言——用户看到的就是它） */
export function textOf(el: StubElement): string {
  const own = el.textContent
  const kids = el.children.map((c) => textOf(c)).join('\n')
  return [own, kids].filter(Boolean).join('\n')
}

/** 页面里存在的宿主元素（id 与 conversation.html 一致） */
export const CONVERSATION_HOST_IDS = [
  'transcript',
  'session-select',
  'prompt-input',
  'status-line',
  'btn-new',
  'btn-send',
  'btn-cancel',
  'btn-end',
  'chk-managed',
  'managed-toggle',
  'btn-fresh-dir',
  'install-bar',
  'grant-bar',
  'cred-bar',
  'init-error',
] as const

export interface ConversationDomStub {
  element(id: string): StubElement
  /** 桥接调用流水（方法名 → 载荷）——「没有发起 conversation/prompt」这类断言用 */
  calls(method: string): unknown[]
  /** 派发桥接事件（conversation/changed 等） */
  emit(event: string, payload: unknown): void
  cleanup(): void
}

export interface BridgeStubOptions {
  /** 桥接实现（真实 BridgeService 或测试桩）；缺省 = 全部方法回空形状 */
  invoke?: (method: string, payload: unknown) => Promise<unknown>
  /** 是否装配 window.deck（false = 模拟 preload 未装配） */
  withDeck?: boolean
}

/**
 * 装一份对话窗 DOM 桩到全局（供渲染层 import 时取用）。
 *
 * @param options.invoke 桥接实现；返回的 promise 形态与 preload 一致（失败即 reject）
 * @param options.withDeck false = 页面里根本没有 window.deck（preload 未装配的现场）
 */
export function installConversationDomStub(options: BridgeStubOptions = {}): ConversationDomStub {
  const elements = new Map<string, StubElement>()
  for (const id of CONVERSATION_HOST_IDS) {
    const el = new StubElement(id === 'prompt-input' ? 'textarea' : id === 'session-select' ? 'select' : 'div')
    el.id = id
    elements.set(id, el)
  }
  elements.get('session-select')!.tagName = 'select'
  elements.get('prompt-input')!.tagName = 'textarea'
  elements.get('btn-send')!.tagName = 'button'
  elements.get('btn-cancel')!.tagName = 'button'
  elements.get('btn-end')!.tagName = 'button'
  elements.get('btn-new')!.tagName = 'button'
  elements.get('btn-fresh-dir')!.tagName = 'button'
  elements.get('chk-managed')!.tagName = 'input'

  const calls = new Map<string, unknown[]>()
  const listeners = new Map<string, Array<(payload: unknown) => void>>()

  const doc = {
    body: new StubElement('body'),
    createElement: (tag: string) => new StubElement(tag),
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: () => { /* 页面级监听不参与本桩断言 */ },
  }

  const bridge = {
    invoke: async (method: string, payload: unknown): Promise<unknown> => {
      calls.set(method, [...(calls.get(method) ?? []), payload])
      if (options.invoke) {
        // 返回 undefined = 交回默认空形状（与本票无关的方法不另造实现）
        const result = await options.invoke(method, payload)
        if (result !== undefined) return result
      }
      return emptyBridgeShape(method)
    },
    on: (event: string, listener: (payload: unknown) => void) => {
      const arr = listeners.get(event) ?? []
      arr.push(listener)
      listeners.set(event, arr)
      return () => { /* 退订不实现——桩内无退订场景 */ }
    },
  }

  const win: Record<string, unknown> = {}
  if (options.withDeck !== false) win.deck = { bridge }

  const g = globalThis as unknown as Record<string, unknown>
  const saved = { document: g.document, window: g.window }
  g.document = doc
  g.window = win

  return {
    element: (id: string) => {
      const el = elements.get(id)
      if (!el) throw new Error(`桩里没有宿主元素：${id}`)
      return el
    },
    calls: (method: string) => (calls.get(method) ?? []).slice(),
    emit: (event: string, payload: unknown) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload)
    },
    cleanup: () => {
      g.document = saved.document
      g.window = saved.window
    },
  }
}

/** 与本票无关的桥接方法回空形状（避免桩里另造插件/凭证服务） */
function emptyBridgeShape(method: string): unknown {
  switch (method) {
    case 'install/list':
      return { proposals: [] }
    case 'install/grants':
      return { grants: [], buckets: [], networkBuckets: [] }
    case 'credentials/list':
      return { credentials: [] }
    default:
      return {}
  }
}
