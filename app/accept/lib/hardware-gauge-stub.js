'use strict';
// 工单459 硬件仪表脚本喂入（accept 双门禁：PANEL_ACCEPT_MODE && DECK_HW_GAUGE_STUB=1 时
// 由 main/index.ts 拉起；同款先例 taskbar-burst / managed-probe——生产零启用）。
// 动机：P10 定宽槽位段要「喂不同位数读数、断言右组矩形宽度不变」——真实采样位数不可控，
// 本 stub 把 panelData.hardware() 的 gauges 段换成控制器脚本文件现读。真 1Hz 管线原样走通
// （bridge.push → taskbar/status → 渲染层 applyStatus → formatMetric → 定宽槽位 DOM），
// 只换数据源，不加事件通道。
// 脚本文件 = DECK_HW_GAUGE_FILE 指向的 JSON（五项 gauges 字段的子集即可，缺项落真实采样）；
// 每次 hardware() 调用时现读（1Hz 量级，同步读小文件无负担）。文件缺位/损坏 → 透传真实
// 采样（不编造数据）——电池只在 P10 段写该文件，其余段全程走真实采样。
function install(panelData, log, gaugeFile) {
  if (!panelData || typeof panelData.hardware !== 'function') return false;
  if (!gaugeFile) return false;
  const fs = require('fs');
  const real = panelData.hardware.bind(panelData);
  panelData.hardware = () => {
    const base = real();
    try {
      const scripted = JSON.parse(fs.readFileSync(gaugeFile, 'utf8'));
      if (!scripted || typeof scripted !== 'object') return base;
      return { ...base, gauges: { ...base.gauges, ...scripted } };
    } catch {
      return base; // 缺位/损坏 → 真实采样
    }
  };
  log?.append({ type: 'hw-gauge-stub-installed', gaugeFile });
  return true;
}

module.exports = { install };
