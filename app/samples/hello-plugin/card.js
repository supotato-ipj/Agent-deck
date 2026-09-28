// HELLO 样例插件（工单10 验收样例 + 第三方作者的最小可读范例）
//
// 一个桌面组件 = 一个目录 + 一份 plugin.json + 一个 ES 模块入口。
// 本文件即入口：默认导出一个带 mount 的对象，面板经 deck-plugin:// 动态 import 后即调用。
// 拿到的东西只有 manifest 声明过的：
//   - host.el     自己的容器（往里画即可；没写 mount 锚点时，面板建好并挂到 body）
//   - host.view   按 capabilities 裁剪过的快照视图——本插件只声明了 clock，就只有 clock 段
//   - host.notify 存证上报（与面板同一条通道）
//   - host.invoke 内核桥接契约调用（渲染层不另开通道，插件也不另开）
// 生命周期：mount 一次，其后每次能力内的数据变化来一次 update，卸载时 unmount。

/** 面板卡片的底盘样式（第三方插件自带样式，不依赖面板的样式表） */
const CARD_CSS = [
  'position:fixed', 'box-sizing:border-box', 'padding:18px 20px',
  'background:rgba(0,0,0,0.55)', 'border:1px solid rgba(255,255,255,0.14)',
  'border-radius:16px', 'font-family:Consolas,"Courier New",monospace',
].join(';')

const pad = (n) => String(n).padStart(2, '0')

export default {
  mount(host) {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'hello-card'
    card.setAttribute('style', `${CARD_CSS};left:48px;top:760px;width:320px;height:120px`)
    card.innerHTML =
      '<h2 style="margin:0 0 10px;font-size:11px;font-weight:400;letter-spacing:0.3em;color:#9aa0a6">HELLO PLUGIN</h2>' +
      '<div id="hello-time" style="font-size:34px;line-height:1;color:#fff">--:--:--</div>' +
      '<div style="margin-top:8px;font-size:11px;letter-spacing:0.2em;color:#9aa0a6">EXTERNAL PLUGIN OK</div>'
    host.el.appendChild(card)
    host.notify('hello-mounted', { id: 'hello' })
  },

  update(host) {
    const clock = host.view.clock
    if (!clock) return
    const node = host.el.querySelector('#hello-time')
    const d = new Date(clock.epochMs)
    if (node) node.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  },

  unmount() {
    // 面板会清空容器；这里只放自建资源（本插件无）
  },
}
