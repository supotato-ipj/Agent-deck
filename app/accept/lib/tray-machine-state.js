'use strict';

/**
 * 托盘机器态判定（工单141+#138，spec #145）：P8/P10 托盘断言的失败定向纯函数。
 * 输入全部是探测事实（注册表条目/提升位、tray-add 注册 span、勿扰标记、识别色可见），
 * 输出记账决定——不碰任何 IO，离线可穷举单测（先例：render-sentinel 的 silenceVerdict）。
 *
 * 严口径不变量（spec #145）：环境账永远不为真回归买单——allowExclude 只在
 * 「面板尽了本分」的正向证据（trayAddSpan：Tray 构造即 Shell_NotifyIcon(NIM_ADD)
 * 已发出、span-close 在事件流 sidecar 在案）与机器态条件同时在场时为 true；
 * 无注册存证的任何失败维持硬失败（面板可能真的没注册图标）。
 *
 * appliesTo 取值：'P8-register'（NotifyIconSettings 注册断言）/ 'P8-visibility'
 * （识别色可见断言）/ 'P10-nav'（Win+B 键盘导航断言）。勿扰条件只解释导航断言
 * （它改的是托盘布局，不是注册面），注册断言永不被勿扰门禁。
 */

// Win11 勿扰在场时 UIA 焦点名里出现的通知中心项标记（#138 实测形态：
// "Notifications 17 new notifications (Do not disturb on)"）
const DND_MARKER = 'Do not disturb on';

/**
 * @param {{
 *   entryExists?: boolean,          // NotifyIconSettings 有本 exe（全路径匹配）条目
 *   promoted?: number|null,         // 条目 IsPromoted 值（无条目传 null）
 *   trayAddSpan?: boolean,          // 面板 pid 的 tray-add span-close 在案（注册正向证据）
 *   dndMarkerSeen?: boolean,        // 导航输出步名含勿扰通知积压标记
 *   amberVisible?: boolean,         // 任务栏可见区识别色扫描命中
 * }} input
 * @returns {{
 *   condition: string, allowExclude: boolean, appliesTo: string[],
 *   reason: string, directed: string,
 * }|null} null = 无机器态条件在场，照常硬失败
 */
function judgeTrayMachineState(input) {
  const entryExists = !!(input && input.entryExists);
  const promoted = entryExists ? Number(input.promoted) : null;
  const trayAddSpan = !!(input && input.trayAddSpan);
  const dnd = !!(input && input.dndMarkerSeen);
  const amberVisible = !!(input && input.amberVisible);

  if (!entryExists) {
    return {
      condition: trayAddSpan ? 'entry-missing-machine' : 'entry-missing-unverified',
      allowExclude: trayAddSpan,
      appliesTo: ['P8-register', 'P8-visibility', 'P10-nav'],
      reason: trayAddSpan
        ? '托盘机器态：图标已注册（tray-add 存证）但 NotifyIconSettings 无本 exe 条目——Windows 建档时序，非面板回归（工单141/#138）'
        : '托盘机器态存疑：无条目且无 tray-add 注册存证——面板可能未注册图标，维持硬失败',
      directed: trayAddSpan
        ? '图标已注册进系统（tray-add 存证在案），NotifyIconSettings 未为本 exe 建档——机器态，非面板回归'
        : '无 tray-add 注册存证：面板侧注册未证实，本失败不定责环境',
    };
  }
  if (promoted !== 1 && !amberVisible) {
    return {
      condition: trayAddSpan ? 'overflow-unpromoted' : 'overflow-unpromoted-unverified',
      allowExclude: trayAddSpan,
      appliesTo: ['P8-visibility', 'P10-nav'],
      reason: trayAddSpan
        ? '托盘机器态：提升位未置，图标在溢出层——可见区识别色与 Win+B 导航结构性不可达，非面板回归（工单141，#119 结论 C 根因）'
        : '提升位未置且无 tray-add 注册存证——维持硬失败',
      directed: trayAddSpan
        ? '图标在溢出层：提升位未置——机器态，非面板回归'
        : '提升位未置且注册未证实——不定责环境',
    };
  }
  if (promoted === 1 && !amberVisible) {
    return {
      condition: trayAddSpan ? 'promoted-no-remount' : 'promoted-no-remount-unverified',
      allowExclude: trayAddSpan,
      appliesTo: ['P8-visibility'],
      reason: trayAddSpan
        ? '托盘机器态：提升位已置（=1）但可见区无识别色——explorer 未重挂图标，非面板回归'
        : '提升位已置但识别色不可见且注册未证实——维持硬失败',
      directed: trayAddSpan
        ? '提升位已置、explorer 未重挂图标——机器态，非面板回归'
        : '注册未证实——不定责环境',
    };
  }
  if (dnd) {
    return {
      condition: trayAddSpan ? 'dnd-tray-layout' : 'dnd-tray-layout-unverified',
      allowExclude: trayAddSpan,
      appliesTo: ['P10-nav'],
      reason: trayAddSpan
        ? '托盘机器态：勿扰开启+通知积压改变托盘布局（导航序列含通知中心项）——非面板回归（工单138）'
        : '勿扰布局改变但注册未证实——维持硬失败',
      directed: trayAddSpan
        ? '勿扰+通知积压改变托盘布局——机器态，非面板回归'
        : '注册未证实——不定责环境',
    };
  }
  return null;
}

module.exports = { judgeTrayMachineState, DND_MARKER };
