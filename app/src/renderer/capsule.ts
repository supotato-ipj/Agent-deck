// 顶部窗口胶囊渲染层（工单376）：计数呈现——权威视图 = tiling/changed 推送的
// AgentTilingState（主进程 AgentTilingService 投影，GLOSSARY「顶部窗口胶囊」计数口径）。
//
// 工单378：右侧恢复按钮（始终可用）。点击经桥 tiling/restore（可信内核 UI 用户手势）
// 收回手动浮动、补入容量溢出、清除授权；结果（restored / skipped）在胶囊内短暂显示，
// 异常未平铺跳过数一并报告（GLOSSARY「恢复平铺」）。
// 工单379：胶囊主体点击 = 展开/收起横向窗口预览（preview/toggle；聚焦态由主进程改判为
// 「退出聚焦并恢复平铺」）。主体与恢复按钮同走 host.setHotZones 热区声明——其余区域
// 保持穿透（点击落到下方窗口）。
// 自诊断（条带页同款教训）：桥接失败在页内可见（胶囊显「-」并落 console——真机轮
// 的存证面能分辨「没跑」与「跑崩」）。
import type { AgentTilingState } from '../shared/contract'

const countEl = document.querySelector<HTMLSpanElement>('#cap-count')!
const capsuleEl = document.querySelector<HTMLDivElement>('#capsule')!
const statusEl = document.querySelector<HTMLSpanElement>('#cap-status')!
const restoreEl = document.querySelector<HTMLButtonElement>('#cap-restore')!

let statusTimer: ReturnType<typeof setTimeout> | null = null

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
  // 恢复按钮始终可用（GLOSSARY「顶部窗口胶囊」：右侧独立恢复图标任何状态下都在）；
  // 在途（点击后到回执）期间禁用防连点
  restoreEl.disabled = busy
}

let busy = false

function showStatus(text: string): void {
  statusEl.textContent = text
  statusEl.classList.add('show')
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    statusEl.classList.remove('show')
    statusTimer = null
  }, 3200)
}

/** 热区声明（CSS px = DIP，相对窗口客户区）：胶囊主体 + 恢复按钮接收点击，其余保持穿透。
 *  恢复按钮在前——重叠时热区命中序以先声明者为准（按钮是更小的命中区）。 */
function declareHotzones(): void {
  const body = capsuleEl.getBoundingClientRect()
  const r = restoreEl.getBoundingClientRect()
  window.deck.host.setHotZones([
    { id: 'restore', x: r.x, y: r.y, w: r.width, h: r.height },
    { id: 'body', x: body.x, y: body.y, w: body.width, h: body.height },
  ])
}

// 胶囊主体点击：展开/收起窗口预览（工单379）；聚焦态由主进程改判为退出聚焦
capsuleEl.addEventListener('click', (ev) => {
  if ((ev.target as HTMLElement | null)?.closest('#cap-restore')) return
  window.deck.host.notify('capsule-toggle-req', {})
  void window.deck.bridge
    .invoke('preview/toggle', null)
    .then((res) => window.deck.host.notify('capsule-toggle-res', { open: Boolean((res as { open?: boolean } | null)?.open) }))
    .catch((err) => console.error('[capsule] preview toggle failed', err))
})

restoreEl.addEventListener('click', async () => {
  if (busy) return
  busy = true
  restoreEl.disabled = true
  try {
    const res = await window.deck.bridge.invoke('tiling/restore', null) as {
      ok: boolean; restored: number; skipped: number
    }
    if (res && res.ok) showStatus(`恢复 ${res.restored}${res.skipped > 0 ? ` · 跳过 ${res.skipped}` : ''}`)
    else showStatus('恢复不可用')
  } catch (err) {
    console.error('[capsule] restore failed', err)
    showStatus('恢复失败')
  } finally {
    busy = false
    restoreEl.disabled = false
  }
})

// 初始一拍拉现值（建窗先于首帧推送的窗口期——先渲染再等推）
void (async () => {
  try {
    const initial = await window.deck.bridge.invoke('tiling/get-state', null)
    render(initial as AgentTilingState)
  } catch (err) {
    console.error('[capsule] initial get-state failed', err)
    render(null)
  }
  declareHotzones()
})()
window.deck.bridge.on('tiling/changed', (payload) => render(payload))
window.deck.host.beat()
setInterval(() => window.deck.host.beat(), 1000)
