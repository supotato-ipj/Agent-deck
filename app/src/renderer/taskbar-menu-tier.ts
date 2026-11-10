// 托盘档位菜单域适配器（工单196）：五面迁移之四——右组空白/托盘「⋯」右键的档位菜单
// （托盘 3/5/8/全部，工单162 条目集不变）从「pill 内横排」迁入弹窗通路。行集 =
// taskbarTierMenuPopupRows（四档恒在列、当前档 ✓ 前缀，id=tier-<limit> 承接横排退役前
// 几何存证 data-id 身份口径）。行动作 = 存证先行（taskbar-tray-overflow-limit，事件存证
// 名不变）+ 既有分发殿后（dispatchTrayOverflowLimit——校验与持久化在内核），回执事件
// taskbar-tray-overflow-limit-result 在浮层隐藏后照落（窗常驻，55 电池 P7 臂6/7 断言面）。
// 选档后的名单重拆由回推的 taskbar/changed 驱动（「⋯」在/不在随档位即时进出）。
// 工单462 增「常驻管理」节（只增节，档位四行条目集与关层纪律逐字不变）：四档行后追加
// 全部当前托盘图标（栏内+溢出内并集 = 完整名单，到达序）逐枚一行——taskbarPinnedMenuPopupRows
// （id=pin:<key> 供动作寻址、名单内 ✓ 前缀）；点行 = 存证先行（taskbar-tray-pinned）+
// dispatchTrayPinned 殿后（匹配先标识后名字在内核），勾选连击不逐次关层（keepOpenOnRow），
// ✓ 态随 taskbar/changed 回推重渲。托盘图标右键继续透传应用自带菜单（ADR-0013）——
// 常驻入口只在档位菜单。
import { dispatchTrayOverflowLimit, dispatchTrayPinned, taskbarPinnedMenuPopupRows, taskbarTierMenuPopupRows, taskbarViewModel } from './taskbar-view.js'
import { trayPinnedMatch, trayPinnedMatcher } from '../shared/overflow.js'
import type { TaskbarTrayOverflowLimit } from '../shared/contract'
import type { TaskbarState } from '../shared/contract'

/** 档位行身份 → 档位值（id = tier-<limit>；all 字面量档同款） */
function limitOf(id: string): TaskbarTrayOverflowLimit | null {
  if (id === 'tier-3') return 3
  if (id === 'tier-5') return 5
  if (id === 'tier-8') return 8
  if (id === 'tier-all') return 'all'
  return null
}

/** 常驻行身份 → 托盘条目（id = pin:<key>）：当拍 state 快照缓存于 rows()——开层间隙
 * 图标退场 = 找不到条目，噪声行不分发（与档位未知行同一纪律）。 */
function pinnedEntryOf(state: TaskbarState | null, id: string) {
  if (!state || !id.startsWith('pin:')) return null
  const key = id.slice(4)
  return state.tray.find((e) => e.key === key) ?? null
}

/** 当拍 state 快照（rows() 刷新）：常驻行的条目寻址与勾选态判据；菜单面单窗单适配器，
 * 模块级缓存即当拍（工单196 行集自足纪律的延伸——开层请求不携带行集）。 */
let stateCache: TaskbarState | null = null

export const tierMenuAdapter = {
  readyEvent: 'taskbar-tier-menu-ready',
  closeEvent: 'taskbar-tier-menu-close',
  rows(state: TaskbarState) {
    if (!state.enabled) return null
    stateCache = state
    const vm = taskbarViewModel(state)
    return [
      ...taskbarTierMenuPopupRows(vm.trayOverflowLimit),
      ...taskbarPinnedMenuPopupRows(vm.tray, vm.trayPinned),
    ]
  },
  onRow(row: { id: string; label: string }) {
    // 常驻管理节（工单462）：勾选态按当拍名单匹配取反，存证先行 + 分发殿后（档位行同型）
    const entry = pinnedEntryOf(stateCache, row.id)
    if (entry) {
      const vm = taskbarViewModel(stateCache!)
      const next = !trayPinnedMatcher(vm.trayPinned)(entry)
      // 连击本地先记账：勾击快于 taskbar/changed 回推时 stateCache 还是旧快照，第二击
      // 从旧名单重算出同向 next、被内核同名单幂等空转吞掉（快速双击=单次生效）。就地
      // 增删该记录（滤除口径与内核 setTrayPinned 同一份 trayPinnedMatch——先标识后名字
      // 全摘、按需补回），本地账先行，回推到达时 rows() 整拍刷新自愈。
      const rest = vm.trayPinned.filter((r) => !trayPinnedMatch(r, entry))
      stateCache!.trayPinned = next ? [...rest, { id: entry.key, name: entry.tooltip }] : rest
      window.deck.host.notify('taskbar-tray-pinned', { key: entry.key, name: entry.tooltip, pinned: next })
      void dispatchTrayPinned(window.deck.bridge, entry.key, entry.tooltip, next)
        .then((s) => window.deck.host.notify('taskbar-tray-pinned-result', { key: entry.key, pinned: next, ok: s !== null }))
      return
    }
    const limit = limitOf(row.id)
    if (limit === null) return // 未知行身份是噪声：不分发（菜单层只有四档固定行）
    // 存证名不变（55 电池事件面断言存活）；分发与迁移前条带内行点击同一道（内核裁决）
    window.deck.host.notify('taskbar-tray-overflow-limit', { limit })
    void dispatchTrayOverflowLimit(window.deck.bridge, limit)
      .then((s) => window.deck.host.notify('taskbar-tray-overflow-limit-result', { limit, ok: s !== null }))
  },
  keepOpenOnRow(row: { id: string; label: string }) {
    return row.id.startsWith('pin:') // 勾选连击不关层；四档行照旧点行即收
  },
}
