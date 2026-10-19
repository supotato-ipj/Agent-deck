/**
 * CPU/网络速率的纯计算（可离线测试）。
 * 语义对齐 psutil：CPU 首次采样无基准给 0；网络速率钳非负、保留 1 位小数（KB/s）。
 */
import { round1 } from './history'

export interface CpuTimes {
  idle: number
  total: number
}

/** os.cpus() 各核时间的聚合（user+nice+sys+idle+irq → total） */
export function aggregateCpuTimes(cpus: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTimes {
  let idle = 0
  let total = 0
  for (const c of cpus) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

export function cpuPercent(prev: CpuTimes | null, cur: CpuTimes): number {
  if (prev === null) return 0.0
  const idleDelta = cur.idle - prev.idle
  const totalDelta = cur.total - prev.total
  if (totalDelta <= 0) return 0.0
  return Math.max(0.0, Math.min(100.0, (1 - idleDelta / totalDelta) * 100))
}

/** 单接口 32 位计数器的差值：处理回绕；差值大得不合常理（>2GiB/s）视为计数器重置归零 */
export function counterDelta32(prev: number, cur: number): number {
  const d = ((cur - prev) % 0x100000000 + 0x100000000) % 0x100000000
  return d > 0x80000000 ? 0 : d
}

export interface NetCounters {
  in: number
  out: number
}

export interface NetRates {
  download_speed: number
  upload_speed: number
}

/**
 * 两次全网接口计数快照 → KB/s。各接口分别求差后求和（32 位回绕按接口处理）；
 * 与 Python psutil net_io_counters 的差值口径一致。
 */
export function netRates(
  prev: Map<number, NetCounters> | null,
  cur: Map<number, NetCounters>,
  dt: number,
): NetRates | null {
  if (prev === null || dt <= 0) return null
  let din = 0
  let dout = 0
  for (const [idx, c] of cur) {
    const p = prev.get(idx)
    if (p === undefined) continue
    din += counterDelta32(p.in, c.in)
    dout += counterDelta32(p.out, c.out)
  }
  return {
    download_speed: Math.max(0, round1(din / dt / 1024)),
    upload_speed: Math.max(0, round1(dout / dt / 1024)),
  }
}
