// 工单402：验收电池 config 隔离落点（DECK_CONFIG_FILE 的播种/崩溃快照/崩溃守卫）。
// 接缝 = prepareIsolation / installCrashGuard 的外部契约：隔离文件承载本轮读写、用户生产
// 配置零写入；上轮崩溃残留的快照在下一轮起跑时比对并还原（SIGKILL 不可捕获，靠此兜底）。
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCrashGuard, prepareIsolation } from '../../accept/lib/config-isolation'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

const USER_CONFIG = '{\n  "taskbar": {\n    "enabled": true\n  }\n}\n'

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'config-isolation-'))
  dirs.push(dir)
  const tmpRoot = join(dir, 'tmp')
  const userConfigFile = join(dir, 'app', 'config.json')
  return { tmpRoot, userConfigFile }
}

function withUserConfig(userConfigFile: string, raw = USER_CONFIG) {
  mkdirSync(dirname(userConfigFile), { recursive: true })
  writeFileSync(userConfigFile, raw, 'utf8')
}

describe('prepareIsolation：隔离落点（工单402）', () => {
  it('用户配置在位 → 隔离文件逐字节播种原文，用户文件零改动', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    const iso = prepareIsolation({ userConfigFile, tmpRoot })
    expect(readFileSync(iso.isolatedFile, 'utf8')).toBe(USER_CONFIG)
    expect(readFileSync(userConfigFile, 'utf8')).toBe(USER_CONFIG)
    expect(iso.residueRestored).toBe(false)
    iso.dispose()
  })

  it('用户配置缺位 → 不创建隔离文件（电池按三态契约自建最小桩）', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    const iso = prepareIsolation({ userConfigFile, tmpRoot })
    expect(existsSync(iso.isolatedFile)).toBe(false)
    iso.dispose()
  })

  it('dispose 删隔离文件与轮快照，用户配置原样保留', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    const iso = prepareIsolation({ userConfigFile, tmpRoot })
    iso.dispose()
    expect(existsSync(iso.isolatedFile)).toBe(false)
    expect(readFileSync(userConfigFile, 'utf8')).toBe(USER_CONFIG)
  })

  it('轮内漂移 → checkDrift 判红并还原用户配置（隔离失效时的最后兜底）', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    const iso = prepareIsolation({ userConfigFile, tmpRoot })
    writeFileSync(userConfigFile, '{"taskbar":{"enabled":false}}\n', 'utf8')
    const r = iso.checkDrift()
    expect(r.drifted).toBe(true)
    expect(readFileSync(userConfigFile, 'utf8')).toBe(USER_CONFIG)
    iso.dispose()
  })
})

describe('崩溃残留：上一轮 SIGKILL 后的下一轮起跑恢复（工单402）', () => {
  it('上轮未 dispose（崩溃）且用户配置已被改 → 下轮起跑判红并还原', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    prepareIsolation({ userConfigFile, tmpRoot }) // 模拟崩溃轮：不调 dispose，快照留在盘上
    writeFileSync(userConfigFile, '{"taskbar":{"enabled":false,"trayOverflowLimit":3}}\n', 'utf8')
    const next = prepareIsolation({ userConfigFile, tmpRoot })
    expect(next.residueRestored).toBe(true)
    expect(readFileSync(userConfigFile, 'utf8')).toBe(USER_CONFIG)
    next.dispose()
  })

  it('上轮未 dispose 但用户配置未变 → 下轮不判红', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    prepareIsolation({ userConfigFile, tmpRoot })
    const next = prepareIsolation({ userConfigFile, tmpRoot })
    expect(next.residueRestored).toBe(false)
    next.dispose()
  })
})

describe('installCrashGuard：中途死也还原（工单402 修法 2）', () => {
  function fakeProc() {
    const proc = new EventEmitter() as EventEmitter & { exit: (code: number) => void }
    proc.exit = vi.fn()
    return proc
  }

  it('SIGTERM → 先判漂移还原、再清隔离落点、以 143 退出', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    const iso = prepareIsolation({ userConfigFile, tmpRoot })
    writeFileSync(iso.isolatedFile, '{"taskbar":{"enabled":false}}\n', 'utf8')
    const proc = fakeProc()
    const logs: string[] = []
    installCrashGuard(iso, proc, { error: (...a: unknown[]) => logs.push(a.map(String).join(' ')) } as unknown as Console)
    proc.emit('SIGTERM')
    expect(proc.exit).toHaveBeenCalledWith(143)
    expect(readFileSync(userConfigFile, 'utf8')).toBe(USER_CONFIG)
    expect(existsSync(iso.isolatedFile)).toBe(false)
  })

  it('uncaughtException → 记错误、还原并以 1 退出', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    const iso = prepareIsolation({ userConfigFile, tmpRoot })
    writeFileSync(userConfigFile, '{"taskbar":{"enabled":false}}\n', 'utf8')
    const proc = fakeProc()
    const logs: string[] = []
    installCrashGuard(iso, proc, { error: (...a: unknown[]) => logs.push(a.map(String).join(' ')) } as unknown as Console)
    proc.emit('uncaughtException', new Error('boom'))
    expect(proc.exit).toHaveBeenCalledWith(1)
    expect(readFileSync(userConfigFile, 'utf8')).toBe(USER_CONFIG)
    expect(logs.join('\n')).toContain('boom')
  })

  it('SIGINT → 还原并以 130 退出', () => {
    const { tmpRoot, userConfigFile } = sandbox()
    withUserConfig(userConfigFile)
    const iso = prepareIsolation({ userConfigFile, tmpRoot })
    writeFileSync(userConfigFile, '{"taskbar":{"enabled":false}}\n', 'utf8')
    const proc = fakeProc()
    installCrashGuard(iso, proc, { error: () => {} } as unknown as Console)
    proc.emit('SIGINT')
    expect(proc.exit).toHaveBeenCalledWith(130)
    expect(readFileSync(userConfigFile, 'utf8')).toBe(USER_CONFIG)
  })
})
