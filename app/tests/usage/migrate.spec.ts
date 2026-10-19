/**
 * 使用日志迁移测试（工单11）：Python 侧历史日志搬进新 userData。
 *
 * 两侧格式逐字段相同（`{ts, exe}` 的按天 JSONL，见 usage/log.ts 的 dayTag 与
 * Python usage_log.append 的 isoformat(timespec="seconds")），故迁移是纯文件搬运，
 * 不做解析重写——重写只会引入旧格式与新格式漂移的机会。
 *
 * 幂等性是这里的硬要求：迁移跑在启动路径上，中途断电/被杀后重跑不得让同一条记录
 * 出现两次。故以标记文件逐个记名，而不是「跑完写一个 done」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RETENTION_DAYS } from '../../src/main/usage/log'
import { migrateUsageLog, planUsageMigration } from '../../src/main/usage/migrate'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `deck-migrate-${tag}-`))
  tmpDirs.push(d)
  return d
}

const NOW = Date.parse('2026-09-29T00:00:00Z')

function dayTag(offsetDays: number): string {
  return new Date(NOW - offsetDays * 86400_000).toISOString().slice(0, 10).replace(/-/g, '')
}

describe('使用日志迁移：搬运计划（工单11）', () => {
  it('只搬按天 JSONL，非日志文件忽略', () => {
    const plan = planUsageMigration({ legacyFiles: [`start-${dayTag(1)}.jsonl`, `focus-${dayTag(1)}.jsonl`, 'notes.txt', 'layout.json'], nowMs: NOW })
    expect(plan.files.sort()).toEqual([`focus-${dayTag(1)}.jsonl`, `start-${dayTag(1)}.jsonl`].sort())
    expect(plan.skipped).toContain('notes.txt')
  })

  it('超出保留期的天文件不搬（搬进去也只会立刻被滚动清理删掉）', () => {
    const stale = `start-${dayTag(RETENTION_DAYS + 5)}.jsonl`
    const plan = planUsageMigration({ legacyFiles: [stale, `start-${dayTag(1)}.jsonl`], nowMs: NOW })
    expect(plan.files).toEqual([`start-${dayTag(1)}.jsonl`])
    expect(plan.skipped).toContain(stale)
  })

  it('当天文件永不被判过期（utc 日界与滚动清理同口径）', () => {
    const today = `start-${dayTag(0)}.jsonl`
    expect(planUsageMigration({ legacyFiles: [today], nowMs: NOW }).files).toEqual([today])
  })
})

describe('使用日志迁移：搬运执行（工单11）', () => {
  function setup(legacyFiles: Record<string, string>) {
    const legacy = tmpDir('legacy')
    const target = tmpDir('target')
    for (const [name, body] of Object.entries(legacyFiles)) fs.writeFileSync(path.join(legacy, name), body, 'utf8')
    return { legacy, target }
  }

  const OLD_LINE = '{"ts":"2026-09-28T01:00:00","exe":"C:\\\\app\\\\a.exe"}\n'
  const OLDER_LINE = '{"ts":"2026-09-27T01:00:00","exe":"C:\\\\app\\\\b.exe"}\n'

  it('目标为空时原样落盘（内容逐字节保留）', () => {
    const { legacy, target } = setup({ [`start-${dayTag(1)}.jsonl`]: OLD_LINE })
    const r = migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: path.join(target, '.marker.json'), nowMs: NOW })
    expect(r.migrated).toEqual([`start-${dayTag(1)}.jsonl`])
    expect(fs.readFileSync(path.join(target, `start-${dayTag(1)}.jsonl`), 'utf8')).toBe(OLD_LINE)
  })

  it('同一天已有新日志时合并而非覆盖（新面板可能已写过当天）', () => {
    const name = `start-${dayTag(1)}.jsonl`
    const { legacy, target } = setup({ [name]: OLD_LINE })
    const newLine = '{"ts":"2026-09-28T23:00:00","exe":"C:\\\\app\\\\new.exe"}\n'
    fs.writeFileSync(path.join(target, name), newLine, 'utf8')
    migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: path.join(target, '.marker.json'), nowMs: NOW })
    expect(fs.readFileSync(path.join(target, name), 'utf8')).toBe(newLine + OLD_LINE)
  })

  it('重复执行不产生重复记录（逐文件记账的幂等性）', () => {
    const name = `start-${dayTag(1)}.jsonl`
    const { legacy, target } = setup({ [name]: OLD_LINE })
    const marker = path.join(target, '.marker.json')
    const first = migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: marker, nowMs: NOW })
    const second = migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: marker, nowMs: NOW })
    expect(first.migrated).toEqual([name])
    expect(second.migrated).toEqual([])
    expect(fs.readFileSync(path.join(target, name), 'utf8')).toBe(OLD_LINE)
  })

  it('标记丢失后重跑也不翻倍（append 成功但标记未落盘的窗口）', () => {
    const name = `start-${dayTag(1)}.jsonl`
    const { legacy, target } = setup({ [name]: OLD_LINE })
    const marker = path.join(target, '.marker.json')
    migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: marker, nowMs: NOW })
    // 模拟「append 已生效、标记未写」被击杀：删掉标记再跑一轮
    fs.rmSync(marker, { force: true })
    const again = migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: marker, nowMs: NOW })
    expect(again.migrated).toEqual([name]) // 判定为待搬，但按行去重后无新增
    expect(fs.readFileSync(path.join(target, name), 'utf8')).toBe(OLD_LINE)
  })

  it('源文件里的合法重复行照搬不丢（同应用同秒两次启动）', () => {
    const name = `start-${dayTag(1)}.jsonl`
    const { legacy, target } = setup({ [name]: OLD_LINE + OLD_LINE })
    migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: path.join(target, '.marker.json'), nowMs: NOW })
    expect(fs.readFileSync(path.join(target, name), 'utf8')).toBe(OLD_LINE + OLD_LINE)
  })

  it('旧目录不存在即无事可做，但仍记账（不再每启重扫）', () => {
    const target = tmpDir('empty')
    const marker = path.join(target, '.marker.json')
    const r = migrateUsageLog({ legacyDir: path.join(target, 'nope'), targetDir: target, markerFile: marker, nowMs: NOW })
    expect(r.migrated).toEqual([])
    expect(r.skipped).toEqual([])
    expect(fs.existsSync(marker)).toBe(true)
  })

  it('标记文件损坏时按未迁移处理（宁可重搬也不丢历史）', () => {
    const name = `start-${dayTag(1)}.jsonl`
    const { legacy, target } = setup({ [name]: OLD_LINE })
    const marker = path.join(target, '.marker.json')
    fs.writeFileSync(marker, '{ not json', 'utf8')
    const r = migrateUsageLog({ legacyDir: legacy, targetDir: target, markerFile: marker, nowMs: NOW })
    expect(r.migrated).toEqual([name])
  })

  it('只记成功搬走的文件；搬失败不记账以便下次重试', () => {
    const name = `start-${dayTag(1)}.jsonl`
    const { legacy, target } = setup({ [name]: OLD_LINE })
    // 目标 usage 目录被同名文件占位 → mkdirSync 必抛 ENOTDIR
    const blocked = path.join(target, 'usage')
    fs.writeFileSync(blocked, 'blocker', 'utf8')
    const r = migrateUsageLog({ legacyDir: legacy, targetDir: blocked, markerFile: path.join(blocked, '.marker.json'), nowMs: NOW })
    expect(r.migrated).toEqual([])
    expect(r.failed).toEqual([name])
    expect(fs.existsSync(path.join(blocked, '.marker.json'))).toBe(false)
  })
})
