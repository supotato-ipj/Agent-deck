// 电池 config 读写共通 helper（工单124，spec #125 Phase 0）：临时目录打「缺位/有位/还原」
// 三态外部契约——只断言桩落盘结果与还原结果（字节级），不断言内部调用序列；语义不变量 =
// 换 helper 后行为与既有手写实现等价（right-group writeTaskbarFields 为真机背书的参照实现）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBatteryConfig } from '../../accept/lib/battery-config'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** 每例一个临时目录 + 其中的 config.json 路径（缺位态 = 只给路径不落文件） */
function tempConfigPath() {
  const dir = mkdtempSync(join(tmpdir(), 'battery-config-'))
  dirs.push(dir)
  return join(dir, 'config.json')
}

describe('缺位态（fresh worktree：config.json 不存在）', () => {
  it('readConfigRaw 返回 null（不抛 ENOENT——修 49/50 秒败的契约起点）', () => {
    const cfg = createBatteryConfig(tempConfigPath())
    expect(cfg.readConfigRaw()).toBeNull()
  })

  it('patchTaskbar 落最小桩（只有 taskbar 段，其余段留给面板 loadConfig 默认合并），返回 null', () => {
    const file = tempConfigPath()
    const cfg = createBatteryConfig(file)
    const original = cfg.patchTaskbar({ enabled: true })
    expect(original).toBeNull()
    expect(existsSync(file)).toBe(true)
    // 桩内容：taskbar.enabled=true，且没有臆造的其他段
    const written = readFileSync(file, 'utf8')
    expect(JSON.parse(written)).toEqual({ taskbar: { enabled: true } })
  })

  it('restoreConfig(null) 删桩：缺位来、缺位去，不留桩文件', () => {
    const file = tempConfigPath()
    const cfg = createBatteryConfig(file)
    cfg.patchTaskbar({ enabled: true })
    expect(existsSync(file)).toBe(true)
    cfg.restoreConfig(null)
    expect(existsSync(file)).toBe(false)
  })
})

describe('有位态（主检出/已跑过一轮：config.json 在）', () => {
  /** 参照现场：非 taskbar 段 + taskbar 段含 patch 之外的字段（手写实现时代的真实形状） */
  const EXISTING = [
    '{',
    '  "opacity": 0.5,',
    '  "taskbar": {',
    '    "enabled": false,',
    '    "metrics": [',
    '      "cpu"',
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n')

  it('readConfigRaw 返回原文', () => {
    const file = tempConfigPath()
    writeFileSync(file, EXISTING, 'utf8')
    const cfg = createBatteryConfig(file)
    expect(cfg.readConfigRaw()).toBe(EXISTING)
  })

  it('patchTaskbar 返回原文（供还原），覆写只动目标字段：其余段与 taskbar 其余字段原样保留', () => {
    const file = tempConfigPath()
    writeFileSync(file, EXISTING, 'utf8')
    const cfg = createBatteryConfig(file)
    const original = cfg.patchTaskbar({ enabled: true })
    expect(original).toBe(EXISTING)
    const json = JSON.parse(readFileSync(file, 'utf8'))
    expect(json.opacity).toBe(0.5) // 非 taskbar 段不动
    expect(json.taskbar).toEqual({ enabled: true, metrics: ['cpu'] }) // 段内字段合并不清洗
  })

  it('patchTaskbar 落盘格式与手写参照实现等价：2 空格缩进 + 尾换行（行为不变量）', () => {
    const file = tempConfigPath()
    writeFileSync(file, EXISTING, 'utf8')
    const cfg = createBatteryConfig(file)
    cfg.patchTaskbar({ enabled: true })
    // 独立字面量（照参照实现 writeTaskbarFields 的既定落盘格式手写，不在测试里重算）
    const expected = [
      '{',
      '  "opacity": 0.5,',
      '  "taskbar": {',
      '    "enabled": true,',
      '    "metrics": [',
      '      "cpu"',
      '    ]',
      '  }',
      '}',
      '',
    ].join('\n')
    expect(readFileSync(file, 'utf8')).toBe(expected)
  })

  it('restoreConfig(原文) 逐字节写回（AC：还原原文逐字节一致）', () => {
    const file = tempConfigPath()
    writeFileSync(file, EXISTING, 'utf8')
    const cfg = createBatteryConfig(file)
    const original = cfg.patchTaskbar({ enabled: true })
    cfg.restoreConfig(original)
    expect(readFileSync(file, 'utf8')).toBe(EXISTING)
  })
})
