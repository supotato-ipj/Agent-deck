// 最大化收栏主进程编排（工单241，spec #236；工单308 M1 覆盖式普通档改钉）：三态机接线
// + 真最大化探针 + 栏面迁移计划 + 浮层收拢 + 存证命名族。
//
// M1（工单308，spec #306）钉面变化：
//   - 迁移计划收敛为**栏面计划**（hideWindow/showWindow/closePopups/evidence）——工作区
//     占位面（releaseAppBar/claimAppBar/targetWorkspaceRetracted）、解耦上下文
//     （BarTransitionContext/retractHeld/gateDisqualified）与 appbar 动作字段全部退役；
//   - 控制器无 AppBar 注册/注销/协商调用点（create 无注册、三态轮询无条件起、
//     destroy/closed 无注销）；托管建立=置位一次、运行期零 appbar 拍动；
//   - 宿主矩形复核（verifyStripBottom/复核纯函数族）随触发前提消失整体特征退役，
//     几何漂移兜底归 keepalive reassertGeometry；
//   - 重申轮询目标态恒 autohide-on（want 退役）、reassertTakeoverAutoHide 单参恒置位。
//
// 接缝（本票离线可测的两处公开边界）：
//   ① 纯函数缝：shared/retract.ts 的 planBarTransition（旧态 → 新态 → 动作计划）。
//      三态迁移的动作集合是纯裁决，可穷举；效果层（Electron 控制器）离线不可测，
//      其接线要点以源码级守卫钉住（见「控制器接线」组）。
//   ② 契约缝：shared/contract.ts 的 taskbar/bar-mode 桥接事件（下发三态给条带渲染层）。
//
// 术语（GLOSSARY #246 入册）：最大化收栏 / 唤出条 / 最大化让位 / 托盘右键让位。
// M1 下「最大化让位」（窗给栏让位）语义随占位退役——普通档自绘栏覆盖式常驻，窗尺寸
// 永不被改变；「最大化收栏」（栏给窗让位）= 栏面退场出唤出条，进出零 appbar 动作。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ABS_ALWAYSONTOP, ABS_AUTOHIDE, planBarTransition, retractAutoHideState } from '../../src/shared/retract'
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
/** 去注释的源码（散文提及不算用法）；读盘/剥注释按文件缓存——多个守卫逐文件扫全树，
 *  并行跑全量时重复读盘会把 5s 默认超时烧掉（工单310 增文件后真机轮实证） */
const CODE_CACHE = new Map<string, string>()
function codeOf(rel: string): string {
  const hit = CODE_CACHE.get(rel)
  if (hit !== undefined) return hit
  const code = srcOf(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  CODE_CACHE.set(rel, code)
  return code
}

describe('三态迁移的栏面动作计划（工单241 纯函数缝；工单308 M1 收敛为栏面计划）', () => {
  it('常驻 → 收栏：收拢浮层；条带窗不隐藏（承载形态 = 栏窗复用）；存证 taskbar-retract', () => {
    const plan = planBarTransition('visible', 'maximize-retract')
    expect(plan.closePopups).toBe(true)
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract'])
  })

  it('收栏 → 常驻：栏面复现（条带窗既不隐也不显——恒在场）；存证 taskbar-retract-lifted', () => {
    const plan = planBarTransition('maximize-retract', 'visible')
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.closePopups).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted'])
  })

  it('常驻 → 全屏让位：整窗退场（隐藏）+ 收拢浮层；存证沿用既有 taskbar-yield 名', () => {
    const plan = planBarTransition('visible', 'fullscreen-yield')
    expect(plan.hideWindow).toBe(true)
    expect(plan.showWindow).toBe(false)
    expect(plan.closePopups).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield'])
  })

  it('全屏让位 → 常驻：整窗复现；存证沿用既有 taskbar-yield-lifted 名', () => {
    const plan = planBarTransition('fullscreen-yield', 'visible')
    expect(plan.showWindow).toBe(true)
    expect(plan.hideWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted'])
  })

  it('全屏让位 → 收栏：窗复现 + 收拢浮层；两族存证各一条（先退出旧态、再进入新态）', () => {
    const plan = planBarTransition('fullscreen-yield', 'maximize-retract')
    expect(plan.showWindow).toBe(true)
    expect(plan.closePopups).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted', 'taskbar-retract'])
  })

  it('收栏 → 全屏让位：整窗退场 + 收拢浮层；先 retract-lifted（退出旧态）再 yield（进入新态）', () => {
    const plan = planBarTransition('maximize-retract', 'fullscreen-yield')
    expect(plan.hideWindow).toBe(true)
    expect(plan.closePopups).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted', 'taskbar-yield'])
  })

  it('同态 → 同态：零动作、零存证（幂等——每拍轮询不重复落账）', () => {
    for (const mode of MODES) {
      const plan = planBarTransition(mode, mode)
      expect(plan).toEqual({
        hideWindow: false,
        showWindow: false,
        closePopups: false,
        evidence: [],
      })
    }
  })

  it('M1 计划形状收敛：计划只有栏面四字段——无任何 appbar/工作区字段（占位链退役后计划不再承载动作）', () => {
    for (const prev of MODES) {
      for (const next of MODES) {
        const plan = planBarTransition(prev, next)
        expect(Object.keys(plan).sort(),
          `${prev} → ${next}`).toEqual(['closePopups', 'evidence', 'hideWindow', 'showWindow'])
      }
    }
  })

  it('E4 粘性：收栏态不因「窗口矩形恰好覆盖整屏」的副作用而翻成让位（真最大化优先，归 resolveBarMode）', () => {
    // 迁移计划自身不重判档位：收栏 → 收栏恒零动作
    const plan = planBarTransition('maximize-retract', 'maximize-retract')
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.evidence).toEqual([])
  })

  it('不变量（6 格真实迁移矩阵）：hideWindow ⟺ next=让位、showWindow ⟺ prev=让位、closePopups ⟺ next≠常驻；evidence 按族随栏面迁移', () => {
    for (const prev of MODES) {
      for (const next of MODES) {
        if (prev === next) continue // 同态零动作已单钉（上一组）——本组钉真实迁移的不变量
        const plan = planBarTransition(prev, next)
        const tag = `${prev} → ${next}`
        expect(plan.hideWindow, tag).toBe(next === 'fullscreen-yield')
        expect(plan.showWindow, tag).toBe(prev === 'fullscreen-yield')
        expect(plan.closePopups, tag).toBe(next !== 'visible')
        // 存证族（同态零存证已单钉）：retract 族随收栏栏面、yield 族随让位栏面；
        // 顺序恒「退出旧态在前、进入新态在后」
        expect(plan.evidence.includes('taskbar-retract'), tag).toBe(next === 'maximize-retract' && prev !== next)
        expect(plan.evidence.includes('taskbar-retract-lifted'), tag).toBe(prev === 'maximize-retract' && prev !== next)
        expect(plan.evidence.includes('taskbar-yield'), tag).toBe(next === 'fullscreen-yield' && prev !== next)
        expect(plan.evidence.includes('taskbar-yield-lifted'), tag).toBe(prev === 'fullscreen-yield' && prev !== next)
        expect(plan.evidence.length, tag).toBeLessThanOrEqual(2)
        const liftIdx = plan.evidence.findIndex((e) => e.endsWith('-lifted'))
        const enterIdx = plan.evidence.findIndex((e) => !e.endsWith('-lifted') && (e === 'taskbar-retract' || e === 'taskbar-yield'))
        if (liftIdx >= 0 && enterIdx >= 0) expect(liftIdx, `${tag} 先退出旧态`).toBeLessThan(enterIdx)
      }
    }
  })
})

describe('M1 托管期零拍动（工单308，spec #306）：迁移计划与 appbar 托管解耦', () => {
  it('进出收栏/让位的任何迁移都不携带 appbar 动作——托管建立=置位一次（engage）、运行期零写入由形状穷举钉住', () => {
    // 旧计划的 engageAutoHide/clearAutoHide/releaseAppBar/claimAppBar 已随接口退役：
    // 上组「计划只有栏面四字段」即形状穷举；本组补一行可读断言（防御字段回潮）
    for (const prev of MODES) {
      for (const next of MODES) {
        const plan = planBarTransition(prev, next) as unknown as Record<string, unknown>
        for (const banned of ['releaseAppBar', 'claimAppBar', 'engageAutoHide', 'clearAutoHide', 'targetWorkspaceRetracted']) {
          expect(banned in plan, `${prev}→${next} 不得携带 ${banned}`).toBe(false)
        }
      }
    }
  })

  it('收栏置位的目标 appbar 状态（接管建立/重申的唯一目标，值函数保留）：保留 ALWAYSONTOP、加 ABS_AUTOHIDE', () => {
    expect(retractAutoHideState(0)).toBe(ABS_AUTOHIDE)
    expect(retractAutoHideState(ABS_ALWAYSONTOP)).toBe(ABS_AUTOHIDE | ABS_ALWAYSONTOP)
    // 用户本已开启自动隐藏：置位为无操作（结果不变——记账照走、复原照走，逻辑不特判）
    expect(retractAutoHideState(ABS_AUTOHIDE)).toBe(ABS_AUTOHIDE)
    expect(retractAutoHideState(ABS_AUTOHIDE | ABS_ALWAYSONTOP)).toBe(ABS_AUTOHIDE | ABS_ALWAYSONTOP)
  })

  it('ABS_* 常量与 Win32 shellapi 对齐（探针同款：AUTOHIDE=0x1 ALWAYSONTOP=0x2）', () => {
    expect(ABS_AUTOHIDE).toBe(0x1)
    expect(ABS_ALWAYSONTOP).toBe(0x2)
  })

  it('普通栏态清位目标值函数已退役（normalBarAutoHideState 不复存在于纯模块）', () => {
    expect(srcOf('app/src/shared/retract.ts')).not.toMatch(/normalBarAutoHideState/)
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

describe('控制器接线（工单241 三态机；工单308 M1 改钉；效果层离线不可测，以源码级守卫钉住）', () => {
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

  it('M1 占位链退役：registerAppBar/removeAppBar/negotiateAppBarPos/appBarCallbackMessage/ABN_POSCHANGED 在 app/src 零调用点（appbar.ts 定义体保留至 L2 清场）', () => {
    for (const sym of ['registerAppBar', 'removeAppBar', 'negotiateAppBarPos', 'appBarCallbackMessage', 'ABN_POSCHANGED']) {
      const hits: string[] = []
      for (const rel of SRC_FILES) {
        if (rel === 'app/src/main/taskbar/appbar.ts') continue // 定义体（FFI 面保留，L2 退役）
        if (new RegExp(`\\b${sym}\\b`).test(codeOf(rel))) hits.push(rel)
      }
      expect(hits, `${sym} 调用点必须为空`).toEqual([])
    }
    // 控制器不再 import 任何 AppBar 注册面
    expect(code).not.toMatch(/registerAppBar|removeAppBar|negotiateAppBarPos|appBarCallbackMessage|ABN_POSCHANGED/)
  })

  it('三态轮询无条件起（M1：不再寄居 AppBar 注册成功支内——create 即建轮询）', () => {
    // 轮询装配在 create 内、且不再有任何 registerAppBar 条件分支包裹
    expect(code).toMatch(/s\.yieldTimer = setInterval/)
    expect(code).not.toMatch(/if \(registerAppBar/)
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

  it('存证 payload 收紧（M1）：retract/yield 族事件不再携带 appBar 占位维度', () => {
    // 存证循环只剩 mode/from/foreground 三维
    expect(code).toMatch(/for \(const type of plan\.evidence\) log\?\.append\(\{ type, mode: next, from: prev, foreground \}\)/)
    expect(code).not.toMatch(/appBar:/)
  })

  it('轮询与全屏让位共用 250ms 节奏（单一 YIELD_POLL_MS，只有一处轮询用它）', () => {
    expect(code).toMatch(/const YIELD_POLL_MS = 250/)
    expect(code.match(/\bYIELD_POLL_MS\b/g)?.length ?? 0).toBe(2) // 定义 + 轮询一处（TRAY_YIELD_POLL_MS 是另一档）
  })

  it('降级档机制退役（M1）：appBarDegraded 与净空常量在 app/src 零残留', () => {
    expect(code).not.toMatch(/appBarDegraded/)
    for (const rel of SRC_FILES) {
      expect(codeOf(rel).includes('TASKBAR_BOTTOM_CLEARANCE'), `${rel} 残留净空常量`).toBe(false)
    }
  })

  it('条带恒贴屏底（M1 覆盖式常驻）：stripBounds 无净空参数', () => {
    const sb = code.match(/function stripBounds\(\)[^{]*\{[\s\S]{0,400}?\n\}/)
    expect(sb).toBeTruthy()
    // 无 clearance 入参与减法（净空机制随降级档退役）
    expect(sb?.[0]).not.toMatch(/clearance/)
  })

  it('收栏态不动条带几何（唤出条要贴屏底；条带矩形与回正目标保持同位，守卫不打架）', () => {
    // 档位迁移只做「显隐 / 浮层 / 下发」三类动作，不碰窗口位置
    const machine = code.slice(code.indexOf('applyBarMode'), code.indexOf('applyBarMode') + 3000)
    expect(machine).not.toMatch(/setBounds|setPosition/)
  })

  it('同态零动作（不变量③）：applyBarMode 同态拍直接早退——M1 无工作区交割例外', () => {
    expect(code).toMatch(/if \(prev === next\) return/)
  })

  it('迁移计划两参消费（M1：解耦上下文退役）——旧三参形态与工作区账不得残留', () => {
    expect(code).toMatch(/planBarTransition\(\s*prev,\s*next\s*\)/)
    expect(code).not.toMatch(/planBarTransition\(\s*prev,\s*next,/)
    expect(code).not.toMatch(/workspaceRetracted/)
    expect(code).not.toMatch(/gateDisqualified/)
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

describe('原生栏托管接线（工单260 起步；工单308 M1 恒置位改钉；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const AUTOHIDE = 'app/src/main/taskbar/appbar-autohide.ts'
  const APPBAR = 'app/src/main/taskbar/appbar.ts'
  const code = codeOf(CTRL)

  it('applyBarMode 零 appbar 动作（M1）：进出收栏无置位/清位/注销/重注册调用——托管期零拍动的编排面', () => {
    expect(code).not.toMatch(/enterRetractAutoHide|clearRetractAutoHide|engageAutoHide|clearAutoHide/)
    // 托管动作只剩 create 的建立与 destroy 的退场两处
    expect(code.match(/engageTakeoverAutoHide\(/g)?.length ?? 0).toBe(1)
    expect(code.match(/restoreTakeoverAutoHide\(/g)?.length ?? 0).toBe(1)
  })

  it('宿主矩形复核机制整体特征退役（工单308 M1）：verifyStripBottom 与复核纯函数族零残留，几何漂移兜底归 keepalive reassertGeometry', () => {
    for (const rel of SRC_FILES) {
      const c = codeOf(rel)
      expect(c.includes('verifyStripBottom'), `${rel} 残留 verifyStripBottom`).toBe(false)
      expect(c.includes('recheckStripHostRect'), `${rel} 残留复核判据`).toBe(false)
      expect(c.includes('stepHostRectSettle'), `${rel} 残留拍子推进`).toBe(false)
      expect(c.includes('HOST_RECT_'), `${rel} 残留拍常量`).toBe(false)
    }
    // keepalive 回正守卫保留（M1 下兜几何漂移的唯一几何账）
    expect(code).toMatch(/reassertGeometry\(s, 'keepalive'\)/)
    expect(code).toMatch(/reassertGeometry\(s, 'shown'\)/)
  })

  it('回正目标单一来源（M1）：negotiated 由 stripBounds() 建账（create 与 display-metrics 两处），无协商/降级写账路径', () => {
    expect(code.match(/s\.negotiated = stripBounds\(\)/g)?.length).toBe(2)
    expect(code).not.toMatch(/applyNegotiated|applyDegradedClearance|renegotiate\(/)
  })

  it('display-metrics 无条件重排（M1）：改分辨率即重排条带到新屏底、刷新回正目标', () => {
    const m = code.match(/const onDisplayMetrics = \(\) => \{[\s\S]{0,500}?\n  \}/)
    expect(m).toBeTruthy()
    expect(m?.[0]).toMatch(/stripBounds\(\)/)
    expect(m?.[0]).toMatch(/setBounds\(bounds\)/)
  })

  it('销窗路径（destroy）也复原：面板退出/禁用都把用户原值还回去（还原路径①扩展）', () => {
    expect(code).toMatch(/restoreTakeoverAutoHide\(log, reason\)/)
    // destroy 内的复原先于会话判空（与 hidNative 还原同一位置纪律——账不随窗生灭）
    const m = code.match(/const destroy = \(reason: string\) => \{[\s\S]{0,600}?restoreTakeoverAutoHide\(log, reason\)/)
    expect(m).toBeTruthy()
    // appbar 复原**先于可见性复原**（顺序即行为，与守卫/守护径同源——restore-ledger-wiring
    // 的钉序理由）：置位态下 WS_VISIBLE 位可被 explorer 翻开，可见性判据会被「已可见」
    // 骗成静默；先卸置位，可见性复原才做真工作（51 电池 P9 的面板侧径）
    const d = code.slice(code.indexOf('const destroy'))
    const iAppbar = d.indexOf('restoreTakeoverAutoHide(log, reason)')
    const iShow = d.indexOf('showNativeTaskbar(log, reason)')
    expect(iAppbar).toBeGreaterThanOrEqual(0)
    expect(iShow).toBeGreaterThanOrEqual(0)
    expect(iAppbar).toBeLessThan(iShow)
  })

  it('注销调用点退役（M1）：destroy/closed 无 removeAppBar（占位登记不复存在）', () => {
    expect(code).not.toMatch(/removeAppBar/)
  })

  it('置位/复原的 RAII 实现单一实现住在 appbar-autohide.ts（记账 + 读回验证 + 退避复原）', () => {
    const src = codeOf(AUTOHIDE)
    expect(src).toMatch(/export function engageTakeoverAutoHide\(/)
    expect(src).toMatch(/export function restoreTakeoverAutoHide\(/)
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

describe('原生栏重申轮询接线（工单262，spec #258；工单308 M1 目标态恒置位改钉；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const AUTOHIDE = 'app/src/main/taskbar/appbar-autohide.ts'
  const WATCH = 'app/src/main/taskbar/native-watch.ts'
  const NATIVE = 'app/src/main/taskbar/native.ts'
  const code = codeOf(CTRL)

  it('值守起止随接管生灭（双缺陷复审 Q1/Q2 改段）：create 即建接管并起表、destroy 停表；M1 下轮询与档位迁移彻底无关（无工作区账可派生 want）', () => {
    // 起表与建立接管同处（create），先建接管再起表：重申机器以「刚置位过的当拍事实」立基线
    const m = code.match(/engageTakeoverAutoHide\(log\)\s*startNativeWatch\(s\)/)
    expect(m).toBeTruthy()
    // 档位迁移里不得再起停轮询（旧「随工作区收栏账起停」语义作废）
    expect(code).not.toMatch(/if \(s\.workspaceRetracted\) startNativeWatch\(s\)/)
    expect(code).not.toMatch(/else stopNativeWatch\(s\)/)
  })

  it('销窗路径（destroy）停表：禁用/退役/退出不悬空轮询（同 hidNative 复原的位置纪律）', () => {
    const m = code.match(/const destroy = \(reason: string\) => \{[\s\S]{0,600}?stopNativeWatch/)
    expect(m).toBeTruthy()
  })

  it('外部先销窗路径（closed）同样停表（迟到的 interval 不许悬空——同 stopYieldPoll 位置纪律）', () => {
    const m = code.match(/stopYieldPoll\(s\)[\s\S]{0,300}?stopNativeWatch\(s\)/)
    expect(m).toBeTruthy()
  })

  it('一拍裁决照单执行（M1 单参）：hide → hideNativeTaskbar、autoHide 非空 → reassertTakeoverAutoHide（恒置位）、归因落 taskbar-native-reassert 存证', () => {
    expect(code).toMatch(/if \(decision\.hide\) hideNativeTaskbar\(log\)/)
    // M1：执行面无第二份档位账——重申恒置位，目标态唯一
    expect(code).toMatch(/if \(decision\.autoHide !== null\) reassertTakeoverAutoHide\(log\)/)
    expect(code).not.toMatch(/reassertTakeoverAutoHide\(log,/)
    // 目标态恒 autohide-on：机器 poll 单参（want 随接口退役），'autohide-off' 全 src 零残留
    expect(code).toMatch(/machine\.poll\(probe\)/)
    for (const rel of SRC_FILES) {
      expect(codeOf(rel).includes('autohide-off'), `${rel} 残留 autohide-off 支`).toBe(false)
      expect(codeOf(rel).includes('NativeWatchWant'), `${rel} 残留 NativeWatchWant`).toBe(false)
    }
    expect(code).toMatch(/'taskbar-native-reassert'/)
  })

  it('轮询节奏单一常量（NATIVE_WATCH_POLL_MS，票面 1–2s 低频档；纯值在 native-watch.ts）', () => {
    expect(code).toMatch(/setInterval\(pollNativeWatch, NATIVE_WATCH_POLL_MS\)/)
    expect(srcOf(WATCH)).toMatch(/export const NATIVE_WATCH_POLL_MS = 1000/)
  })

  it('重申住在 appbar-autohide.ts（M1 恒置位形态）：账不动（不新记 userState）、写入目标恒 retractAutoHideState、无档位字段', () => {
    const src = codeOf(AUTOHIDE)
    expect(src).toMatch(/export function reassertTakeoverAutoHide\(\s*log: EventLog \| null,\s*\)/)
    // 目标值恒从账面 userState 派生（置位目标唯一）
    expect(src).toMatch(/writeAndRead\(retractAutoHideState\(e\.userState\)\)/)
    expect(src).toMatch(/engageTakeoverAutoHide\(log\)/) // 无账的恢复路径
    // M1 收紧：无 enter/clear、无档位账、无清位目标
    expect(src).not.toMatch(/enterRetractAutoHide|clearRetractAutoHide|TakeoverAutoHideMode|normalBarAutoHideState/)
    expect(src).not.toMatch(/e\.mode/)
  })

  it('engage 置位形态（M1 行为变化核心）：接管建立压 retractAutoHideState 目标，读回裁决落 set/-set-failed（复用收栏置位事件族——50 电池 A 相位前置与 51 电池谓词最小改写）', () => {
    const src = codeOf(AUTOHIDE)
    expect(src).toMatch(/writeAndRead\(retractAutoHideState\(userState\)\)/)
    expect(src).toMatch(/'taskbar-autohide-set'/)
    expect(src).toMatch(/'taskbar-autohide-set-failed'/)
    // 旧「接管即清位」事件形态零残留
    expect(src).not.toMatch(/taskbar-autohide-cleared|taskbar-autohide-clear-failed/)
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
    // 探针调用与轮询同缝（barInput 装配段内），主屏会话按显示器参数裁决
    const m = code.match(/const snap = [^\n]*\n[\s\S]{0,800}?resolveBarMode\(barInput\)/)
    expect(m).toBeTruthy()
    // 工单270：控制器收成员集合（snapSessionMembers，会话=成员非空），不再只折布尔
    expect(code).toMatch(/snapSessionMembers\(/)
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

describe('分屏会话集合生命周期接线（工单270，spec #267；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const SNAP = 'app/src/main/taskbar/snap.ts'
  const code = codeOf(CTRL)
  const snapCode = codeOf(SNAP)

  it('探针带成员追踪集：上一拍合格成员句柄喂回探针（最小化/解除的前成员照采事实，去向可分类）', () => {
    // 追踪集账本随拍更新——集合生命周期的「成员」而非「一次判定」是账面口径
    expect(code).toMatch(/probeSnapWindows\(snapMemberHwnds\)/)
    expect(code).toMatch(/snapMemberHwnds\s*=/)
  })

  it('会话结束因果分类单一实现住在 snap.ts，控制器只调用不另判', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export function classifySnapSessionEnd\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual([SNAP])
    expect(code).toMatch(/classifySnapSessionEnd\(/)
  })

  it('会话翻转存证带结束因果与理由接续（spec 决策 14 可观测）：cause / retractHeldByZoomed 字段落进 taskbar-snap-session', () => {
    expect(code).toMatch(/cause:\s*snap\.flip\.cause/)
    // retractHeldByZoomed 是收栏理由三谓词族在 M1 的唯一幸存者（zoomed 分量存证用）
    expect(code).toMatch(/retractHeldByZoomed:\s*retractHeldByZoomed\(barInput\)/)
    expect(code).not.toMatch(/retractHeldByZoomed:\s*mode\s*===/)
    // 存证落在档位裁决之后（理由接续读得到当拍档位）
    const iSnapProbe = code.indexOf('const snap = pollSnapSession()')
    const iResolve = code.indexOf('const mode = resolveBarMode(')
    const iSnapLog = code.indexOf("'taskbar-snap-session'")
    expect(iSnapProbe).toBeGreaterThanOrEqual(0)
    expect(iResolve).toBeGreaterThan(iSnapProbe)
    expect(iSnapLog).toBeGreaterThan(iResolve)
  })

  it('探针采集面扩展：追踪集参数 + cloak 分位（SHELL 位 = 其他虚拟桌面）', () => {
    expect(snapCode).toMatch(/track:\s*readonly number\[\]/)
    expect(snapCode).toMatch(/DWM_CLOAKED_SHELL/)
    expect(snapCode).toMatch(/cloakedShell/)
  })
})

describe('枚举/FFI 面双写防漂移守卫（工单271 评审收口④：单一来源收敛前的在案钉）', () => {
  // 现状：snap.ts 与 windows.ts 各持一份 Win32 枚举/绑定面（Bound 表、MAX_WINDOWS、
  // pidOf/exeOfPid 逐字双写）。收敛为单一来源（snap.ts 复用 windows.ts 的 Bound）前，
  // 本守卫钉住双写不漂移——改一份必须同步另一份（或顺势收敛）。traitsOf 刻意不在
  // 逐字守卫内：两份口径分叉是工单270 的裁决（windows.ts 布尔折叠 vs snap.ts cloak
  // 分位采集），不是漂移。
  const WIN = 'app/src/main/taskbar/windows.ts'
  const SNAP = 'app/src/main/taskbar/snap.ts'

  /** 抓取顶层函数全文（闭括号落在行首——两个文件的函数体收尾同形） */
  const grab = (src: string, fn: string): string | undefined =>
    src.match(new RegExp(`function ${fn}\\([^)]*\\):[^\\n]*\\{[\\s\\S]*?\\n\\}`))?.[0]

  it('pidOf / exeOfPid 双写逐字一致（exeOfPid 单一语义：OpenProcess+QueryFullProcessImageNameW+CloseHandle 配对）', () => {
    const win = srcOf(WIN)
    const snap = srcOf(SNAP)
    for (const fn of ['pidOf', 'exeOfPid']) {
      expect(grab(win, fn), `windows.ts 缺 ${fn}`).toBeTruthy()
      expect(grab(snap, fn), `snap.ts 缺 ${fn}`).toBeTruthy()
      expect(grab(snap, fn), `${fn} 双写漂移——两份必须逐字同步，或收敛为单一实现`).toBe(grab(win, fn))
    }
  })

  it('MAX_WINDOWS 枚举上限双写同值（2048——链式枚举的终止护栏不得两处分叉）', () => {
    expect(srcOf(WIN).match(/const MAX_WINDOWS = (\d+)/)?.[1]).toBe('2048')
    expect(srcOf(SNAP).match(/const MAX_WINDOWS = (\d+)/)?.[1]).toBe('2048')
  })
})

describe('收栏理由谓词族 M1 收口（工单271 解耦的退役面 + 保留面，工单308）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const FWD = 'app/src/main/taskbar/retract.ts'
  const code = codeOf(CTRL)

  it('zoomed 分量裁决单一实现住在 shared/retract.ts（retractHeldByZoomed），主进程侧经转发导出；工作区面两谓词（retractReasonHeld/retractGateDisqualified）全 src 零残留', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export\s+function\s+(retractReasonHeld|retractGateDisqualified|retractHeldByZoomed)\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual(['app/src/shared/retract.ts'])
    for (const rel of SRC_FILES) {
      const c = codeOf(rel)
      expect(c.includes('retractReasonHeld'), `${rel} 残留 retractReasonHeld`).toBe(false)
      expect(c.includes('retractGateDisqualified'), `${rel} 残留 retractGateDisqualified`).toBe(false)
    }
    expect(srcOf(FWD)).toMatch(/\bretractHeldByZoomed\b/)
    // 控制器不自算理由（pid/类名/zoomed 组合裁决不进效果层）——只经谓词取分屏存证分量
    expect(code).toMatch(/retractHeldByZoomed\(barInput\)/)
    // 不自己拿真最大化位做裁决（只允许进存证载荷——同工单241 组的判据形态）
    expect(code).not.toMatch(/if\s*\(\s*probe\.zoomed/)
    expect(code).not.toMatch(/probe\.zoomed\s*===/)
  })

  it('同缝装配：裁决输入对象装配一次，resolveBarMode 单点消费（工作区理由的同源消费随工作区面退役）', () => {
    const m = code.match(/const barInput = \{[\s\S]{0,700}?resolveBarMode\(barInput\)/)
    expect(m).toBeTruthy()
    // 工单269/253 既有输入位逐字保留（改装配不丢位）
    expect(code).toMatch(/snapSessionActive:\s*snap\.active/)
    expect(code).toMatch(/prevMode:\s*s\.mode/)
    expect(code).toMatch(/ownOverlayPresent:\s*openOverlayFamilies\.size > 0/)
    // M1：降级位不再是裁决输入（占位链退役）
    expect(code).not.toMatch(/appBarDegraded/)
  })
})
