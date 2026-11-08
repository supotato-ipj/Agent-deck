// 工单402：config 漂移检查（验收电池零接触用户生产配置的自检兜底）。
// 接缝 = snapshotConfig / checkConfigDrift 的落盘契约：轮前快照 sha256 ↔ 轮后比对，
// 命中即判红并逐字节还原（缺位来、缺位去——与 battery-config 三态还原同口径）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkConfigDrift, snapshotConfig } from '../../accept/lib/battery-cleanup'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cleanup-'))
  dirs.push(dir)
  return join(dir, 'config.json')
}

const ORIGINAL = '{\n  "taskbar": {\n    "enabled": true\n  }\n}\n'

describe('config 漂移检查（工单402）', () => {
  it('轮内未改动 → 不判红、不还原', () => {
    const file = tempConfigPath()
    writeFileSync(file, ORIGINAL, 'utf8')
    const snap = snapshotConfig(file)
    const r = checkConfigDrift(snap)
    expect(r.drifted).toBe(false)
    expect(r.restored).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL)
  })

  it('轮内被探针档位覆盖 → 判红并逐字节还原原文', () => {
    const file = tempConfigPath()
    writeFileSync(file, ORIGINAL, 'utf8')
    const snap = snapshotConfig(file)
    writeFileSync(file, '{"taskbar":{"enabled":false,"trayOverflowLimit":3}}\n', 'utf8')
    const r = checkConfigDrift(snap)
    expect(r.drifted).toBe(true)
    expect(r.restored).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL)
  })

  it('轮前缺位、轮中被创建 → 判红并删桩（缺位来、缺位去）', () => {
    const file = tempConfigPath()
    const snap = snapshotConfig(file)
    expect(snap.raw).toBeNull()
    writeFileSync(file, '{"taskbar":{"enabled":false}}\n', 'utf8')
    const r = checkConfigDrift(snap)
    expect(r.drifted).toBe(true)
    expect(r.restored).toBe(true)
    expect(existsSync(file)).toBe(false)
  })

  it('轮前在位、轮中被删除 → 判红并复原原文', () => {
    const file = tempConfigPath()
    writeFileSync(file, ORIGINAL, 'utf8')
    const snap = snapshotConfig(file)
    rmSync(file, { force: true })
    const r = checkConfigDrift(snap)
    expect(r.drifted).toBe(true)
    expect(r.restored).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL)
  })
})
