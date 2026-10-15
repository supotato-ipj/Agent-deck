// 托盘档位菜单域适配器（工单196）：五面迁移之四——右组空白/托盘「⋯」右键的档位菜单
// （托盘 3/5/8/全部，工单162 条目集不变）从「pill 内横排」迁入弹窗通路。行集 =
// taskbarTierMenuPopupRows（四档恒在列、当前档 ✓ 前缀，id=tier-<limit> 承接横排退役前
// 几何存证 data-id 身份口径）。行动作 = 存证先行（taskbar-tray-overflow-limit，事件存证
// 名不变）+ 既有分发殿后（dispatchTrayOverflowLimit——校验与持久化在内核），回执事件
// taskbar-tray-overflow-limit-result 在浮层隐藏后照落（窗常驻，55 电池 P7 臂6/7 断言面）。
// 选档后的名单重拆由回推的 taskbar/changed 驱动（「⋯」在/不在随档位即时进出）。
import { dispatchTrayOverflowLimit, taskbarTierMenuPopupRows, taskbarViewModel } from './taskbar-view.js'
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

export const tierMenuAdapter = {
  readyEvent: 'taskbar-tier-menu-ready',
  closeEvent: 'taskbar-tier-menu-close',
  rows(state: TaskbarState) {
    if (!state.enabled) return null
    return taskbarTierMenuPopupRows(taskbarViewModel(state).trayOverflowLimit)
  },
  onRow(row: { id: string; label: string }) {
    const limit = limitOf(row.id)
    if (limit === null) return // 未知行身份是噪声：不分发（菜单层只有四档固定行）
    // 存证名不变（55 电池事件面断言存活）；分发与迁移前条带内行点击同一道（内核裁决）
    window.deck.host.notify('taskbar-tray-overflow-limit', { limit })
    void dispatchTrayOverflowLimit(window.deck.bridge, limit)
      .then((s) => window.deck.host.notify('taskbar-tray-overflow-limit-result', { limit, ok: s !== null }))
  },
}
