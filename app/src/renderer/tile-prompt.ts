// 逐窗几何授权提示渲染层（工单378）：两个按钮 + Esc。hwnd 经页面查询参数寻址
// （主进程开窗时带 hwnd），决定经桥 tiling/authorize 回到服务层——服务层只认这个
// 内核 UI 的请求，非 prompt 阶段一律拒绝（不越级授权）。
// 语义（spec #369 决策 10）：确认 = 授权「下一次重新发起的操作」（本身不写几何不重排）；
// 取消 / Esc = 保持平铺。没有「以后不再提示」。
const params = new URLSearchParams(location.search)
const hwnd = Number(params.get('hwnd'))

const adjust = document.querySelector<HTMLButtonElement>('#btn-adjust')!
const keep = document.querySelector<HTMLButtonElement>('#btn-keep')!

let sent = false
async function decide(decision: 'confirm' | 'cancel'): Promise<void> {
  if (sent) return
  sent = true
  try {
    await window.deck.bridge.invoke('tiling/authorize', { hwnd, decision })
  } catch (err) {
    // 桥接失败在页内可见（真机轮能分辨「没跑」与「跑崩」）——提示窗随即由主进程收起
    console.error('[tile-prompt] authorize failed', err)
  }
  window.close()
}

adjust.addEventListener('click', () => { void decide('confirm') })
keep.addEventListener('click', () => { void decide('cancel') })
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    void decide('cancel')
  }
})
adjust.focus()
