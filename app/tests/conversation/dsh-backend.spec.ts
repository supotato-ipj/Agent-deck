// DSH 启动描述符测试（工单332）：解析顺序（配置显式 → 环境变量 → 探测）、
// 候选根探测不硬编码盘符、launch plan 形状（探针 #330 实录配方）。
import { describe, expect, it } from 'vitest'
import {
  buildLaunchPlan,
  candidateInstallRoots,
  dshCliJsFor,
  resolveDshInstall,
  type DshProbeDeps,
} from '../../src/main/conversation/dsh-backend'

function fakeDeps(files: string[], env: Record<string, string | undefined> = {}): DshProbeDeps {
  const set = new Set(files)
  return {
    exists: (p) => set.has(p),
    env,
  }
}

const D_EXE = 'D:\\Program\\Dsh\\DeepSeek Harness.exe'
const D_CLI = dshCliJsFor('D:\\Program\\Dsh')

describe('DSH 启动描述符', () => {
  it('配置显式 exe 优先且要求桌面布局资源齐备', () => {
    const install = resolveDshInstall({ exe: D_EXE }, fakeDeps([D_EXE, D_CLI]))
    expect(install).not.toBeNull()
    expect(install!.exe).toBe(D_EXE)
    expect(install!.cliJs).toBe(D_CLI)
    expect(install!.source).toBe('config')
  })

  it('配置 exe 指向不完整布局（缺 cli.js）→ 拒绝（不把失败伪装成可用）', () => {
    expect(resolveDshInstall({ exe: D_EXE }, fakeDeps([D_EXE]))).toBeNull()
    expect(resolveDshInstall({ exe: D_EXE }, fakeDeps([]))).toBeNull()
  })

  it('无配置时探测：环境变量 DSH_EXE 次之', () => {
    const install = resolveDshInstall(undefined, fakeDeps([D_EXE, D_CLI], { DSH_EXE: D_EXE }))
    expect(install).not.toBeNull()
    expect(install!.source).toBe('env')
  })

  it('无配置无环境时探测候选根（C..Z 逐盘），命中 D 盘安装', () => {
    const files = ['C:\\', 'D:\\', D_EXE, D_CLI]
    const install = resolveDshInstall(undefined, fakeDeps(files))
    expect(install).not.toBeNull()
    expect(install!.exe).toBe(D_EXE)
    expect(install!.source.startsWith('probe:')).toBe(true)
  })

  it('候选根生成：含每盘 Program 与 Program Files 两式 + LOCALAPPDATA 用户安装位，不含盘符假设外的臆测', () => {
    const roots = candidateInstallRoots(fakeDeps(['C:\\', 'D:\\'], { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }))
    expect(roots).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\Dsh')
    expect(roots).toContain('C:\\Program\\Dsh')
    expect(roots).toContain('C:\\Program Files\\Dsh')
    expect(roots).toContain('D:\\Program\\Dsh')
    expect(roots).toContain('D:\\Program Files\\Dsh')
    // 不存在的盘不进候选
    expect(roots.some((r) => r.startsWith('Q:'))).toBe(false)
  })

  it('全落空 → null（未安装，选择器置灰的依据）', () => {
    expect(resolveDshInstall(undefined, fakeDeps(['C:\\']))).toBeNull()
  })

  it('launch plan：exe 直 spawn + --expose-internals + cli.js + --profile acp + ELECTRON_RUN_AS_NODE/DSH_HOME（探针配方）', () => {
    const plan = buildLaunchPlan({ exe: D_EXE, cliJs: D_CLI, source: 'probe:D:\\Program\\Dsh' }, 'C:\\panel-dsh-home')
    expect(plan.file).toBe(D_EXE)
    expect(plan.args).toEqual(['--expose-internals', D_CLI, '--profile', 'acp'])
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(plan.env.DSH_HOME).toBe('C:\\panel-dsh-home')
  })
})
