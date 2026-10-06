'use strict';
// 工单86 验收提示条：四块电池（主/托盘/任务栏/任务栏显隐）控制器身份的统一挂条点，
// 由 src/main/index.ts 的 --accept* 分发点调用。琥珀药丸驻留屏幕上中部「安全带」
// （y<48 DIP——面板全部内容与电池断言取样区自 y≥48 起），随控制器进程生灭自清：
// app.exit、崩溃、强杀全路径窗口随进程一起死，无需任何清理逻辑。
// 三条不干扰硬约束，改动前先读 docs/adr/0008-accept-hint-bar.md：
// 1. 点击穿透：setIgnoreMouseEvents——不拦用户键鼠，更不拦电池自己的 SendInput 合成输入；
// 2. 不抢焦点：focusable:false + showInactive——面板焦点与前台窗断言不受扰动；
// 3. 顶部安全带：y<48 且静态无动画——条不得移入任何断言取样区，不得改为动画形态。
// 纯提示定位（advisory）：不锁输入；用户不守提示导致的个别断言失败属固有风险。
const { BrowserWindow, screen } = require('electron');
const path = require('path');

function showAcceptHintBar() {
  try {
    const primary = screen.getPrimaryDisplay();
    const width = 360;
    const height = 34;
    const bar = new BrowserWindow({
      width,
      height,
      x: primary.bounds.x + Math.round((primary.bounds.width - width) / 2),
      y: primary.bounds.y + 8,
      frame: false,
      transparent: true,
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // 刻意不叫 AGENT DECK：与电池按标题寻面板窗（waitPanelWindow）划清界限；
      // pid 本已不同（条属控制器进程），标题再错开是双保险。
      title: 'AGENT DECK ACCEPT HINT',
    });
    void bar.loadFile(path.join(__dirname, 'hint-bar.html'))
      .catch((err) => console.error(`[hint-bar] 提示条页面加载失败: ${err && err.message}`));
    bar.once('ready-to-show', () => {
      bar.setIgnoreMouseEvents(true);
      bar.showInactive();
    });
    return bar;
  } catch (err) {
    // 尽力而为：挂条失败不拖垮电池本体（提示是增益，不是测试前提）
    console.error(`[hint-bar] 验收提示条创建失败（不阻塞电池）: ${err && err.message}`);
    return null;
  }
}

module.exports = { showAcceptHintBar };
