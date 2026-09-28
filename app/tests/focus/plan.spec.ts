/** 会话块直达的纯决策逻辑（工单09 辅缝）：不碰 FFI、不碰 Electron、不依赖真实工具在跑。 */
import { describe, expect, it } from 'vitest'
import { expandEnvVars, normalizeProcessName, planFocus } from '../../src/main/focus/plan'
import type { WindowCandidate } from '../../src/main/focus/plan'
import type { ToolTarget } from '../../src/main/config'

function win(over: Partial<WindowCandidate> = {}): WindowCandidate {
  return { hwnd: 0x1000, pid: 4242, exe: 'ZCode.exe', visible: true, minimized: false, ...over }
}

const ZCODE: ToolTarget = { launch: 'C:\\Program Files\\ZCode\\ZCode.exe', processes: ['zcode'] }

describe('会话块直达决策', () => {
  it('工具在跑且有可见窗口 → 聚焦该窗口（不新开）', () => {
    const plan = planFocus(ZCODE, [win({ hwnd: 0xABCD, pid: 99 })])
    expect(plan).toEqual({ action: 'focus', hwnd: 0xABCD, pid: 99 })
  })

  it('工具未运行 → 启动配置里的 exe', () => {
    const plan = planFocus(ZCODE, [win({ exe: 'chrome.exe' })])
    expect(plan).toEqual({ action: 'launch', exe: 'C:\\Program Files\\ZCode\\ZCode.exe' })
  })

  it('未知工具 → 降级（不给它编一个启动目标）', () => {
    const plan = planFocus(undefined, [win()])
    expect(plan.action).toBe('degrade')
  })

  it('工具未运行且无启动目标 → 降级', () => {
    const plan = planFocus({ launch: '   ', processes: ['ghost'] }, [])
    expect(plan.action).toBe('degrade')
  })

  it('大小写与 .exe 后缀无关（ZCode.exe 命中 zcode）', () => {
    const plan = planFocus(ZCODE, [win({ exe: 'ZCODE.EXE' })])
    expect(plan.action).toBe('focus')
  })

  it('进程名前缀不误命中（zcode-helper 不是 zcode）', () => {
    const plan = planFocus(ZCODE, [win({ exe: 'zcode-helper.exe' })])
    expect(plan).toEqual({ action: 'launch', exe: 'C:\\Program Files\\ZCode\\ZCode.exe' })
  })

  it('同名多窗时取可见未最小化者', () => {
    const plan = planFocus(ZCODE, [
      win({ hwnd: 1, exe: 'ZCode.exe', visible: false }),
      win({ hwnd: 2, exe: 'ZCode.exe', minimized: true }),
      win({ hwnd: 3, exe: 'ZCode.exe' }),
    ])
    expect(plan).toEqual({ action: 'focus', hwnd: 3, pid: 4242 })
  })

  it('只有最小化窗口时仍聚焦（置前时顺带还原）', () => {
    const plan = planFocus(ZCODE, [win({ hwnd: 7, exe: 'ZCode.exe', minimized: true })])
    expect(plan).toEqual({ action: 'focus', hwnd: 7, pid: 4242 })
  })

  it('不可见窗口不参与聚焦（托盘常驻工具走启动路径唤起）', () => {
    const plan = planFocus(ZCODE, [win({ exe: 'ZCode.exe', visible: false })])
    expect(plan.action).toBe('launch')
  })

  it('Electron 多子进程：任一镜像名命中即算该工具在跑', () => {
    const qoder: ToolTarget = { launch: '%LOCALAPPDATA%\\Qoder CN\\Qoder CN Launcher.exe', processes: ['qoder cn launcher', 'qoder cn'] }
    const plan = planFocus(qoder, [win({ exe: 'Qoder CN.exe' })])
    expect(plan.action).toBe('focus')
  })

  it('原型链键名（toString/constructor/…）按未知工具降级，不抛异常', () => {
    // 真实查表：tools['toString'] 会命中 Object.prototype 的成员（函数，truthy）
    const tools = { zcode: ZCODE } as Record<string, unknown>
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const plan = planFocus(tools[key], [])
      expect(plan.action, `${key} 应当降级`).toBe('degrade')
    }
  })

  it('形状不合法的映射（processes 非数组等）按未知工具降级', () => {
    expect(planFocus({ launch: 'C:\\x.exe' }, []).action).toBe('degrade')
    expect(planFocus({ launch: 42, processes: ['x'] }, []).action).toBe('degrade')
    expect(planFocus({ launch: 'C:\\x.exe', processes: [1, 2] }, []).action).toBe('degrade')
    expect(planFocus(null, []).action).toBe('degrade')
  })

  it('渲染层发来的路径型工具名无从生效：查表未命中即降级，绝不执行该路径', () => {
    // 会话块点击只发工具名；即便载荷是绝对路径，config.tools 里没有同名条目就不会被启动
    const tools = { zcode: ZCODE } as Record<string, unknown>
    const evil = 'C:\\Windows\\System32\\cmd.exe'
    expect(planFocus(tools[evil], []).action).toBe('degrade')
    expect(planFocus(tools['../../evil.exe'], []).action).toBe('degrade')
  })
})

describe('进程名归一与环境变量展开', () => {
  it('normalizeProcessName 取 basename、转小写、去 .exe', () => {
    expect(normalizeProcessName('C:\\Program Files\\ZCode\\ZCode.exe')).toBe('zcode')
    expect(normalizeProcessName('D:\\programs\\Kimi Code\\Kimi Code.EXE')).toBe('kimi code')
  })

  it('expandEnvVars 展开已定义变量，未知变量原样保留', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\HUAWEI\\AppData\\Local' }
    expect(expandEnvVars('%LOCALAPPDATA%\\Qoder CN\\q.exe', env)).toBe('C:\\Users\\HUAWEI\\AppData\\Local\\Qoder CN\\q.exe')
    expect(expandEnvVars('%NOPE%\\x.exe', env)).toBe('%NOPE%\\x.exe')
    expect(expandEnvVars('D:\\plain\\path.exe', env)).toBe('D:\\plain\\path.exe')
  })
})
