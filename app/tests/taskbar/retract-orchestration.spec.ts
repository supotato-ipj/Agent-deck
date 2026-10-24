// 最大化收栏主进程编排（工单241，spec #236）：三态机接线 + 真最大化探针 + AppBar
// 注销/重注册配对 + 浮层收拢 + 存证命名族。
//
// 接缝（本票离线可测的两处公开边界）：
//   ① 纯函数缝：shared/retract.ts 的 planBarTransition（旧态 → 新态 → 动作计划）。
//      三态迁移的动作集合是纯裁决，可穷举；效果层（Electron 控制器）离线不可测，
//      其接线要点以源码级守卫钉住（见「控制器接线」组）。
//   ② 契约缝：shared/contract.ts 的 taskbar/bar-mode 桥接事件（下发三态给条带渲染层）。
//
// 术语（GLOSSARY #246 入册）：最大化收栏 / 唤出条 / 最大化让位 / 托盘右键让位。
// 「最大化让位」= 窗给栏让位（51 电池 P2 段语境）；「最大化收栏」= 栏给窗让位——方向相反，勿混。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { planBarTransition, retractAutoHideState, ABS_AUTOHIDE, ABS_ALWAYSONTOP } from '../../src/shared/retract'
import type { BarMode } from '../../src/shared/retract'

const MODES: BarMode[] = ['visible', 'maximize-retract', 'fullscreen-yield']

/** 仓库根（app/ 的上一级） */
const REPO_ROOT = path.resolve(__dirname, '../../..')
/** 递归枚举仓库内 .ts 文件（仓库根相对路径，/ 分隔） */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (name.endsWith('.ts')) out.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'))
  }
  return out
}
const SRC_FILES = tsFiles(path.resolve(REPO_ROOT, 'app/src'))
function srcOf(rel: string): string {
  return readFileSync(path.resolve(REPO_ROOT, rel), 'utf8')
}
/** 去注释的源码（散文提及不算用法） */
function codeOf(rel: string): string {
  return srcOf(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('三态迁移的动作计划（工单241 纯函数缝）', () => {
  it('常驻 → 收栏：释放工作区占位（注销 AppBar）+ 收拢浮层；条带窗不隐藏（承载形态 = 栏窗复用）', () => {
    const plan = planBarTransition('visible', 'maximize-retract')
    expect(plan.releaseAppBar).toBe(true)
    expect(plan.claimAppBar).toBe(false)
    expect(plan.closePopups).toBe(true)
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract'])
  })

  it('收栏 → 常驻：重注册 AppBar（占位恢复）+ 重协商；不重复隐藏窗；存证 taskbar-retract-lifted', () => {
    const plan = planBarTransition('maximize-retract', 'visible')
    expect(plan.claimAppBar).toBe(true)
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted'])
  })

  it('常驻 → 全屏让位：整窗退场（隐藏）+ 收拢浮层；存证沿用既有 taskbar-yield 名', () => {
    const plan = planBarTransition('visible', 'fullscreen-yield')
    expect(plan.hideWindow).toBe(true)
    expect(plan.showWindow).toBe(false)
    expect(plan.closePopups).toBe(true)
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.claimAppBar).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield'])
  })

  it('全屏让位 → 常驻：整窗复现；存证沿用既有 taskbar-yield-lifted 名', () => {
    const plan = planBarTransition('fullscreen-yield', 'visible')
    expect(plan.showWindow).toBe(true)
    expect(plan.hideWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted'])
  })

  it('全屏让位 → 收栏：窗复现 + 释放占位；两族存证各一条（先退出旧态、再进入新态）', () => {
    const plan = planBarTransition('fullscreen-yield', 'maximize-retract')
    expect(plan.showWindow).toBe(true)
    expect(plan.releaseAppBar).toBe(true)
    expect(plan.closePopups).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted', 'taskbar-retract'])
  })

  it('收栏 → 全屏让位：整窗退场 + 占位恢复（让位态占位生效，既有语义不变）', () => {
    const plan = planBarTransition('maximize-retract', 'fullscreen-yield')
    expect(plan.hideWindow).toBe(true)
    expect(plan.claimAppBar).toBe(true)
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted', 'taskbar-yield'])
  })

  it('同态 → 同态：零动作、零存证（幂等——每拍轮询不重复落账）', () => {
    for (const mode of MODES) {
      const plan = planBarTransition(mode, mode)
      expect(plan).toEqual({
        releaseAppBar: false,
        engageAutoHide: false,
        restoreAutoHide: false,
        claimAppBar: false,
        hideWindow: false,
        showWindow: false,
        closePopups: false,
        evidence: [],
      })
    }
  })

  it('E4 粘性：收栏态不因「占位已释放→最大化窗覆盖整屏」的副作用而翻成让位（真最大化优先，归 resolveBarMode）', () => {
    // 迁移计划自身不重判档位：收栏 → 收栏恒零动作（不重复注销/重注册 AppBar）
    const plan = planBarTransition('maximize-retract', 'maximize-retract')
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.claimAppBar).toBe(false)
    expect(plan.evidence).toEqual([])
  })

  it('不变量：工作区占位只在收栏态释放（其余两态占位必须生效），任一迁移恰有一侧为真', () => {
    for (const prev of MODES) {
      for (const next of MODES) {
        const plan = planBarTransition(prev, next)
        if (prev === next) continue
        expect(plan.releaseAppBar, `${prev} → ${next}`).toBe(next === 'maximize-retract')
        expect(plan.claimAppBar, `${prev} → ${next}`).toBe(next !== 'maximize-retract')
        expect(plan.releaseAppBar !== plan.claimAppBar, `${prev} → ${next}`).toBe(true)
      }
    }
  })
})

describe('原生栏托管（工单260，spec #258）：收栏置位 ABS_AUTOHIDE 的迁移计划', () => {
  it('进入收栏：置位原生栏自动隐藏（engageAutoHide）——与注销占位同拍、与唤出条同生命周期', () => {
    for (const prev of ['visible', 'fullscreen-yield'] as BarMode[]) {
      const plan = planBarTransition(prev, 'maximize-retract')
      expect(plan.engageAutoHide, `${prev} → maximize-retract`).toBe(true)
      expect(plan.restoreAutoHide, `${prev} → maximize-retract`).toBe(false)
    }
  })

  it('退出收栏：复原原生栏自动隐藏（restoreAutoHide）——解除最大化和被全屏压过两路都算退', () => {
    for (const next of ['visible', 'fullscreen-yield'] as BarMode[]) {
      const plan = planBarTransition('maximize-retract', next)
      expect(plan.restoreAutoHide, `maximize-retract → ${next}`).toBe(true)
      expect(plan.engageAutoHide, `maximize-retract → ${next}`).toBe(false)
    }
  })

  it('非收栏迁移不碰自动隐藏（仅收栏态置位，非收栏时段系统行为与现状一致）', () => {
    const a = planBarTransition('visible', 'fullscreen-yield')
    const b = planBarTransition('fullscreen-yield', 'visible')
    expect(a.engageAutoHide || a.restoreAutoHide).toBe(false)
    expect(b.engageAutoHide || b.restoreAutoHide).toBe(false)
  })

  it('同态零动作含自动隐藏（250ms 每拍轮询不重复置位/复原）', () => {
    for (const mode of MODES) {
      const plan = planBarTransition(mode, mode)
      expect(plan.engageAutoHide).toBe(false)
      expect(plan.restoreAutoHide).toBe(false)
    }
  })

  it('不变量：置位恰在进入收栏、复原恰在退出收栏——与占位注销严格同拍（释放占位不释放保留带＝白做）', () => {
    for (const prev of MODES) {
      for (const next of MODES) {
        if (prev === next) continue
        const plan = planBarTransition(prev, next)
        expect(plan.engageAutoHide, `${prev} → ${next}`).toBe(next === 'maximize-retract')
        expect(plan.restoreAutoHide, `${prev} → ${next}`).toBe(prev === 'maximize-retract')
        expect(plan.engageAutoHide, `${prev} → ${next}`).toBe(plan.releaseAppBar)
      }
    }
  })
})

describe('收栏置位的目标 appbar 状态（工单260 值函数，thide RAII 蓝本）', () => {
  it('保留用户的 ALWAYSONTOP 位、加 ABS_AUTOHIDE（spike 基线 state 0 → 置 1：1392→1440 的实测序列）', () => {
    expect(retractAutoHideState(0)).toBe(ABS_AUTOHIDE)
    expect(retractAutoHideState(ABS_ALWAYSONTOP)).toBe(ABS_AUTOHIDE | ABS_ALWAYSONTOP)
  })

  it('用户本已开启自动隐藏：置位为无操作（结果不变——记账照走、复原照走，逻辑不特判）', () => {
    expect(retractAutoHideState(ABS_AUTOHIDE)).toBe(ABS_AUTOHIDE)
    expect(retractAutoHideState(ABS_AUTOHIDE | ABS_ALWAYSONTOP)).toBe(ABS_AUTOHIDE | ABS_ALWAYSONTOP)
  })

  it('ABS_* 常量与 Win32 shellapi 对齐（探针同款：AUTOHIDE=0x1 ALWAYSONTOP=0x2）', () => {
    expect(ABS_AUTOHIDE).toBe(0x1)
    expect(ABS_ALWAYSONTOP).toBe(0x2)
  })
})

describe('迁移计划只有一份实现（单一纯模块口径，同工单237：主进程侧只做转发导出）', () => {
  it('实现本体在 shared/retract.ts，别处零出现', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export\s+function\s+planBarTransition\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual(['app/src/shared/retract.ts'])
  })
})

describe('真最大化探针（工单241：IsZoomed 族真最大化样式）', () => {
  const YIELD_SRC = 'app/src/main/taskbar/yield.ts'

  it('探针绑定 user32 的 IsZoomed，真值直接喂进 zoomed 位（不是矩形覆盖法的推断）', () => {
    const text = srcOf(YIELD_SRC)
    expect(text).toMatch(/IsZoomed/)
    expect(text).toMatch(/zoomed:\s*Boolean\(/)
  })

  it('探针不引新具名 struct（koffi 具名类型进程级单登，#153 教训：撞名即崩）', () => {
    const structs = srcOf(YIELD_SRC).match(/koffi\.struct\('[^']+'/g) ?? []
    expect(structs).toEqual(["koffi.struct('TASKBAR_YIELD_RECT'"])
  })

  it('不用 GetWindowPlacement（更重，要 struct）/ WS_MAXIMIZE 样式位（与贴靠语义不一致）', () => {
    for (const rel of SRC_FILES) {
      // 注释不参与判定（散文提及「为什么不用」不算用法）
      const code = srcOf(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code.includes('GetWindowPlacement'), rel).toBe(false)
      expect(code.includes('WS_MAXIMIZE'), rel).toBe(false)
      expect(code.includes('GWL_STYLE'), rel).toBe(false)
    }
  })

  it('判定仍归 resolveBarMode 单一裁决（探针只供事实，不自判两态关系）', () => {
    const text = srcOf(YIELD_SRC)
    // 探针只负责取事实：矩形/类名/进程/真最大化四件，不出现档位裁决
    expect(text).not.toMatch(/maximize-retract|fullscreen-yield/)
  })
})

describe('控制器接线（工单241 三态机；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const ctrl = srcOf(CTRL)
  const code = codeOf(CTRL)

  it('档位裁决单一来源：控制器调 resolveBarMode，不自判两态关系', () => {
    expect(code).toMatch(/resolveBarMode\(/)
    expect(code).not.toMatch(/coversScreenRect/)
    // 不自己拿真最大化位做判断（只允许进存证载荷）
    expect(code).not.toMatch(/if\s*\(\s*probe\.zoomed/)
    expect(code).not.toMatch(/probe\.zoomed\s*===/)
  })

  it('收栏动作成对：释放占位注销 AppBar + 恢复时重注册并重协商', () => {
    expect(code).toMatch(/removeAppBar\(/)
    expect(code).toMatch(/registerAppBar\(/)
    expect(code).toMatch(/renegotiate\(/)
  })

  it('浮层收拢走单一清单（popupHosts 单遍历——不另起一份浮层名单）', () => {
    // 收层一处（h.close）；dispose 一处是销毁清算（另一语义，不算收层）
    expect(code.match(/for \(const h of popupHosts\) h\.close\(/g)?.length ?? 0).toBe(1)
  })

  it('存证命名族：收栏/恢复落 taskbar-retract / taskbar-retract-lifted（名在纯模块，控制器照单落盘）', () => {
    const plan = srcOf('app/src/shared/retract.ts')
    expect(plan).toMatch(/'taskbar-retract'/)
    expect(plan).toMatch(/'taskbar-retract-lifted'/)
    expect(code).toMatch(/for \(const type of plan\.evidence\)/)
  })

  it('轮询与全屏让位共用 250ms 节奏（单一 YIELD_POLL_MS，只有一处轮询用它）', () => {
    expect(code).toMatch(/const YIELD_POLL_MS = 250/)
    expect(code.match(/\bYIELD_POLL_MS\b/g)?.length ?? 0).toBe(2) // 定义 + 轮询一处（TRAY_YIELD_POLL_MS 是另一档）
  })

  it('降级档禁用收栏：注册失败置降级位，裁决输入取该位', () => {
    expect(code).toMatch(/appBarDegraded = true/)
    expect(code).toMatch(/appBarDegraded: s\.appBarDegraded/)
  })

  it('收栏态不动条带几何（唤出条要贴屏底；条带矩形与协商矩形保持同位，回正守卫不打架）', () => {
    // 档位迁移只做「占位 / 显隐 / 浮层 / 下发」四类动作，不碰窗口位置
    const machine = code.slice(code.indexOf('applyBarMode'), code.indexOf('applyBarMode') + 3000)
    expect(machine).not.toMatch(/setBounds|setPosition/)
  })

  it('自家浮层夺前台不翻收栏档（工单253）：在场事实喂进裁决，且带上当前档位', () => {
    // 在场事实取六面浮层的开合事件（同一通道 taskbar/popup-state——载体是唯一收口）
    expect(code).toMatch(/ctx\.on\('taskbar\/popup-state'/)
    // 裁决输入带「自家浮层在场」与「当前档位」两个位（纯函数侧据此判「保持」）
    expect(code).toMatch(/ownOverlayPresent:\s*openOverlayFamilies\.size > 0/)
    expect(code).toMatch(/prevMode:\s*s\.mode/)
  })

  it('浮层在场集合随浮层收层/销窗清账（工单253：不在场的浮层不得钉住档位）', () => {
    // 载体收层与销窗都发「浮层不在场」事实（popup.ts 是六面唯一收口）
    const popup = srcOf('app/src/main/taskbar/popup.ts')
    expect(popup).toMatch(/taskbar\/popup-state'[^)]*open: false/)
    // 控制器退场时退订该订阅（不留悬挂监听）
    expect(code).toMatch(/offPopupState\(\)/)
  })
})

describe('三态下发契约（工单241：主进程 → 条带渲染层）', () => {
  it('taskbar/bar-mode 在内核桥接事件表登记（载荷含档位与迁移原因）', () => {
    const contract = srcOf('app/src/shared/contract.ts')
    expect(contract).toMatch(/export interface TaskbarBarModeState/)
    expect(contract).toMatch(/'taskbar\/bar-mode':\s*TaskbarBarModeState/)
  })

  it('ctx 事件声明齐备（cordis.d.ts——ctx.emit 的类型口）', () => {
    const d = srcOf('app/src/main/cordis.d.ts')
    expect(d).toMatch(/'taskbar\/bar-mode':\s*\(payload: TaskbarBarModeState\) => void/)
  })

  it('条带窗订阅该事件并据此让栏面退场（收栏态栏面隐去、热区清空）', () => {
    const renderer = srcOf('app/src/renderer/taskbar.ts')
    expect(renderer).toMatch(/'taskbar\/bar-mode'/)
    expect(renderer).toMatch(/data-bar-mode/)
    const html = srcOf('app/src/renderer/taskbar.html')
    expect(html).toMatch(/data-bar-mode="maximize-retract"/)
  })

  it('收栏前缓存各组 pill 矩形（唤出条几何来源——裁决 (b)：渲染层自算，主进程不回读几何帧）', () => {
    const renderer = srcOf('app/src/renderer/taskbar.ts')
    expect(renderer).toMatch(/summonPillCache/)
    // 五组齐（开始/推荐/应用/右组/显示桌面细条——显示桌面细条在最右端各出一条）
    for (const group of ['start', 'recs', 'apps', 'right', 'showdesk']) {
      expect(renderer, `缺组 ${group}`).toMatch(new RegExp(`group:\\s*'${group}'`))
    }
    // 收栏态不得覆写缓存（栏面退场量不到矩形——缓存要留收栏前最后一帧）
    expect(renderer).toMatch(/if \(barMode === 'maximize-retract'\) return/)
  })
})

describe('原生栏托管接线（工单260；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const AUTOHIDE = 'app/src/main/taskbar/appbar-autohide.ts'
  const APPBAR = 'app/src/main/taskbar/appbar.ts'
  const code = codeOf(CTRL)

  it('置位/复原随迁移计划执行：applyBarMode 认 plan.engageAutoHide / plan.restoreAutoHide，不自判收栏', () => {
    expect(code).toMatch(/if \(plan\.engageAutoHide\)/)
    expect(code).toMatch(/if \(plan\.restoreAutoHide\)/)
    // 置位与注销占位同段（releaseAppBar 的同拍纪律——engage/restore 两钩子都在占位段内）
    const m = code.match(/if \(plan\.releaseAppBar[\s\S]{0,1200}?if \(plan\.restoreAutoHide\)/)
    expect(m).toBeTruthy()
  })

  it('销窗路径（destroy）也复原：面板退出/禁用在收栏态时账不悬空（还原路径①扩展）', () => {
    expect(code).toMatch(/restoreRetractAutoHide\(log, reason\)/)
    // destroy 内的复原先于会话判空（与 hidNative 还原同一位置纪律——账不随窗生灭）
    const m = code.match(/const destroy = \(reason: string\) => \{[\s\S]{0,600}?restoreRetractAutoHide\(log, reason\)/)
    expect(m).toBeTruthy()
    // appbar 复原**先于可见性复原**（顺序即行为，与守卫/守护径同源——restore-ledger-wiring
    // 的钉序理由）：置位态下 WS_VISIBLE 位可被 explorer 翻开，可见性判据会被「已可见」
    // 骗成静默；先卸置位，可见性复原才做真工作（51 电池 P9 的面板侧径）
    const d = code.slice(code.indexOf('const destroy'))
    const iAppbar = d.indexOf('restoreRetractAutoHide(log, reason)')
    const iShow = d.indexOf('showNativeTaskbar(log, reason)')
    expect(iAppbar).toBeGreaterThanOrEqual(0)
    expect(iShow).toBeGreaterThanOrEqual(0)
    expect(iAppbar).toBeLessThan(iShow)
  })

  it('置位/复原的 RAII 实现单一实现住在 appbar-autohide.ts（记账 + 读回验证 + 退避复原）', () => {
    const src = codeOf(AUTOHIDE)
    expect(src).toMatch(/export function engageRetractAutoHide\(/)
    expect(src).toMatch(/export function restoreRetractAutoHide\(/)
    expect(src).toMatch(/retractAutoHideState\(/) // 目标值来自纯函数（不自算位运算）
    expect(src).toMatch(/planAppBarStateRestore\(/) // 退避裁决走 native-restore 纯函数
    expect(src).toMatch(/getAppBarState\(\)/) // 读回验证以视图事实为准
    // setAppBarState 调用点闭集（工单261 扩）：路径① RAII（appbar-autohide）+ 路径②③
    // 落盘账复原（appbar-ledger——守卫/守护从账读复原目标，票面「还原账全路径扩展」）。
    // 闭集之外零调用：SETSTATE 是系统级状态写，不许第三处自行动笔。
    const callers: string[] = []
    for (const rel of SRC_FILES) {
      const c = codeOf(rel).replace(/export function setAppBarState\([^)]*\): void \{/, '')
      if (/setAppBarState\(/.test(c)) callers.push(rel)
    }
    expect(callers.sort()).toEqual([AUTOHIDE, 'app/src/main/taskbar/appbar-ledger.ts'].sort())
  })

  it('koffi 绑定：ABM_GETSTATE/ABM_SETSTATE 常量与封装在 appbar.ts（shellapi 官方值 4/10）', () => {
    const src = codeOf(APPBAR)
    expect(src).toMatch(/ABM_GETSTATE = 4/)
    expect(src).toMatch(/ABM_SETSTATE = 10/)
    expect(src).toMatch(/export function getAppBarState\(\)/)
    expect(src).toMatch(/export function setAppBarState\(/)
  })

  it('置位值函数经主进程侧转发导出（单一实现纪律，同工单237）', () => {
    const fwd = srcOf('app/src/main/taskbar/retract.ts')
    expect(fwd).toMatch(/\bretractAutoHideState\b/)
    expect(fwd).toMatch(/\bABS_AUTOHIDE\b/)
    expect(fwd).toMatch(/\bABS_ALWAYSONTOP\b/)
  })
})

describe('原生栏重申轮询接线（工单262，spec #258；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const AUTOHIDE = 'app/src/main/taskbar/appbar-autohide.ts'
  const WATCH = 'app/src/main/taskbar/native-watch.ts'
  const NATIVE = 'app/src/main/taskbar/native.ts'
  const code = codeOf(CTRL)

  it('轮询起止随三态迁移：进收栏起表、离收栏休止（非收栏态不轮询——票面验收标准第三条）', () => {
    expect(code).toMatch(/if \(next === 'maximize-retract'\) startNativeWatch\(s\)/)
    expect(code).toMatch(/else stopNativeWatch\(s\)/)
    // 起表在置位之后：重申机器以「刚置位过的当拍事实」立基线（首拍不误报）
    const m = code.match(/if \(plan\.engageAutoHide\) engageRetractAutoHide\(log\)[\s\S]{0,500}?startNativeWatch/)
    expect(m).toBeTruthy()
  })

  it('销窗路径（destroy）停表：收栏态下禁用/退役/退出不悬空轮询（同 hidNative 复原的位置纪律）', () => {
    const m = code.match(/const destroy = \(reason: string\) => \{[\s\S]{0,600}?stopNativeWatch/)
    expect(m).toBeTruthy()
  })

  it('外部先销窗路径（closed）同样停表（迟到的 interval 不许悬空——同 stopYieldPoll 位置纪律）', () => {
    const m = code.match(/stopYieldPoll\(s\)[\s\S]{0,300}?stopNativeWatch\(s\)/)
    expect(m).toBeTruthy()
  })

  it('一拍裁决照单执行：hide → hideNativeTaskbar、engage → reassertRetractAutoHide、归因落 taskbar-native-reassert 存证', () => {
    expect(code).toMatch(/if \(decision\.hide\) hideNativeTaskbar\(log\)/)
    expect(code).toMatch(/if \(decision\.engage\) reassertRetractAutoHide\(log\)/)
    expect(code).toMatch(/'taskbar-native-reassert'/)
  })

  it('轮询节奏单一常量（NATIVE_WATCH_POLL_MS，票面 1–2s 低频档；纯值在 native-watch.ts）', () => {
    expect(code).toMatch(/setInterval\(pollNativeWatch, NATIVE_WATCH_POLL_MS\)/)
    expect(srcOf(WATCH)).toMatch(/export const NATIVE_WATCH_POLL_MS = 1000/)
  })

  it('重申置位住在 appbar-autohide.ts：账不动（不新记 previous、不复位 engaged），无账按完整置位走', () => {
    const src = codeOf(AUTOHIDE)
    expect(src).toMatch(/export function reassertRetractAutoHide\(/)
    expect(src).toMatch(/retractAutoHideState\(previous\)/) // 目标值仍从账面 previous 派生
    expect(src).toMatch(/engageRetractAutoHide\(log\)/) // 无账（入场置位失败）的恢复路径
  })

  it('观察面一次采齐：句柄+可见性走 native.ts 单一来源（nativeTaskbarView），置位读回走 getAppBarState', () => {
    expect(codeOf(NATIVE)).toMatch(/export function nativeTaskbarView\(/)
    expect(code).toMatch(/nativeTaskbarView\(\)/)
    expect(code).toMatch(/getAppBarState\(\)/)
  })

  it('裁决归 NativeReassertMachine 单一实现（控制器不自判重建/翻转——观察喂机器、照单执行）', () => {
    expect(code).toMatch(/new NativeReassertMachine\(\)/)
    expect(code).toMatch(/\.machine\.poll\(/)
    expect(code).not.toMatch(/IsWindowVisible/) // FFI 不进控制器（观察收口 native.ts）
  })
})

describe('分屏会话接线（工单269，spec #267；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const SNAP = 'app/src/main/taskbar/snap.ts'
  const code = codeOf(CTRL)
  const snapCode = codeOf(SNAP)

  it('会话事实喂进三态裁决：控制器在收栏轮询接缝上调分屏探针并传 snapSessionActive（spec 决策 3）', () => {
    expect(code).toMatch(/snapSessionActive:\s*snap\.active/)
    // 探针调用与轮询同缝（resolveBarMode 输入装配段内），主屏会话按显示器参数裁决
    const m = code.match(/const snap = [^\n]*\n[\s\S]{0,600}?resolveBarMode\(\{/)
    expect(m).toBeTruthy()
    expect(code).toMatch(/resolveSnapSession\(/)
    expect(code).toMatch(/primaryPhysRect\(\)/)
  })

  it('会话事实翻转落存证（可观测分屏会话建立/结束，spec 用户故事 42）：名 taskbar-snap-session', () => {
    expect(code).toMatch(/'taskbar-snap-session'/)
    // 只在事实变化时落（每 250ms 拍不刷屏——同 plan.evidence 的幂等纪律）：账本比对后写
    expect(code).toMatch(/snapSessionLedger/)
  })

  it('探针失败按「无会话」处理（还原是安全方向）：分屏探针包 try/catch，异常不拦轮询', () => {
    const m = snapCode.match(/try\s*\{[\s\S]{0,400}?catch/)
    expect(m).toBeTruthy()
    expect(code).toMatch(/pollSnapSession/)
  })

  it('真 Snap 探针绑定 user32 的 IsWindowArranged（公共 API），模块加载不触 FFI（lazy-bind 先例）', () => {
    expect(snapCode).toMatch(/IsWindowArranged/)
    // lazy-bind：koffi 只在 bind() 内 require（yield.ts / windows.ts 同款），顶层零 FFI
    const top = snapCode.slice(0, snapCode.indexOf('function bind('))
    expect(top).not.toMatch(/koffi\.load|require\('koffi'\)/)
    expect(snapCode).toMatch(/require\('koffi'\)/)
  })

  it('识别不可用严格降级（spec 决策 11）：IsWindowArranged 声明期抛错被 try/catch 收编为不可用事实', () => {
    // 声明包 try/catch——缺失符号同步抛错（域笔记实机实证），失败置空走「无会话」
    const m = snapCode.match(/try\s*\{[^}]*IsWindowArranged[^}]*\}\s*catch/)
    expect(m).toBeTruthy()
  })

  it('无补齐路径（工单268 定谳：Windows 自动重排）——分屏模块与控制器不调任何窗口移动/改窗接口', () => {
    for (const banned of [/SetWindowPos/, /MoveWindow/, /ShowWindow\(/]) {
      expect(snapCode.match(banned), `snap.ts 含 ${banned}`).toBeNull()
    }
    // 控制器新增的分屏段（pollSnapSession 定义）不含改窗调用
    const seg = code.slice(code.indexOf('pollSnapSession'), code.indexOf('pollSnapSession') + 900)
    expect(seg).not.toMatch(/SetWindowPos|MoveWindow|setBounds/)
  })

  it('成员资格裁决单一实现住在 snap.ts（对齐 planBarTransition 的单一实现纪律）', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export function (isSnapSessionMember|resolveSnapSession)\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual([SNAP])
  })
})
