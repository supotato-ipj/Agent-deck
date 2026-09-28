// 硬件指标卡（工单10 内置桌面组件 5/5）：两行定长仪表 + 300 点历史曲线（canvas 手绘）。
import type { PluginApi, PluginHost } from '../../plugins.js'
import type { HardwareState } from '../../../shared/contract'

let line1: HTMLElement
let line2: HTMLElement
let sparks: Record<string, HTMLCanvasElement>
let rendered = 0
let historyLiveNotified = false

/** 速率位：本卡片专有的呈现约定（定长仪表不跳动），故留在卡片内而非 host.util */
function kbps(x: number | undefined): string {
  return x == null ? '----' : x.toFixed(2).padStart(6, '0') + 'KB/s'
}

function drawSpark(canvas: HTMLCanvasElement, series: Array<number | null>): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const points = series.filter((v): v is number => v != null)
  if (points.length < 2) return
  const max = Math.max(...points, 1)
  const stepX = w / Math.max(1, series.length - 1)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)'
  ctx.lineWidth = 1
  ctx.beginPath()
  let drawing = false
  series.forEach((v, i) => {
    if (v == null) {
      drawing = false
      return
    }
    const x = i * stepX
    const y = h - 2 - (v / max) * (h - 4)
    if (!drawing) {
      ctx.moveTo(x, y)
      drawing = true
    } else {
      ctx.lineTo(x, y)
    }
  })
  ctx.stroke()
}

function render(host: PluginHost, hw: HardwareState): void {
  if (!line1) return
  const { pct, esc } = host.util
  const g = hw.gauges
  line1.innerHTML =
    `CPU <span class="v">${pct(g.cpu)}%</span> · GPU <span class="v">${pct(g.gpu_usage)}% ${pct(g.gpu_temp)}&deg;C</span>` +
    ` · VRAM <span class="v">${pct(g.vram_usage)}%</span>`
  line2.innerHTML =
    `RAM <span class="v">${pct(g.memory)}% ${esc(g.memory_gb)}</span>` +
    ` · DL <span class="v">${kbps(g.download_speed)}</span> · UP <span class="v">${kbps(g.upload_speed)}</span>`
  drawSpark(sparks.cpu, hw.history.cpu)
  drawSpark(sparks.gpu, hw.history.gpu)
  drawSpark(sparks.dl, hw.history.dl)
  drawSpark(sparks.up, hw.history.up)
  rendered += 1
  if (rendered <= 3) {
    host.notify('hardware-rendered', { n: rendered, cpu: g.cpu, historyLen: hw.history.cpu.length })
  }
  // 历史曲线滚动窗口存证：一枪式，累计 ≥5 点即上报（电池等待此事件断言曲线在积累）
  if (!historyLiveNotified && hw.history.cpu.length >= 5) {
    historyLiveNotified = true
    host.notify('history-live', { len: hw.history.cpu.length })
  }
}

export default {
  mount(host: PluginHost): void {
    const card = document.createElement('div')
    card.className = 'card'
    card.id = 'hardware-card'
    card.innerHTML =
      '<h2>HARDWARE</h2>'
      + '<div id="hw-lines">'
      + '<div id="hw-line1">CPU ---% &middot; GPU ---% ---&deg;C &middot; VRAM ---%</div>'
      + '<div id="hw-line2">RAM ---% -- GB/-- GB &middot; DL ----KB/s &middot; UP ----KB/s</div>'
      + '</div>'
      + '<div id="hw-sparks">'
      + '<div class="spark"><label>CPU</label><canvas id="spark-cpu"></canvas></div>'
      + '<div class="spark"><label>GPU</label><canvas id="spark-gpu"></canvas></div>'
      + '<div class="spark"><label>DL</label><canvas id="spark-dl"></canvas></div>'
      + '<div class="spark"><label>UP</label><canvas id="spark-up"></canvas></div>'
      + '</div>'
    host.el.appendChild(card)
    line1 = card.querySelector('#hw-line1') as HTMLElement
    line2 = card.querySelector('#hw-line2') as HTMLElement
    sparks = {
      cpu: card.querySelector('#spark-cpu') as HTMLCanvasElement,
      gpu: card.querySelector('#spark-gpu') as HTMLCanvasElement,
      dl: card.querySelector('#spark-dl') as HTMLCanvasElement,
      up: card.querySelector('#spark-up') as HTMLCanvasElement,
    }
    rendered = 0
    historyLiveNotified = false
    this.update?.(host)
  },

  update(host: PluginHost): void {
    const hw = host.view.hardware
    if (hw) render(host, hw)
  },
} satisfies PluginApi
