'use strict';
// #103 缺陷① 验收触发器（accept 门禁，DECK_TASKBAR_BURST=1 时由 taskbar.js P10 拉起）。
// 触发演进（三轮红轮实证，2026-10-11）：
//  ① renderer 双桥写毫秒级串联——跨 IPC 任务，够不到；
//  ② 主进程同任务连发两次 setEnabled——destroy() 在 w.destroy() 前已同步清完共享账，
//     且本 Electron 版本 destroy() 路径的 closed 同步落地，旧窗回调落地时账已空、纯空转；
//  ③ 即本版：先给条带窗 post WM_CLOSE（走 close 管线——closed 在这条路径上**异步**发出，
//     这才是票面前提成立的形态），同任务紧跟 disable/enable 连发：close 管线的旧窗
//     closed 必然晚于新窗 create 落地，迟到回调撞上已指向新窗的共享账——缺陷①的
//     完整链条（外部关窗竞态快速重启，如 shell 强关条带 + agent 快速禁启）。
// 完成以 taskbar-burst-done 落 DECK_EVENT_LOG（WM_CLOSE 未找到窗则 burst-failed）。
const WM_CLOSE = 0x0010;
const TASKBAR_TITLE = 'DECK-TASKBAR';

function run(ctx, log) {
  let settled = 0;
  const t = setInterval(() => {
    try {
      if (!ctx.taskbar || !ctx.taskbar.state().enabled) return
    } catch { return /* 服务未就绪，下拍再看 */ }
    // 等 2 拍再触发：让控制器首轮 create()（含 AppBar 注册与页面加载）先稳定
    if (settled++ < 2) return
    clearInterval(t)
    const win32 = require('./win32');
    const GetWindowTextW = win32.koffi.load('user32.dll')
      .func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
    const titleOf = (h) => {
      const buf = Buffer.alloc(512);
      const n = GetWindowTextW(h, buf, 256);
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
      return s;
    };
    const strip = win32.topLevelWindows().find((h) => {
      try { return titleOf(h) === TASKBAR_TITLE && win32.threadIdOf(h).pid === process.pid } catch { return false }
    })
    if (!strip) {
      log?.append({ type: 'taskbar-burst-failed', message: 'WM_CLOSE 目标条带窗未找到' })
      return
    }
    win32.PostMessageW(strip, WM_CLOSE, 0, 0)
    try {
      ctx.taskbar.setEnabled(false)
      ctx.taskbar.setEnabled(true)
      log?.append({ type: 'taskbar-burst-done', hwnd: Number(strip) })
    } catch (err) {
      log?.append({ type: 'taskbar-burst-failed', message: String(err && err.message) })
    }
  }, 1000)
}

module.exports = { run };
