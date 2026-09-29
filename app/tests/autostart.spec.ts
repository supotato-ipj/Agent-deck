/**
 * 自启模块测试（工单11）：Startup 快捷方式的决策逻辑与 .lnk 读写往返。
 *
 * 两条缝：① 纯逻辑缝（decideAutostart / 路径解析）不碰文件系统与 COM；
 *         ② 适配缝（.lnk 读写）用 tmp 目录 + 真 WScript.Shell COM 往返验证，
 *            非 Windows 上跳过——本应用是 Windows-only（Win32/koffi 底座）。
 * 退役语义一并钉在这里：旧看门狗链的自启项必须被识别并移除。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTOSTART_LINK_NAME,
  LEGACY_STARTUP_LINK_NAMES,
  applyAutostart,
  autostartLinkPath,
  decideAutostart,
  desiredShortcut,
  isProductionRun,
  legacyLinkPaths,
  readShortcut,
  sameShortcut,
  startupDirFrom,
  writeShortcut,
  type ShortcutSpec,
} from '../src/main/autostart'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-autostart-'))
  tmpDirs.push(d)
  return d
}

const isWindows = process.platform === 'win32'

/** 目标是否「活着」——不可达的路径即死链。夹具里用前缀判定，不真碰磁盘。 */
function aliveUnder(...prefixes: string[]): (target: string) => boolean {
  return (target: string) => prefixes.some((p) => target.startsWith(p))
}

const DESIRED: ShortcutSpec = { target: 'C:\\repo\\app\\electron.exe', args: '"C:\\repo\\app"' }

describe('自启：Startup 路径解析（工单11）', () => {
  it('startupDirFrom 落在当前用户的 Startup 文件夹（APPDATA 下）', () => {
    expect(startupDirFrom('C:\\Users\\安\\AppData\\Roaming')).toBe(
      path.join('C:\\Users\\安\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    )
  })

  it('自启项与旧链自启项的路径都由 startup 目录派生', () => {
    const dir = startupDirFrom('C:\\Users\\安\\AppData\\Roaming')
    expect(autostartLinkPath(dir)).toBe(path.join(dir, AUTOSTART_LINK_NAME))
    expect(legacyLinkPaths(dir)).toEqual(LEGACY_STARTUP_LINK_NAMES.map((n) => path.join(dir, n)))
  })

  it('旧链只有看门狗那一个名字（工单11 退役清单的运行态形态）', () => {
    expect(LEGACY_STARTUP_LINK_NAMES).toEqual(['qoder-deck-server-watchdog.lnk'])
  })

  it('desiredShortcut 由当前运行位置派生：Electron 可执行 + 应用目录', () => {
    const spec = desiredShortcut('C:\\app\\node_modules\\electron\\dist\\electron.exe', 'C:\\app')
    expect(spec).toEqual({ target: 'C:\\app\\node_modules\\electron\\dist\\electron.exe', args: '"C:\\app"', workDir: 'C:\\app' })
  })

  it('应用目录含空格时加引号（Windows 快捷方式参数的通行口径）', () => {
    expect(desiredShortcut('C:\\a b\\electron.exe', 'C:\\a b').args).toBe('"C:\\a b"')
  })
})

describe('自启：快捷方式同一性判定（工单11）', () => {
  it('目标与参数（去引号后）都相同才算同一', () => {
    expect(sameShortcut({ target: 'a', args: '"b"' }, { target: 'a', args: '"b"' })).toBe(true)
    expect(sameShortcut({ target: 'a', args: 'b' }, { target: 'a', args: '"b"' })).toBe(true)
    expect(sameShortcut({ target: 'a', args: 'b' }, { target: 'a', args: 'c' })).toBe(false)
    expect(sameShortcut({ target: 'a', args: 'b' }, { target: 'z', args: 'b' })).toBe(false)
  })

  it('existing 为 null 时永不相同（缺失即需建）', () => {
    expect(sameShortcut(null, DESIRED)).toBe(false)
  })
})

describe('自启：动作决策（工单11）', () => {
  const alive = aliveUnder('C:\\repo')

  it('已存在且指向当前运行位置 → 保持不动', () => {
    expect(decideAutostart({ enabled: true, mayClaim: true, existing: DESIRED, desired: DESIRED, targetAlive: alive })).toEqual({
      action: 'keep',
      reason: 'existing-matches',
    })
  })

  it('缺失且本次即声明的生产安装位置 → 建立', () => {
    expect(decideAutostart({ enabled: true, mayClaim: true, existing: null, desired: DESIRED, targetAlive: alive })).toEqual({
      action: 'create',
      reason: 'missing',
    })
  })

  it('缺失但本次不是生产安装位置（开发 worktree）→ 不碰机器自启项', () => {
    expect(decideAutostart({ enabled: true, mayClaim: false, existing: null, desired: DESIRED, targetAlive: alive })).toEqual({
      action: 'skip',
      reason: 'not-production-run',
    })
  })

  it('死链且本次即生产安装位置 → 自愈重指当前运行位置', () => {
    const stale: ShortcutSpec = { target: 'C:\\gone\\electron.exe', args: '"C:\\gone\\app"' }
    expect(decideAutostart({ enabled: true, mayClaim: true, existing: stale, desired: DESIRED, targetAlive: alive })).toEqual({
      action: 'create',
      reason: 'dead-target',
    })
  })

  it('死链但本次不是生产安装位置 → 仍不接管（不把机器指向开发路径）', () => {
    const stale: ShortcutSpec = { target: 'C:\\gone\\electron.exe', args: '"C:\\gone\\app"' }
    expect(decideAutostart({ enabled: true, mayClaim: false, existing: stale, desired: DESIRED, targetAlive: alive })).toEqual({
      action: 'skip',
      reason: 'not-production-run',
    })
  })

  it('指向别处但目标仍在 → 不追改（开发工作树不得劫持生产自启项）', () => {
    const other: ShortcutSpec = { target: 'C:\\wt\\app\\electron.exe', args: '"C:\\wt\\app"' }
    expect(decideAutostart({ enabled: true, mayClaim: false, existing: other, desired: DESIRED, targetAlive: aliveUnder('C:\\repo', 'C:\\wt') })).toEqual({
      action: 'keep',
      reason: 'live-other-location',
    })
  })

  it('自启关闭 → 有则删、无则无事（关闭不需要生产身份，开发运行也照删）', () => {
    expect(decideAutostart({ enabled: false, mayClaim: false, existing: DESIRED, desired: DESIRED, targetAlive: alive })).toEqual({
      action: 'remove',
      reason: 'disabled',
    })
    expect(decideAutostart({ enabled: false, mayClaim: false, existing: null, desired: DESIRED, targetAlive: alive })).toEqual({
      action: 'disabled',
      reason: 'disabled',
    })
  })

  it('生产身份判定：appDir 为空 / 与运行目录不符 → 无权接管', () => {
    expect(isProductionRun({ appDir: '', runningAppDir: 'C:\\repo\\app' })).toBe(false)
    expect(isProductionRun({ appDir: 'C:\\repo\\app', runningAppDir: 'C:\\wt\\app' })).toBe(false)
    expect(isProductionRun({ appDir: 'C:\\repo\\app', runningAppDir: 'C:\\repo\\app' })).toBe(true)
    // 大小写与末尾分隔符差异不判为「不是同一处」
    expect(isProductionRun({ appDir: 'C:\\Repo\\app\\', runningAppDir: 'c:\\repo\\app' })).toBe(true)
  })
})

/** 真 COM 集成的单测限时：常态 ~3s，并行工作进程的负载尖峰会撞 5s 默认值（全量实测） */
const COM_TIMEOUT = 15_000

describe.skipIf(!isWindows)('自启：applyAutostart 集成（真 COM，tmp Startup 目录）', () => {
  /** 造一个假 Startup 目录（含旧链快捷方式），返回目录与旧链路径 */
  function startupWithLegacy(): { startup: string; legacy: string } {
    const startup = tmpDir()
    const legacy = path.join(startup, LEGACY_STARTUP_LINK_NAMES[0])
    writeShortcut(legacy, { target: 'C:\\venv\\pythonw.exe', args: '"C:\\old\\server_watchdog.pyw"' })
    return { startup, legacy }
  }

  it('旧看门狗链自启项无条件被清除并记账（退役不靠人记得手删）', () => {
    const { startup, legacy } = startupWithLegacy()
    const out = applyAutostart({
      enabled: true,
      appDir: 'C:\\repo\\app',
      runningAppDir: 'C:\\repo\\app',
      startup,
      desired: DESIRED,
    })
    expect(out.legacyRemoved).toEqual(LEGACY_STARTUP_LINK_NAMES)
    expect(fs.existsSync(legacy)).toBe(false)
  }, COM_TIMEOUT)

  it('开发运行（appDir 未声明）照样清旧链，但不新建自启项', () => {
    const { startup } = startupWithLegacy()
    const out = applyAutostart({ enabled: true, appDir: '', runningAppDir: 'C:\\wt\\app', startup, desired: DESIRED })
    expect(out.legacyRemoved).toEqual(LEGACY_STARTUP_LINK_NAMES)
    expect(out.action).toBe('skip')
    expect(fs.existsSync(path.join(startup, AUTOSTART_LINK_NAME))).toBe(false)
  }, COM_TIMEOUT)

  it('生产运行且缺失自启项 → 建好并读回一致', () => {
    const startup = tmpDir()
    const out = applyAutostart({ enabled: true, appDir: 'C:\\repo\\app', runningAppDir: 'C:\\repo\\app', startup, desired: DESIRED })
    expect(out.action).toBe('create')
    expect(out.applied).toBe(true)
    expect(readShortcut(out.link)).toMatchObject({ target: DESIRED.target, args: DESIRED.args })
  }, COM_TIMEOUT)

  it('重复执行幂等：第二次不重写', () => {
    const startup = tmpDir()
    const opts = { enabled: true, appDir: 'C:\\repo\\app', runningAppDir: 'C:\\repo\\app', startup, desired: DESIRED }
    applyAutostart(opts)
    const second = applyAutostart(opts)
    expect(second.action).toBe('keep')
    expect(second.reason).toBe('existing-matches')
  }, COM_TIMEOUT)

  it('自启关闭 → 删掉已有自启项', () => {
    const startup = tmpDir()
    applyAutostart({ enabled: true, appDir: 'C:\\repo\\app', runningAppDir: 'C:\\repo\\app', startup, desired: DESIRED })
    const off = applyAutostart({ enabled: false, appDir: '', runningAppDir: 'C:\\wt\\app', startup, desired: DESIRED })
    expect(off.action).toBe('remove')
    expect(off.applied).toBe(true)
    expect(fs.existsSync(path.join(startup, AUTOSTART_LINK_NAME))).toBe(false)
  }, COM_TIMEOUT)

  it('开发运行不会劫持已存在的生产自启项（活链原地不动）', () => {
    const startup = tmpDir()
    // 目标必须是**确实存在**的路径，否则会被判成死链走另一条分支——用 node.exe 充当生产目标
    const liveTarget = process.execPath
    writeShortcut(path.join(startup, AUTOSTART_LINK_NAME), { target: liveTarget, args: '"C:\\repo\\app"' })
    const out = applyAutostart({
      enabled: true,
      appDir: '',
      runningAppDir: 'C:\\wt\\app',
      startup,
      desired: { target: liveTarget, args: '"C:\\wt\\app"' },
    })
    expect(out.action).toBe('keep')
    expect(readShortcut(out.link)).toMatchObject({ args: '"C:\\repo\\app"' })
  }, COM_TIMEOUT)

  it('开发运行遇到指向别处的死链也不接管（不把机器指向开发路径）', () => {
    const startup = tmpDir()
    writeShortcut(path.join(startup, AUTOSTART_LINK_NAME), { target: 'C:\\gone\\electron.exe', args: '"C:\\gone\\app"' })
    const out = applyAutostart({
      enabled: true,
      appDir: '',
      runningAppDir: 'C:\\wt\\app',
      startup,
      desired: { target: process.execPath, args: '"C:\\wt\\app"' },
    })
    expect(out.action).toBe('skip')
    expect(readShortcut(out.link)).toMatchObject({ target: 'C:\\gone\\electron.exe' })
  }, COM_TIMEOUT)
})

describe.skipIf(!isWindows)('自启：.lnk 读写适配缝（真 COM，tmp 目录）', () => {
  it('写入后能读回目标与参数（Windows 快捷方式往返）', () => {
    const link = path.join(tmpDir(), AUTOSTART_LINK_NAME)
    writeShortcut(link, DESIRED)
    expect(fs.existsSync(link)).toBe(true)
    expect(readShortcut(link)).toMatchObject({ target: DESIRED.target, args: DESIRED.args })
  })

  it('不存在的链接读作 null（不做异常）', () => {
    expect(readShortcut(path.join(tmpDir(), 'nope.lnk'))).toBeNull()
  })

  it('含空格的目标与参数原样保真', () => {
    const link = path.join(tmpDir(), 'spaced.lnk')
    const spec: ShortcutSpec = { target: 'C:\\Program Files\\app\\electron.exe', args: '"C:\\Program Files\\app"', workDir: 'C:\\Program Files\\app' }
    writeShortcut(link, spec)
    expect(readShortcut(link)).toMatchObject({ target: spec.target, args: spec.args })
  })
})
