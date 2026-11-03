// Agent 平铺窗口范围投影（工单376，spec #369 决策 6「窗口归属过滤」）：在 win-facts
// 统一接缝的窗口事实之上做**纯裁决**——主屏平铺枚举（合格应用窗 × 主屏 × 当前桌面）
// 与任务栏当前桌面应用枚举是两个投影，本文件不改任务栏枚举（副屏应用仍在任务栏显示，
// 用户故事 25：「可见性」与「平铺管辖」分离）。胶囊计数口径同源：主屏全部合格窗口
// （含平铺、最小化、浮动与各类未平铺），排除副屏、面板自身、系统弹窗与其他桌面
// （用户故事 44/45、GLOSSARY「顶部窗口胶囊」）。
//
// 判据缺省口径（win-facts 两投影既有同款）：单点事实取不到按「未采集到该拒绝位」处理
// （不猜不重试）；身份取不到（空 exe / 空标题）按不合格处理——改窗与计数都无从寻址。
//
// 桌面归属判定：主判据 = 公开 VDM IsWindowOnCurrent（当前桌面即 Agent 桌面时 true 才
// 参与平铺）；补充判据 = DWM cloak SHELL 分位（其他虚拟桌面必 cloak，工单270 实证）。
// IsOnCurrent 不可判（null）时按兼容口径不因它拒绝（cloak 判据仍在场）——与 win-facts
// 「判据缺省通过」同款，不猜不重试。

import type { TileRect } from './tiling-plan'

/** 物理像素矩形（win-facts.PhysRect 同形——本层不 import 效果层，独立声明） */
export interface ScopeRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 一次窗口范围事实快照（采集面在 win-facts 接缝 + VDM 公开桥，编排层合成） */
export interface TileWindowFacts {
  hwnd: number
  /** 窗口属主进程 PID（工单383 稳定身份核对；取不到归 undefined——只按 exe 核对） */
  pid?: number
  /** 进程可执行文件绝对路径（取不到归 ''） */
  exe: string
  /** 窗口标题（空串 = 无窗口面/取不到） */
  title: string
  visible: boolean
  cloaked: boolean
  /** cloak SHELL 分位（其他虚拟桌面） */
  cloakedShell: boolean
  toolWindow: boolean
  owned: boolean
  appWindow: boolean
  /** 最小化（IsIconic——最小化窗仍计入胶囊计数，GLOSSARY 口径） */
  iconic: boolean
  /**
   * 可接受用户级改窗（GWL_STYLE WS_THICKFRAME 在位，工单377）：缺位 = 固定尺寸窗，
   * 平铺编排跳过写窗、直接异常分类（spec 决策 12「固定尺寸…进入异常未平铺」的
   * 预判据——不试写）。事实取不到（样式读失败归 0）按 false——异常化是跳过+报告，
   * 无破坏性，安全向。
   */
  resizable: boolean
  rect: ScopeRect
  /** 公开 VDM IsWindowOnCurrent（true/false/null——null = 不可判，不参与拒绝） */
  onCurrentDesktop: boolean | null
}

export type TileScopeKind =
  | { kind: 'tile' }
  | {
      kind: 'excluded'
      reason:
        | 'own-process' // 面板/任务栏/胶囊自家进程（决策 5 合格窗口排除规则）
        | 'not-visible' // 无可见样式位
        | 'cloaked' // 应用自 cloak（挂起 UWP 等）
        | 'other-desktop' // shell cloak 或 VDM 判非当前桌面
        | 'tool-or-popup' // 工具窗 / 有属主系统弹窗
        | 'no-identity' // 空 exe / 空标题
        | 'shell-host' // Shell 浮层宿主
        | 'off-main-screen' // 副屏（与主屏无正面积相交）
    }

/** exe 身份归一（taskbar/apps-plan.normalizeExe 同款口径：斜杠归一 + 小写比较） */
export function normalizeExe(exe: string): string {
  return exe.replace(/\//g, '\\').toLowerCase()
}

const SHELL_HOST_RE = /(?:^|\\)(?:startmenuexperiencehost|searchhost)\.exe$/i

/** 矩形正面积相交（副屏判否的安全方向：零矩形/取不到 = 不相交） */
export function intersectsMainScreen(rect: ScopeRect, primary: ScopeRect): boolean {
  const w = Math.min(rect.right, primary.right) - Math.max(rect.left, primary.left)
  const h = Math.min(rect.bottom, primary.bottom) - Math.max(rect.top, primary.top)
  return w > 0 && h > 0
}

/**
 * 单窗范围裁决（工单376）：判定一扇顶层窗口是否进入 Agent 主屏平铺/计数。
 * 拒绝理由按上述序取首个命中——计数排除面（用户故事 45）与平铺管辖面共用同一裁决，
 * 口径稳定（「数字反映真实工作规模」）。
 */
export function classifyTileWindow(
  w: TileWindowFacts,
  ownExes: readonly string[],
  primary: ScopeRect,
): TileScopeKind {
  const exe = normalizeExe(w.exe)
  if (exe && ownExes.map(normalizeExe).includes(exe)) return { kind: 'excluded', reason: 'own-process' }
  if (!w.visible) return { kind: 'excluded', reason: 'not-visible' }
  if (w.cloaked) return { kind: 'excluded', reason: 'cloaked' }
  if (w.cloakedShell || w.onCurrentDesktop === false) {
    return { kind: 'excluded', reason: 'other-desktop' }
  }
  if (w.toolWindow || (w.owned && !w.appWindow)) return { kind: 'excluded', reason: 'tool-or-popup' }
  if (!w.title || !w.exe) return { kind: 'excluded', reason: 'no-identity' }
  if (SHELL_HOST_RE.test(w.exe)) return { kind: 'excluded', reason: 'shell-host' }
  // 最小化窗豁免主屏相交判（工单377）：最小化窗矩形是经典的屏外哨兵位（-32000，
  // 不携带任何真实显示器信息），按矩形判会把最小化窗误判成副屏窗而踢出树——兄弟
  // 吸收随后让别的窗占它的格，违反 GLOSSARY「顶部窗口胶囊」/用户故事 19「最小化
  // 仍计数、保留窗格与顺序」。诚实口径：最小化窗的显示器归属从矩形不可观测，故按
  // 计入处理（保留窗格是硬语义，宁可多计不可错踢）。
  if (!w.iconic && !intersectsMainScreen(w.rect, primary)) {
    return { kind: 'excluded', reason: 'off-main-screen' }
  }
  return { kind: 'tile' }
}

/** 一拍范围投影结果：平铺/计数成员（按输入序 = z 序）与排除明细 */
export interface TileScopeProjection {
  /** 合格成员（含最小化——最小化仍计数并保留窗格） */
  members: TileWindowFacts[]
  /** 排除窗（hwnd + 理由——诊断与电池断言的账面） */
  excluded: Array<{ hwnd: number; reason: Extract<TileScopeKind, { kind: 'excluded' }>['reason'] }>
}

/** 批量投影（编排层每拍调用）：facts 序即 z 序（win-facts scanTopWindows 输出序） */
export function projectTileScope(
  facts: readonly TileWindowFacts[],
  ownExes: readonly string[],
  primary: ScopeRect,
): TileScopeProjection {
  const members: TileWindowFacts[] = []
  const excluded: TileScopeProjection['excluded'] = []
  for (const f of facts) {
    const verdict = classifyTileWindow(f, ownExes, primary)
    if (verdict.kind === 'tile') members.push(f)
    else excluded.push({ hwnd: f.hwnd, reason: verdict.reason })
  }
  return { members, excluded }
}

/**
 * 平铺区覆盖核查（计数与落格共用的几何口径）：成员当前矩形是否已被平铺区覆盖
 * （编排层 reconciliation 用——「窗口在目标几何」的等值判据，容差 tol 物理像素）。
 */
export function rectMatches(rect: ScopeRect, target: TileRect, tol = 1): boolean {
  return (
    Math.abs(rect.left - target.left) <= tol &&
    Math.abs(rect.top - target.top) <= tol &&
    Math.abs(rect.right - target.right) <= tol &&
    Math.abs(rect.bottom - target.bottom) <= tol
  )
}
