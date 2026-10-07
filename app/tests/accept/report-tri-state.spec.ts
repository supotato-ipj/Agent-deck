// 报告状态机三态记账（工单110，spec #109 seam①）：通过/失败/环境降责排除三路计数、
// 排除窗语义、verdict 三态判定（PASS/FAIL-CODE/FAIL-ENV）与退出码映射（0/1/2）、
// --accept-scope 声明与段注册账目。纯模块直测——证据落盘与真机行为归验收电池。
import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES, Report, parseAcceptScope } from '../../accept/lib/report'

/** 纯内存报告（不落证据盘）：file=null 走单测夹具通道 */
const ledger = (name = 't', opts: { scope?: string[] } = {}) => new Report(name, { file: null, scope: opts.scope })

describe('三态记账：三路计数', () => {
  it('给定 pass/fail 事件序列 → 三路计数照实累计', () => {
    const rep = ledger()
    rep.pass('a')
    rep.pass('b')
    rep.fail('c')
    rep.pass('d')
    expect(rep.passes).toBe(3)
    expect(rep.fails).toBe(1)
    expect(rep.excluded).toBe(0)
  })

  it('显式排除（exclude）进排除账，不进失败账；条目附原因与归因', () => {
    const rep = ledger()
    rep.exclude('输入注入被前台覆盖层吞掉', '计算机使用代理覆盖层在场', 'preflight-overlay')
    expect(rep.passes).toBe(0)
    expect(rep.fails).toBe(0)
    expect(rep.excluded).toBe(1)
    expect(rep.exclusions[0]).toMatchObject({
      msg: '输入注入被前台覆盖层吞掉',
      reason: '计算机使用代理覆盖层在场',
      attribution: 'preflight-overlay',
    })
  })
})

describe('三态 verdict 判定与退出码映射', () => {
  it('无失败无排除 → PASS，退出码 0', () => {
    const rep = ledger()
    rep.pass('ok')
    expect(rep.verdict()).toMatchObject({ verdict: 'PASS', exitCode: 0, passes: 1, fails: 0, excluded: 0 })
  })

  it('存在未定责失败 → FAIL-CODE，退出码 1', () => {
    const rep = ledger()
    rep.pass('ok')
    rep.fail('真回归')
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-CODE', exitCode: 1, fails: 1 })
  })

  it('全部失败已定责环境（只有排除账）→ FAIL-ENV，退出码 2', () => {
    const rep = ledger()
    rep.exclude('断言被环境噪声打断', '面板停摆级联', 'panel-stall')
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-ENV', exitCode: 2, fails: 0, excluded: 1 })
  })

  it('未定责失败压过排除：既有 fail 又有 exclude → FAIL-CODE', () => {
    const rep = ledger()
    rep.exclude('停摆窗内断言', '面板停摆', 'panel-stall')
    rep.fail('窗外真失败')
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-CODE', exitCode: 1 })
  })

  it('退出码映射表：PASS=0 / FAIL-CODE=1 / FAIL-ENV=2', () => {
    expect(EXIT_CODES).toEqual({ PASS: 0, 'FAIL-CODE': 1, 'FAIL-ENV': 2 })
  })

  it('verdict 行带三路计数', () => {
    const rep = ledger()
    rep.pass('ok')
    rep.exclude('断言被噪声打断', '面板停摆', 'panel-stall')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      rep.verdict()
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('VERDICT')) ?? ''
      expect(line).toContain('VERDICT: FAIL-ENV')
      expect(line).toContain('pass=1 fail=0 excluded=1')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('排除窗语义：窗内排除/窗外照常', () => {
  it('窗内 fail() 改记环境降责排除，条目继承窗口原因与归因', () => {
    const rep = ledger()
    rep.beginEnvWindow('面板主线程假死（WM_NULL 超时）', 'panel-stall')
    rep.fail('单击选中前置失败：面板主线程假死→已重启面板，本段跳过')
    expect(rep.fails).toBe(0)
    expect(rep.excluded).toBe(1)
    expect(rep.exclusions[0]).toMatchObject({
      msg: '单击选中前置失败：面板主线程假死→已重启面板，本段跳过',
      reason: '面板主线程假死（WM_NULL 超时）',
      attribution: 'panel-stall',
      inWindow: true,
    })
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-ENV', exitCode: 2 })
  })

  it('窗外 fail() 照常记失败', () => {
    const rep = ledger()
    rep.fail('与排除窗无关的真失败')
    expect(rep.fails).toBe(1)
    expect(rep.excluded).toBe(0)
  })

  it('窗闭合后 fail() 恢复记失败（停摆检出→重启健康验证之后照常）', () => {
    const rep = ledger()
    rep.beginEnvWindow('面板主线程假死', 'panel-stall')
    rep.fail('窗内断言')
    rep.endEnvWindow('面板重启后首次落点命中（健康验证通过）')
    rep.fail('新面板上的真失败')
    expect(rep.fails).toBe(1)
    expect(rep.excluded).toBe(1)
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-CODE', exitCode: 1 })
  })

  it('窗已开启时再次开启并入当前窗（不重置、不叠加窗口）', () => {
    const rep = ledger()
    rep.beginEnvWindow('第一次停摆', 'panel-stall')
    const noteSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    rep.beginEnvWindow('第二次停摆', 'panel-stall')
    try {
      expect(rep.exclusions).toHaveLength(0) // 并入当前窗：不因二次开启产生排除条目
    } finally {
      noteSpy.mockRestore()
    }
    rep.fail('窗内断言')
    expect(rep.exclusions[0].reason).toBe('第一次停摆')
  })

  it('endEnvWindow 无窗时 no-op 返回 false', () => {
    const rep = ledger()
    expect(rep.endEnvWindow('多余闭合')).toBe(false)
  })

  it('轮末排除窗仍开启（重启未验证健康）→ envWindowOpen=true，停摆排除在场判 FAIL-ENV', () => {
    const rep = ledger()
    rep.beginEnvWindow('面板主线程假死', 'panel-stall')
    rep.exclude('面板主线程假死（WM_NULL 超时）：已重启面板继续跑', '面板主线程假死', 'panel-stall')
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-ENV', exitCode: 2, envWindowOpen: true })
  })

  it('正常闭合 → verdict 结果 envWindowOpen=false', () => {
    const rep = ledger()
    rep.beginEnvWindow('面板主线程假死', 'panel-stall')
    rep.endEnvWindow('健康验证')
    expect(rep.verdict()).toMatchObject({ envWindowOpen: false })
  })
})

describe('healHungPanel 事件序列仿真（battery.js 接线的可执行规格）', () => {
  /** 序列A：停摆自愈成功——stall 检出开窗+记排除 → 窗内前置失败×2 →
   *  重启后首次落点命中（onPanelHealthy）闭窗 → 后续真失败照常记失败 */
  function healedRun(rep: Report) {
    rep.pass('P2 面板出现')
    rep.pass('P3 dock 渲染')
    // ensurePanelHit 四轮落空 → panelLiveness 报假死 → healHungPanel：
    rep.beginEnvWindow('面板主线程假死（WM_NULL 超时）——重启验证健康前断言不可信', 'panel-stall')
    rep.exclude('面板主线程假死（WM_NULL 超时）：已重启面板继续跑，停摆检出至重启健康验证之间的失败断言记环境降责', '面板主线程假死（WM_NULL 超时）', 'panel-stall')
    rep.fail('单击选中前置失败：面板主线程假死→已重启面板，本段跳过') // 窗内
    rep.fail('双击启动前置失败：面板主线程假死→已重启面板，本段跳过') // 窗内
    rep.endEnvWindow('面板重启后首次落点命中（健康验证通过）')
    rep.fail('拖拽摆位未过（新面板上的真回归）') // 窗外
    rep.pass('恢复出厂')
  }

  it('序列A：停摆排除 3 条 + 窗外真失败 1 条 → FAIL-CODE(1)，三路计数有据', () => {
    const rep = ledger()
    healedRun(rep)
    expect(rep.passes).toBe(3)
    expect(rep.fails).toBe(1)
    expect(rep.excluded).toBe(3)
    expect(rep.exclusions.every((e) => e.attribution === 'panel-stall')).toBe(true)
    // 停摆排除条目自身记在窗开启之后（inWindow=true），两条前置失败同为窗内
    expect(rep.exclusions[0].msg).toContain('面板主线程假死（WM_NULL 超时）：已重启面板')
    expect(rep.exclusions.slice(1).map((e) => e.inWindow)).toEqual([true, true])
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-CODE', exitCode: 1, envWindowOpen: false })
  })

  it('序列A 对照：不接三态时这 3 条全是 fail——排除账把它们从失败账摘出来', () => {
    const plain = ledger('plain')
    plain.pass('P2 面板出现')
    plain.pass('P3 dock 渲染')
    plain.fail('单击选中前置失败：面板主线程假死→已重启面板，本段跳过')
    plain.fail('双击启动前置失败：面板主线程假死→已重启面板，本段跳过')
    expect(plain.fails).toBe(2)
    const wired = ledger('wired')
    healedRun(wired)
    expect(healAccounting(wired)).toEqual({ fails: 1, excluded: 3 })
  })

  /** 序列B：重启失败——窗不闭合，其后的失败断言全数入排除账，verdict FAIL-ENV */
  it('序列B：重启后面板窗口未现 → 窗保持开启，后续失败全数环境降责 → FAIL-ENV(2)', () => {
    const rep = ledger()
    rep.pass('P2 面板出现')
    rep.beginEnvWindow('面板主线程假死（WM_NULL 超时）——重启验证健康前断言不可信', 'panel-stall')
    rep.exclude('面板主线程假死（WM_NULL 超时）：已重启面板继续跑', '面板主线程假死（WM_NULL 超时）', 'panel-stall')
    rep.fail('假死自愈：重启后面板窗口未现，后续段无面板可用') // 窗内
    rep.fail('P4 dock 渲染未过（无面板可用）') // 窗仍开
    rep.fail('P5 选中态未过（无面板可用）') // 窗仍开
    const v = rep.verdict()
    expect(v).toMatchObject({
      verdict: 'FAIL-ENV', exitCode: 2, fails: 0, excluded: 4, envWindowOpen: true,
    })
    expect(rep.exclusions[1].msg).toContain('重启后面板窗口未现')
  })

  /** 序列C：二次停摆——首轮自愈闭窗后再次停摆，各自成窗、各记一条停摆排除 */
  it('序列C：两次独立停摆 → 两条停摆排除条目，窗各自开合', () => {
    const rep = ledger()
    rep.beginEnvWindow('第一次停摆（WM_NULL 超时）', 'panel-stall')
    rep.exclude('第一次停摆：已重启面板', '第一次停摆（WM_NULL 超时）', 'panel-stall')
    rep.endEnvWindow('第一次重启健康验证')
    rep.pass('中间段恢复')
    rep.beginEnvWindow('第二次停摆（WM_NULL 超时）', 'panel-stall')
    rep.exclude('第二次停摆：已重启面板', '第二次停摆（WM_NULL 超时）', 'panel-stall')
    rep.endEnvWindow('第二次重启健康验证')
    expect(rep.exclusions).toHaveLength(2)
    expect(rep.exclusions.every((e) => e.inWindow)).toBe(true) // 两次停摆排除条目均记在各自窗内
    expect(rep.verdict()).toMatchObject({ verdict: 'FAIL-ENV', exitCode: 2, fails: 0, excluded: 2, envWindowOpen: false })
  })
})

/** 事后从三份账目里取失败/排除两路计数（对照断言用） */
function healAccounting(rep: Report): { fails: number; excluded: number } {
  return { fails: rep.fails, excluded: rep.excluded }
}

describe('--accept-scope：spec 范围段声明', () => {
  it('空格形态与等号形态都解析；可重复出现，去重保序', () => {
    expect(parseAcceptScope(['electron', '.', '--accept', '--accept-scope', 'P6,P8'])).toEqual(['P6', 'P8'])
    expect(parseAcceptScope(['--accept-scope=P7S'])).toEqual(['P7S'])
    expect(parseAcceptScope(['--accept-scope', 'P6', '--accept-scope', 'P8,P6'])).toEqual(['P6', 'P8'])
  })

  it('容忍空白与空 token；未声明 → 空数组；末尾裸旗标不炸', () => {
    expect(parseAcceptScope(['--accept-scope', ' P6 , ,P8 '])).toEqual(['P6', 'P8'])
    expect(parseAcceptScope(['--accept'])).toEqual([])
    expect(parseAcceptScope(['--accept-scope'])).toEqual([])
    expect(parseAcceptScope([])).toEqual([])
  })

  it('声明段号进 verdict 行', () => {
    const rep = ledger('t', { scope: ['P6', 'P8'] })
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      rep.verdict()
      const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('VERDICT')) ?? ''
      expect(line).toContain('scope=P6,P8')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('段注册 API（段起笔报段号）与 scope 核对', () => {
  it('beginSegment 起账：其后断言按段入账，换段重开；同段重复起笔幂等', () => {
    const rep = ledger()
    rep.beginSegment('P2', '面板出现')
    rep.pass('面板窗口出现')
    rep.pass('boot 存证在')
    rep.beginSegment('P3', 'dock 渲染')
    rep.fail('dock 未渲染')
    rep.beginSegment('P3') // 重复起笔不重复开账
    expect(rep.segments).toHaveLength(2)
    expect(rep.segments[0]).toMatchObject({ seg: 'P2', passes: 2, fails: 0, excluded: 0 })
    expect(rep.segments[1]).toMatchObject({ seg: 'P3', passes: 0, fails: 1, excluded: 0 })
  })

  it('排除也按当前段入账', () => {
    const rep = ledger()
    rep.beginSegment('P5')
    rep.beginEnvWindow('停摆', 'panel-stall')
    rep.fail('窗内断言')
    expect(rep.segments[0]).toMatchObject({ seg: 'P5', fails: 0, excluded: 1 })
  })

  it('声明段已注册 → scopeUnknown 空、无 WARN', () => {
    const rep = ledger('t', { scope: ['P6', 'P8'] })
    rep.beginSegment('P6')
    rep.beginSegment('P8')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let v: ReturnType<Report['verdict']>
    try {
      v = rep.verdict()
    } finally {
      spy.mockRestore()
    }
    expect(v.scopeUnknown).toEqual([])
    expect(spy.mock.calls.some((c) => String(c[0]).includes('WARN'))).toBe(false)
  })

  it('声明段部分未注册 → scopeUnknown 报出，WARN 告警但不阻断（退出码仍按三态）', () => {
    const rep = ledger('t', { scope: ['P6', 'P8'] })
    rep.beginSegment('P6')
    rep.fail('P6 的真失败')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let v: ReturnType<Report['verdict']>
    let warned = false
    try {
      v = rep.verdict()
      warned = spy.mock.calls.some((c) => String(c[0]).includes('WARN') && String(c[0]).includes('P8'))
    } finally {
      spy.mockRestore()
    }
    expect(v.scopeUnknown).toEqual(['P8'])
    expect(v.verdict).toBe('FAIL-CODE')
    expect(v.exitCode).toBe(1) // 不阻断：退出码不被 scope 核对改写
    expect(warned).toBe(true)
  })

  it('注册表缺位（轮内零注册段）→ WARN 说明注册表未填充，告警不阻断', () => {
    const rep = ledger('t', { scope: ['P6'] })
    rep.pass('全程无段起笔（存量埋点归 #114）')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let v: ReturnType<Report['verdict']>
    let warned = false
    try {
      v = rep.verdict()
      warned = spy.mock.calls.some((c) => String(c[0]).includes('WARN') && String(c[0]).includes('注册表'))
    } finally {
      spy.mockRestore()
    }
    expect(v.scopeUnknown).toEqual(['P6'])
    expect(v.exitCode).toBe(0)
    expect(warned).toBe(true)
  })
})

describe('报告账目落盘（证据文件）', () => {
  it('verdict 后证据文件含三路计数、scope 声明与段账目', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 't110-ledger-'))
    const file = join(dir, 't.log.txt')
    const rep = new Report('t', { file, scope: ['P6'] })
    rep.beginSegment('P6', '复位')
    rep.pass('复位达成')
    rep.beginSegment('P8')
    rep.beginEnvWindow('停摆', 'panel-stall')
    rep.fail('窗内断言')
    rep.verdict()
    const text = (await import('node:fs')).readFileSync(file, 'utf8')
    expect(text).toContain('pass=1 fail=0 excluded=1')
    expect(text).toContain('scope=P6')
    expect(text).toContain('P8')
    expect(text).toContain('WARN')
  })

  it('file=null 纯内存运行不落盘', async () => {
    const rep = ledger('in-memory')
    rep.pass('x')
    rep.verdict()
    expect(rep.file).toBe(null)
  })
})

describe('副电池旧二态用法兼容', () => {
  it('verdict("FAIL") 行文保持旧格式（无 excluded 字样），退出码 1', () => {
    const rep = ledger('legacy')
    rep.pass('a')
    rep.fail('b')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let v: ReturnType<Report['verdict']>
    let line = ''
    try {
      v = rep.verdict('FAIL')
      line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('VERDICT')) ?? ''
    } finally {
      spy.mockRestore()
    }
    expect(line).toContain('VERDICT: FAIL (pass=1 fail=1)')
    expect(line).not.toContain('excluded')
    expect(v).toMatchObject({ verdict: 'FAIL', exitCode: 1, fails: 1 })
  })
})
