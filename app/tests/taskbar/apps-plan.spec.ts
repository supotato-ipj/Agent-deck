/**
 * 应用组编排纯函数测试（工单52）：手钉与运行中应用合并——以 exe 路径为身份去重、
 * 手钉在前、已手钉应用运行时不新增图标只叠加运行态；窗口标题只随运行态即时呈现。
 * 工单58 溢出裁决：容量超限尾部收进溢出浮层（为 ⋯ 钮预留一格），数量回落自动回栏。
 * 先例：tests/desktop/plan.spec.ts（直接喂构造输入断言输出清单）。
 */
import { describe, expect, it } from 'vitest'
import { planAppsGroup, planAppsOverflow, planAppsSequence, promoteRunToFront, reorderRunOrder, shouldShowOnTaskbar } from '../../src/main/taskbar/apps-plan'
import type { TaskbarPinnedEntry, TaskbarWindowInput } from '../../src/main/taskbar/apps-plan'

const pinned = (exe: string, over: Partial<TaskbarPinnedEntry> = {}): TaskbarPinnedEntry => ({
  exe,
  label: over.label ?? exe.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''),
  iconKey: over.iconKey ?? null,
})

describe('应用组编排（手钉 ∪ 运行中，工单52）', () => {
  it('手钉在前、按手钉清单序；仅运行的应用按窗口首见序随后', () => {
    const out = planAppsGroup(
      [pinned('C:\\apps\\B.exe'), pinned('C:\\apps\\A.exe')],
      [{ exe: 'C:\\apps\\C.exe', title: 'C 窗口' }],
    )
    expect(out.map((e) => [e.exe, e.pinned, e.running])).toEqual([
      ['C:\\apps\\B.exe', true, false],
      ['C:\\apps\\A.exe', true, false],
      ['C:\\apps\\C.exe', false, true],
    ])
  })

  it('已手钉的应用运行时不新增图标：同一图标叠加运行态与窗口标题', () => {
    const out = planAppsGroup(
      [pinned('C:\\apps\\A.exe', { label: '甲应用', iconKey: 'C:\\apps\\A.exe|1' })],
      [{ exe: 'C:\\apps\\A.exe', title: '甲应用 - 编辑中' }],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      exe: 'C:\\apps\\A.exe',
      label: '甲应用',
      pinned: true,
      running: true,
      title: '甲应用 - 编辑中',
      iconKey: 'C:\\apps\\A.exe|1',
    })
  })

  it('exe 身份判定大小写与斜杠向不敏感（NTFS 语义）', () => {
    const out = planAppsGroup(
      [pinned('C:\\Apps\\WeChat.exe')],
      [{ exe: 'c:/apps/wechat.exe', title: '微信' }],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ pinned: true, running: true, title: '微信' })
  })

  it('同一应用多个窗口只出一个图标；标题取首个非空窗口标题', () => {
    const out = planAppsGroup(
      [],
      [
        { exe: 'C:\\apps\\A.exe', title: '' },
        { exe: 'C:\\apps\\A.exe', title: '文档 2' },
        { exe: 'C:\\apps\\A.exe', title: '文档 1' },
      ],
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ running: true, title: '文档 2' })
  })

  it('全部窗口无标题时 title 为 null（渲染层回退 label 作 tooltip）', () => {
    const out = planAppsGroup([], [{ exe: 'C:\\apps\\A.exe', title: '' }])
    expect(out[0].title).toBeNull()
  })

  it('仅运行应用的 label = exe 基名去扩展；图标键经注入查表（无表即 null）', () => {
    const icons = new Map([['c:\\apps\\a.exe', 'C:\\apps\\A.exe|9']])
    const out = planAppsGroup([], [{ exe: 'C:\\apps\\A.exe', title: null }], (exe) => icons.get(exe) ?? null)
    expect(out[0]).toMatchObject({ label: 'A', pinned: false, iconKey: 'C:\\apps\\A.exe|9' })
    const bare = planAppsGroup([], [{ exe: 'C:\\apps\\A.exe', title: null }])
    expect(bare[0].iconKey).toBeNull()
  })

  it('手钉清单内重复身份去重（首个胜）；空 exe 窗口跳过', () => {
    const out = planAppsGroup(
      [pinned('C:\\apps\\A.exe', { label: '一号' }), pinned('c:\\apps\\a.exe', { label: '二号' })],
      [{ exe: '', title: '无名' }, { exe: 'C:\\apps\\B.exe', title: '乙' }],
    )
    expect(out.map((e) => [e.label, e.iconKey])).toEqual([['一号', null], ['B', null]])
  })

  it('手钉未运行：running=false 且不带标题（标题只随运行态即时呈现）', () => {
    const out = planAppsGroup([pinned('C:\\apps\\A.exe')], [])
    expect(out).toEqual([
      { exe: 'C:\\apps\\A.exe', label: 'A', pinned: true, running: false, title: null, iconKey: null },
    ])
  })

  it('全空输入 → 空应用组', () => {
    expect(planAppsGroup([], [])).toEqual([])
  })
})

describe('统一序列默认落位（工单189）：排序键与 z 序快照脱钩，会话运行序承接位次', () => {
  it('runOrder 在场：仅运行应用按会话序落位，当拍窗口枚举序（z 序快照）不再决定位次', () => {
    // 当拍 z 序 B 在前（焦点刚切到 B），会话序 A 先入场——位次应跟会话序
    const out = planAppsGroup(
      [],
      [{ exe: 'C:\\apps\\B.exe', title: '乙' }, { exe: 'C:\\apps\\A.exe', title: '甲' }],
      undefined,
      ['c:\\apps\\a.exe', 'c:\\apps\\b.exe'],
    )
    expect(out.map((e) => e.exe)).toEqual(['C:\\apps\\A.exe', 'C:\\apps\\B.exe'])
  })

  it('runOrder 陈旧键跳过；序外新面孔按首见序殿后（引导/兜底口径）', () => {
    const out = planAppsGroup(
      [],
      [{ exe: 'C:\\apps\\C.exe', title: '丙' }, { exe: 'C:\\apps\\A.exe', title: '甲' }],
      undefined,
      ['c:\\apps\\a.exe'], // C 不在会话序（首拍引导）——殿后
    )
    expect(out.map((e) => e.exe)).toEqual(['C:\\apps\\A.exe', 'C:\\apps\\C.exe'])
  })

  it('手钉居前语义不变：会话序只裁决运行段内部位次', () => {
    const out = planAppsGroup(
      [pinned('C:\\apps\\P.exe')],
      [{ exe: 'C:\\apps\\A.exe', title: '甲' }, { exe: 'C:\\apps\\P.exe', title: '手钉运行中' }],
      undefined,
      ['c:\\apps\\a.exe'],
    )
    expect(out.map((e) => [e.exe, e.pinned, e.running])).toEqual([
      ['C:\\apps\\P.exe', true, true],
      ['C:\\apps\\A.exe', false, true],
    ])
  })
})

describe('编排一拍：默认规则落位＋手工序合并（工单189，planAppsSequence）', () => {
  const win = (exe: string, title: string | null = '窗') => ({ exe, title })

  it('首拍引导：会话序空按首见序落位，并把该序建立为会话运行序', () => {
    const r1 = planAppsSequence([], [win('C:\\apps\\A.exe'), win('C:\\apps\\B.exe')], [])
    expect(r1.apps.map((e) => e.exe)).toEqual(['C:\\apps\\A.exe', 'C:\\apps\\B.exe'])
    expect(r1.runOrder).toEqual(['c:\\apps\\a.exe', 'c:\\apps\\b.exe'])
  })

  it('z 序脱钩（本票主断言）：连续拍之间窗口枚举序任意翻转，序列与会话序纹丝不动', () => {
    const r1 = planAppsSequence([], [win('C:\\apps\\A.exe'), win('C:\\apps\\B.exe'), win('C:\\apps\\C.exe')], [])
    // 用户切焦点：z 序翻成 C、A、B（首见序完全颠倒）
    const r2 = planAppsSequence([], [win('C:\\apps\\C.exe'), win('C:\\apps\\A.exe'), win('C:\\apps\\B.exe')], r1.runOrder)
    expect(r2.apps.map((e) => e.exe)).toEqual(r1.apps.map((e) => e.exe))
    expect(r2.runOrder).toEqual(r1.runOrder)
  })

  it('新面孔追加最右：后启动的应用即使当拍 z 序居首也排在既有运行应用之后', () => {
    const r1 = planAppsSequence([], [win('C:\\apps\\A.exe'), win('C:\\apps\\B.exe')], [])
    // 新窗 D 置顶（z 序最前）；B、A 照旧
    const r2 = planAppsSequence([], [win('C:\\apps\\D.exe'), win('C:\\apps\\B.exe'), win('C:\\apps\\A.exe')], r1.runOrder)
    expect(r2.apps.map((e) => e.exe)).toEqual(['C:\\apps\\A.exe', 'C:\\apps\\B.exe', 'C:\\apps\\D.exe'])
    expect(r2.runOrder).toEqual(['c:\\apps\\a.exe', 'c:\\apps\\b.exe', 'c:\\apps\\d.exe'])
  })

  it('有窗在位不动：窗口标题变化、同应用一窗关闭（另一窗存续）都不动位次', () => {
    const r1 = planAppsSequence([], [win('C:\\apps\\A.exe', '文档1'), win('C:\\apps\\B.exe', '乙 1')], [])
    // A 的标题窗关了只剩另一窗；B 改标题；z 序翻转
    const r2 = planAppsSequence([], [win('C:\\apps\\B.exe', '乙 2'), win('C:\\apps\\A.exe', '文档2')], r1.runOrder)
    expect(r2.apps.map((e) => [e.exe, e.title])).toEqual([['C:\\apps\\A.exe', '文档2'], ['C:\\apps\\B.exe', '乙 2']])
  })

  it('全关消失、再启动回最右：键摘除出会话序，复启按新面孔追加末位', () => {
    const r1 = planAppsSequence([], [win('C:\\apps\\A.exe'), win('C:\\apps\\B.exe')], [])
    const r2 = planAppsSequence([], [win('C:\\apps\\A.exe')], r1.runOrder) // B 全关
    expect(r2.apps.map((e) => e.exe)).toEqual(['C:\\apps\\A.exe'])
    expect(r2.runOrder).toEqual(['c:\\apps\\a.exe']) // B 键摘除
    const r3 = planAppsSequence([], [win('C:\\apps\\B.exe'), win('C:\\apps\\A.exe')], r2.runOrder) // B 复启（z 序居首）
    expect(r3.apps.map((e) => e.exe)).toEqual(['C:\\apps\\A.exe', 'C:\\apps\\B.exe'])
  })

  it('手钉段在前不变；会话序只含未钉运行键——已钉应用开新窗并入钉图标、不进会话序', () => {
    const r1 = planAppsSequence([pinned('C:\\apps\\P.exe')], [win('C:\\apps\\P.exe', '手钉窗'), win('C:\\apps\\A.exe')], [])
    expect(r1.apps.map((e) => [e.exe, e.pinned, e.running])).toEqual([
      ['C:\\apps\\P.exe', true, true],
      ['C:\\apps\\A.exe', false, true],
    ])
    expect(r1.runOrder).toEqual(['c:\\apps\\a.exe'])
  })

  it('钉入原地转正：运行段首位应用进手钉清单后，统一序列位次不动、会话序摘除其键', () => {
    const r1 = planAppsSequence([pinned('C:\\apps\\P.exe')], [win('C:\\apps\\P.exe'), win('C:\\apps\\X.exe')], [])
    expect(r1.apps.map((e) => e.exe)).toEqual(['C:\\apps\\P.exe', 'C:\\apps\\X.exe'])
    // 用户把 X 钉入（服务层 = 手钉清单追加至末位＋下拍重编排）：X 原地转正（位次 2 不动）
    const r2 = planAppsSequence([pinned('C:\\apps\\P.exe'), pinned('C:\\apps\\X.exe')], [win('C:\\apps\\X.exe')], r1.runOrder)
    expect(r2.apps.map((e) => [e.exe, e.pinned, e.running])).toEqual([
      ['C:\\apps\\P.exe', true, false],
      ['C:\\apps\\X.exe', true, true],
    ])
    expect(r2.runOrder).toEqual([])
  })

  it('同拍多新面孔按首见序一次并列追加（突发窗口不互相翻转）', () => {
    const r1 = planAppsSequence([], [win('C:\\apps\\A.exe')], [])
    const r2 = planAppsSequence([], [win('C:\\apps\\C.exe'), win('C:\\apps\\B.exe'), win('C:\\apps\\A.exe')], r1.runOrder)
    expect(r2.apps.map((e) => e.exe)).toEqual(['C:\\apps\\A.exe', 'C:\\apps\\C.exe', 'C:\\apps\\B.exe'])
  })
})

describe('解除手钉原地转运行（工单189，promoteRunToFront）', () => {
  const win = (exe: string, title: string | null = '窗') => ({ exe, title })
  it('键插回会话序首位（紧随手钉段=原地），陈旧键先去重', () => {
    expect(promoteRunToFront(['c:\\apps\\a.exe', 'c:\\apps\\b.exe'], 'c:\\apps\\x.exe'))
      .toEqual(['c:\\apps\\x.exe', 'c:\\apps\\a.exe', 'c:\\apps\\b.exe'])
    expect(promoteRunToFront(['c:\\apps\\x.exe', 'c:\\apps\\a.exe'], 'c:\\apps\\x.exe'))
      .toEqual(['c:\\apps\\x.exe', 'c:\\apps\\a.exe'])
    expect(promoteRunToFront([], 'c:\\apps\\x.exe')).toEqual(['c:\\apps\\x.exe'])
  })

  it('解除在运行的已钉应用：promote 后重编排，该应用落运行段首位=原位次原地转运行', () => {
    // 现场手钉 [P, X]（X 运行中），未钉运行 [A]
    const r0 = planAppsSequence([pinned('C:\\apps\\P.exe'), pinned('C:\\apps\\X.exe')], [win('C:\\apps\\X.exe'), win('C:\\apps\\A.exe')], [])
    expect(r0.apps.map((e) => e.exe)).toEqual(['C:\\apps\\P.exe', 'C:\\apps\\X.exe', 'C:\\apps\\A.exe'])
    // 用户解除 X 手钉：服务层 promote（X 插回会话序首位）再重编排——X 停在位次 2
    const order = promoteRunToFront(r0.runOrder, 'c:\\apps\\x.exe')
    const r1 = planAppsSequence([pinned('C:\\apps\\P.exe')], [win('C:\\apps\\X.exe'), win('C:\\apps\\A.exe')], order)
    expect(r1.apps.map((e) => [e.exe, e.pinned, e.running])).toEqual([
      ['C:\\apps\\P.exe', true, false],
      ['C:\\apps\\X.exe', false, true],
      ['C:\\apps\\A.exe', false, true],
    ])
    expect(r1.runOrder).toEqual(['c:\\apps\\x.exe', 'c:\\apps\\a.exe'])
  })
})

describe('未钉运行条目会话换位（工单195，reorderRunOrder）：拖位落会话运行序、不落盘', () => {
  it('运行段内换位：before=运行身份 → 移到该键之前', () => {
    expect(reorderRunOrder(['c:\\apps\\b.exe', 'c:\\apps\\c.exe'], 'C:\\Apps\\C.exe', 'c:\\apps\\B.exe'))
      .toEqual(['c:\\apps\\c.exe', 'c:\\apps\\b.exe'])
  })

  it('before=null（组空白落点）→ 运行段末尾', () => {
    expect(reorderRunOrder(['c:\\apps\\c.exe', 'c:\\apps\\b.exe'], 'C:\\Apps\\C.exe', null))
      .toEqual(['c:\\apps\\b.exe', 'c:\\apps\\c.exe'])
  })

  it('before 指向手钉段/序外身份 → 运行段首位钳取（紧随手钉段=离落点最近的可达位）', () => {
    expect(reorderRunOrder(['c:\\apps\\b.exe', 'c:\\apps\\c.exe'], 'C:\\Apps\\C.exe', 'C:\\Apps\\Pinned.exe'))
      .toEqual(['c:\\apps\\c.exe', 'c:\\apps\\b.exe'])
  })

  it('自落点与身份不在序：原引用原样返回（服务层据同一引用=空转 + includes 区分 ok:true/ok:false）', () => {
    const order = ['c:\\apps\\b.exe', 'c:\\apps\\c.exe']
    expect(reorderRunOrder(order, 'c:\\apps\\b.exe', 'c:\\apps\\b.exe')).toBe(order)
    expect(reorderRunOrder(order, 'C:\\Gone\\ghost.exe', 'c:\\apps\\b.exe')).toBe(order)
  })

  it('身份归一匹配（NTFS 大小写/斜杠不敏感），换位不重不漏', () => {
    expect(reorderRunOrder(['c:\\apps\\b.exe', 'c:\\apps\\c.exe', 'c:\\apps\\d.exe'], 'C:/APPS/D.exe', 'c:\\apps\\b.exe'))
      .toEqual(['c:\\apps\\d.exe', 'c:\\apps\\b.exe', 'c:\\apps\\c.exe'])
  })
})

describe('窗口过滤判据（工单156）：枚举特征 → 收/拒（后台进程/cloaked/工具窗/无标题窗不上栏）', () => {
  /** 正常可见带标题主窗基线（枚举壳采集的全量特征都在场） */
  const main = { exe: 'C:\\Apps\\A.exe', title: '甲窗口', visible: true, cloaked: false, toolWindow: false, owned: false, appWindow: false }
  const OWN = 'c:\\deck\\agent-deck.exe'

  it('正常可见带标题主窗：收', () => {
    expect(shouldShowOnTaskbar(main, OWN)).toBe(true)
  })

  it('最小化窗口：收（运行态含最小化——最小化窗仍带可见样式位，特征与正常主窗一致）', () => {
    // 最小化不进特征位：IsWindowVisible 对最小化窗仍真（WS_VISIBLE 位还在），判据与正常主窗同路
    expect(shouldShowOnTaskbar({ ...main }, OWN)).toBe(true)
  })

  it('不可见样式位：拒', () => {
    expect(shouldShowOnTaskbar({ ...main, visible: false }, OWN)).toBe(false)
  })

  it('cloaked（UWP 挂起/其他虚拟桌面）：拒', () => {
    expect(shouldShowOnTaskbar({ ...main, cloaked: true }, OWN)).toBe(false)
  })

  it('工具窗（WS_EX_TOOLWINDOW）：拒', () => {
    expect(shouldShowOnTaskbar({ ...main, toolWindow: true }, OWN)).toBe(false)
  })

  it('有属主且无 APPWINDOW：拒；有属主带 APPWINDOW：收（应用自证上栏的弹窗主形态）', () => {
    expect(shouldShowOnTaskbar({ ...main, owned: true }, OWN)).toBe(false)
    expect(shouldShowOnTaskbar({ ...main, owned: true, appWindow: true }, OWN)).toBe(true)
  })

  it('空标题（null / 空串）：拒（后台无窗口面进程的常态）', () => {
    expect(shouldShowOnTaskbar({ ...main, title: null }, OWN)).toBe(false)
    expect(shouldShowOnTaskbar({ ...main, title: '' }, OWN)).toBe(false)
  })

  it('自家进程（exe 归一同身份，大小写斜杠不敏感）：拒', () => {
    expect(shouldShowOnTaskbar({ ...main, exe: 'C:/Deck/Agent-Deck.EXE' }, OWN)).toBe(false)
  })

  it('无 exe 身份：拒（取不到身份的窗口无从寻址，不上栏）', () => {
    expect(shouldShowOnTaskbar({ ...main, exe: '' }, OWN)).toBe(false)
  })

  it('开始菜单与搜索 Shell 宿主：拒（系统浮层不是用户运行应用）', () => {
    expect(shouldShowOnTaskbar({ ...main, exe: 'C:\\Windows\\SystemApps\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\StartMenuExperienceHost.exe' }, OWN)).toBe(false)
    expect(shouldShowOnTaskbar({ ...main, exe: 'C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\SearchHost.exe' }, OWN)).toBe(false)
    expect(shouldShowOnTaskbar({ ...main, exe: 'C:\\Windows\\SystemApps\\Microsoft.WindowsCalculator_8wekyb3d8bbwe\\CalculatorApp.exe' }, OWN)).toBe(true)
  })

  it('特征位缺省 = 未采集到拒绝位按通过（离线旧 fake 源兼容口径；生产枚举壳恒给全量特征）', () => {
    expect(shouldShowOnTaskbar({ exe: 'C:\\Apps\\A.exe', title: '甲' }, OWN)).toBe(true)
  })

  it('自家拒的判据输入不带特征位也成立（判据次序：可见 → cloaked → 工具 → 属主 → 标题 → 身份 → 自家）', () => {
    expect(shouldShowOnTaskbar({ exe: OWN, title: '自家' }, OWN)).toBe(false)
  })
})

describe('应用组溢出裁决（工单58）：容量超限尾部收进浮层，回落自动回栏', () => {
  const exes = (n: number) => Array.from({ length: n }, (_, i) => pinned(`C:\\apps\\App${i}.exe`))

  it('容量内全留栏（含恰好放满的边界）：无浮层、不预留 ⋯ 格', () => {
    expect(planAppsOverflow(exes(3), 5)).toEqual({ bar: exes(3), overflow: [] })
    expect(planAppsOverflow(exes(4), 4)).toEqual({ bar: exes(4), overflow: [] })
  })

  it('超出一个：尾部一个收进浮层，栏内为 ⋯ 钮预留一格', () => {
    const { bar, overflow } = planAppsOverflow(exes(5), 4)
    expect(bar.map((e) => e.exe)).toEqual(['C:\\apps\\App0.exe', 'C:\\apps\\App1.exe', 'C:\\apps\\App2.exe'])
    expect(overflow.map((e) => e.exe)).toEqual(['C:\\apps\\App3.exe', 'C:\\apps\\App4.exe'])
  })

  it('溢出取尾部：手钉在前的编排序即优先级，仅运行的后排应用先进浮层', () => {
    const entries = planAppsGroup(
      [pinned('C:\\apps\\P0.exe'), pinned('C:\\apps\\P1.exe')],
      [{ exe: 'C:\\apps\\R0.exe', title: '运行甲' }, { exe: 'C:\\apps\\R1.exe', title: '运行乙' }],
    )
    const { bar, overflow } = planAppsOverflow(entries, 3)
    expect(bar.map((e) => e.exe)).toEqual(['C:\\apps\\P0.exe', 'C:\\apps\\P1.exe'])
    expect(overflow.map((e) => e.exe)).toEqual(['C:\\apps\\R0.exe', 'C:\\apps\\R1.exe'])
  })

  it('数量回落自动回栏：同一容量重新编排，浮层清空', () => {
    expect(planAppsOverflow(exes(5), 3).overflow).toHaveLength(3)
    const again = planAppsOverflow(exes(2), 3)
    expect(again.bar).toHaveLength(2)
    expect(again.overflow).toEqual([])
  })

  it('容量只剩一格：栏内不留图标，全部经 ⋯ 进浮层', () => {
    const { bar, overflow } = planAppsOverflow(exes(3), 1)
    expect(bar).toEqual([])
    expect(overflow).toHaveLength(3)
  })

  it('容量为零或负：全部进浮层；空清单恒双空', () => {
    expect(planAppsOverflow(exes(2), 0).overflow).toHaveLength(2)
    expect(planAppsOverflow(exes(2), -1).overflow).toHaveLength(2)
    expect(planAppsOverflow([], 0)).toEqual({ bar: [], overflow: [] })
  })

  it('输入不被改动，条目原样引用（不复制不重组字段）', () => {
    const entries = exes(4)
    const snapshot = entries.map((e) => ({ ...e }))
    const { bar, overflow } = planAppsOverflow(entries, 3)
    expect(entries).toEqual(snapshot)
    expect(bar[0]).toBe(entries[0])
    expect(overflow[0]).toBe(entries[2])
  })
})
