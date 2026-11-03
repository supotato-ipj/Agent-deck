// 顶部窗口胶囊渲染层（工单376）：纯计数呈现——权威视图 = tiling/changed 推送的
// AgentTilingState（主进程 AgentTilingService 投影，GLOSSARY「顶部窗口胶囊」计数口径）。
// 本页无本地态、无交互面（整窗穿透）；预览展开/恢复按钮归后续工单。
// 自诊断（条带页同款教训）：桥接失败在页内可见（胶囊显「-」并落 console——真机轮
// 的存证面能分辨「没跑」与「跑崩」）。
import type { AgentTilingState } from '../shared/contract'

const countEl = document.querySelector<HTMLSpanElement>('#cap-count')!
const capsuleEl = document.querySelector<HTMLDivElement>('#capsule')!

function render(state: AgentTilingState | null): void {
  if (!state) {
    countEl.textContent = '-'
    return
  }
  // 非 Agent 桌面 / 开关关：胶囊不出场（显隐由主进程控制器销窗兜底，页内再钉一层）
  if (!state.available || state.current !== 'agent') {
    capsuleEl.hidden = true
    return
  }
  capsuleEl.hidden = false
  countEl.textContent = String(state.count)
}

// 初始一拍拉现值（建窗先于首帧推送的窗口期——先渲染再等推）
void (async () => {
  try {
    const initial = await window.deck.bridge.invoke('tiling/get-state', null)
    render(initial as AgentTilingState)
  } catch (err) {
    console.error('[capsule] initial get-state failed', err)
    render(null)
  }
})()
window.deck.bridge.on('tiling/changed', (payload) => render(payload))
window.deck.host.beat()
setInterval(() => window.deck.host.beat(), 1000)
