'use strict';
// 工单461 网卡快照脚本喂入（accept 双门禁：PANEL_ACCEPT_MODE && DECK_NETWORK_SNAPSHOT_STUB=1 时
// 由 main/index.ts 拉起；同款先例 hardware-gauge-stub（工单459）——生产零启用）。
// 动机：P11 网络状态格段要「喂无活动非内部网卡快照、断言二态随帧翻转」——真机断网态不可控
// （物理断网卡破坏宿主机连通性），本 stub 把 os.networkInterfaces 换成控制器脚本文件现读。
// 真判定管线原样走通（networkInterfaces → toAdapterSnapshot → isNetworkUp → bridge.push →
// taskbar/status → 渲染层 applyNetworkCell → DOM 二态），只换快照源，不加事件通道。
// 脚本文件 = DECK_NETWORK_SNAPSHOT_FILE 指向的 JSON（os.networkInterfaces 输出形状：
// { 网卡名: [{address, family, internal, mac}, …] } 子集即可，如 {"WLAN": []} = 网卡在场
// 无地址）；每次调用现读（1Hz 量级，同步读小文件无负担）。文件缺位/损坏 → 透传真实采样
// （不编造数据）——电池只在 P11 段写该文件，其余段全程走真实采样。
function install(log, snapshotFile) {
  if (!snapshotFile) return false;
  const os = require('node:os');
  const fs = require('fs');
  const real = os.networkInterfaces.bind(os);
  os.networkInterfaces = () => {
    try {
      const scripted = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
      if (!scripted || typeof scripted !== 'object' || Array.isArray(scripted)) return real();
      return scripted;
    } catch {
      return real(); // 缺位/损坏 → 真实采样
    }
  };
  log?.append({ type: 'network-snapshot-stub-installed', snapshotFile });
  return true;
}

module.exports = { install };
