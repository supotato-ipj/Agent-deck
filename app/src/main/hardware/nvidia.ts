/**
 * GPU 指标：nvidia-smi 查询（无独立显卡/nvidia-smi 时字段缺位）。
 * 解析为纯函数可离线测试；查询带 3 秒缓存（Python GPU_CACHE_TTL）且异步——
 * 不让 1Hz 采样循环被子进程阻塞。
 */
import { execFile } from 'node:child_process'
import { round1 } from './history'

export interface GpuReadout {
  gpu_usage?: number
  gpu_temp?: number
  vram_usage?: number | null
}

const NVIDIA_SMI_ARGS = [
  '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
  '--format=csv,noheader,nounits',
]

/** 解析 nvidia-smi 的 CSV 首行；空输出或解析失败抛错（调用方按源不可用降级） */
export function parseNvidiaSmi(stdout: string): GpuReadout {
  const stripped = stdout.trim()
  if (!stripped) throw new Error('nvidia-smi 无输出')
  const first = stripped.split('\n')[0]
  const parts = first.split(',').map((s) => Number(s.trim()))
  if (parts.length < 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`nvidia-smi 输出不可解析: ${JSON.stringify(first)}`)
  }
  const [util, temp, memUsed, memTotal] = parts
  return {
    gpu_usage: util,
    gpu_temp: temp,
    vram_usage: memTotal ? round1((memUsed / memTotal) * 100) : null,
  }
}

export type GpuRunner = (args: string[], cb: (err: Error | null, stdout: string) => void) => void

function defaultRunner(args: string[], cb: (err: Error | null, stdout: string) => void): void {
  execFile('nvidia-smi', args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
    cb(err ?? null, typeof stdout === 'string' ? stdout : '')
  })
}

/** 带缓存的 GPU 查询：缓存窗内直接读旧值；刷新失败缓存空结果（与 Python 一致——失败也占满 TTL） */
export class GpuQuery {
  private ts = -Infinity
  private data: GpuReadout = {}
  private inFlight = false

  constructor(
    private readonly ttlMs: number = 3000,
    private readonly runner: GpuRunner = defaultRunner,
    private readonly now: () => number = () => Date.now(),
  ) {}

  read(): GpuReadout {
    if (this.now() - this.ts < this.ttlMs || this.inFlight) return this.data
    this.inFlight = true
    this.runner(NVIDIA_SMI_ARGS, (err, stdout) => {
      this.inFlight = false
      this.ts = this.now()
      this.data = {}
      if (err === null) {
        try {
          this.data = parseNvidiaSmi(stdout)
        } catch {
          /* 空结果占满 TTL */
        }
      }
    })
    return this.data
  }
}
