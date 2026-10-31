// 零权限参考组件（工单334）：DSH 创建插件的样板——manifest 契约见插件契约目录
// （panel_snapshot 的 plugin_contract_catalog / docs/adr/0025）。
// 投放包宿主面只有 { el, view, util, config }：无 invoke、无桥接事件、无网络（默认拒绝）。
export default {
  mount(host) {
    host.el.textContent = 'hello from dsh'
  },
}
