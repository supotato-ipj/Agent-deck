import { Service } from 'cordis'
import type { Context } from 'cordis'
import os from 'node:os'
import type { HardwareGauges, HardwareHistory, HardwareState } from '../../shared/contract'
import { HistoryRing } from '../hardware/history'
import {
  aggregateCpuTimes,
  cpuPercent,
  netRates,
  type CpuTimes,
  type NetCounters,
} from '../hardware/rates'
import { GpuQuery, type GpuReadout, type GpuRunner } from '../hardware/nvidia'

export const HISTORY_LEN = 300

/** 采样源束：主进程真源 / 测试假源共用一个采样状态机 */
export interface HardwareSources {
  cpuTimes(): CpuTimes
  memory(): { total: number; free: number }
  net(): Map<number, NetCounters>
  gpu(): GpuReadout
  monotonic(): number
}

export function systemHardwareSources(gpuRunner?: GpuRunner): HardwareSources {
  // koffi/nvidia-smi 真源延迟 require：契约测试注入假源时不加载原生件。
  // GPU TTL 5s（自 Python 时代的 3s 拉长）：展示性指标无需秒级新鲜度，
  // spawn 节奏减半（每分钟 12 次），消解周期性驱动查询对 GPU/DWM 的微抖动。
  const gpu = new GpuQuery(5000, gpuRunner)
  return {
    cpuTimes: () => aggregateCpuTimes(os.cpus()),
    memory: () => ({ total: os.totalmem(), free: os.freemem() }),
    net: () => require('../hardware/net-counters').readNetCounters(),
    gpu: () => gpu.read(),
    monotonic: () => performance.now() / 1000, // 单位约定：秒（与 Python time.monotonic 一致）
  }
}

function fmtGB(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(2).padStart(5, '0')
}

/**
 * 硬件指标服务：CPU/内存/GPU/网络 1Hz 采样 + 300 点历史。
 * 逐源隔离：任一源异常只缺位对应字段，不拖垮其余采样（工单04 验收第 5 条）。
 */
export class HardwareService extends Service {
  private readonly sources: HardwareSources
  private prevCpu: CpuTimes | null = null
  private cpu = 0.0
  private mem: { total: number; free: number } | null = null
  private prevNet: { t: number; counters: Map<number, NetCounters> } | null = null
  private rates: { download_speed: number; upload_speed: number } | null = null
  private readonly history = {
    cpu: new HistoryRing(HISTORY_LEN),
    dl: new HistoryRing(HISTORY_LEN),
    up: new HistoryRing(HISTORY_LEN),
    gpu: new HistoryRing(HISTORY_LEN),
  }

  constructor(ctx: Context, options: { sources?: HardwareSources } = {}) {
    super(ctx, 'hardware')
    this.sources = options.sources ?? systemHardwareSources()
  }

  /** 一个采样步（生产由内核定时器 1Hz 驱动；测试手动驱动） */
  sample(): void {
    try {
      const cur = this.sources.cpuTimes()
      this.cpu = cpuPercent(this.prevCpu, cur)
      this.prevCpu = cur
    } catch {
      this.cpu = 0.0
    }
    try {
      this.mem = this.sources.memory()
    } catch {
      this.mem = null
    }
    try {
      const now = this.sources.monotonic()
      const counters = this.sources.net()
      this.rates = netRates(
        this.prevNet === null ? null : this.prevNet.counters,
        counters,
        this.prevNet === null ? 0 : now - this.prevNet.t,
      )
      this.prevNet = { t: now, counters }
    } catch {
      this.prevNet = null
      this.rates = null
    }
    const gpu = this.readGpu()
    this.history.cpu.push(this.cpu)
    this.history.dl.push(this.rates === null ? null : this.rates.download_speed)
    this.history.up.push(this.rates === null ? null : this.rates.upload_speed)
    this.history.gpu.push(typeof gpu.gpu_usage === 'number' ? gpu.gpu_usage : null)
  }

  /** GPU 读源带隔离：异常给空对象，不连累其余仪表 */
  private readGpu(): GpuReadout {
    try {
      return this.sources.gpu()
    } catch {
      return {}
    }
  }

  gauges(): HardwareGauges {
    const out: HardwareGauges = {
      cpu: this.cpu,
      memory: this.mem ? (1 - this.mem.free / this.mem.total) * 100 : 0,
      memory_gb: this.mem ? `${fmtGB(this.mem.total - this.mem.free)} GB/${fmtGB(this.mem.total)} GB` : '-- GB/-- GB',
    }
    const gpu = this.readGpu()
    if (typeof gpu.gpu_usage === 'number') out.gpu_usage = gpu.gpu_usage
    if (typeof gpu.gpu_temp === 'number') out.gpu_temp = gpu.gpu_temp
    if (gpu.vram_usage !== undefined) out.vram_usage = gpu.vram_usage
    if (this.rates) {
      out.download_speed = this.rates.download_speed
      out.upload_speed = this.rates.upload_speed
    }
    return out
  }

  historySnapshot(): HardwareHistory {
    return {
      cpu: this.history.cpu.toArray() as number[],
      dl: this.history.dl.toArray(),
      up: this.history.up.toArray(),
      gpu: this.history.gpu.toArray(),
    }
  }

  state(): HardwareState {
    return { gauges: this.gauges(), history: this.historySnapshot() }
  }
}
