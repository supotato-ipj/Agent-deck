'use strict';
// #103 缺陷① 验收触发器（accept 门禁，DECK_TASKBAR_BURST=1 时由 taskbar.js P10 拉起）：
// 在面板主进程内、同一 JS 任务连发两次 taskbar set-enabled。竞态机理：destroy() 同步
// 跑完后旧窗 closed 尚未发出（需事件循环轮转），同任务紧跟的 create() 建好新窗并把
// 控制器共享账（win/appBarHwnd/tracker/yieldTimer）指向新窗——随后落地的旧窗 closed
// 回调即「迟到者」。renderer 侧两桥写无论 await 串联还是背靠背都跨 IPC 任务（红轮
// 2026-10-11 实证：未修代码上 P10 照样绿，closed 在 ~2-5ms 内先落地），只有进程内
// 同任务连发能把竞态窗变成确定性。完成以 taskbar-burst-done 落 DECK_EVENT_LOG。
function run(ctx, log) {
  let settled = 0;
  const t = setInterval(() => {
    try {
      if (!ctx.taskbar || !ctx.taskbar.state().enabled) return
    } catch { return /* 服务未就绪，下拍再看 */ }
    // 等 2 拍再连发：让控制器首轮 create()（含 AppBar 注册）先稳定
    if (settled++ < 2) return
    clearInterval(t)
    try {
      ctx.taskbar.setEnabled(false)
      ctx.taskbar.setEnabled(true)
      log?.append({ type: 'taskbar-burst-done' })
    } catch (err) {
      log?.append({ type: 'taskbar-burst-failed', message: String(err && err.message) })
    }
  }, 1000)
}

module.exports = { run };
