/**
 * 对话窗「真实控件 → 桥接 → 会话服务 → ACP fake」链的离线装配（工单364）。
 *
 * 真源用法：会话服务（ConversationService）经确定性 ACP fake 子进程跑全链，桥接层是
 * 真正的 BridgeService（对话方法全走它的 dispatch），变化推送经 ctx 的
 * 'conversation/changed' 事件（BridgeService.subscribe 同一路）。
 *
 * 装配取舍：BridgeService 的注入依赖（clock/panelData/search/settings/focus/plugins/
 * taskbar/pluginConfig）与本票无关，一律注册同名空壳服务即可——对话方法不碰它们；
 * 插件/凭证面（install/*、credentials/*）在测试桩里回空形状，不另造实现。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { ConversationService, type ConversationProcess, type ConversationSpawn } from '../../src/main/conversation/service'
import { BridgeService } from '../../src/main/services/bridge'

const FAKE_AGENT = path.resolve(__dirname, 'fake-acp-agent.mjs')

export interface SpawnRecord {
  plan: { file: string; args: string[]; env: Record<string, string> }
  cwd: string
  pid: number | undefined
  alive: () => boolean
}

export interface ConversationBridgeHarness {
  ctx: Context
  service: ConversationService
  bridge: BridgeService
  spawns: SpawnRecord[]
  logs: Array<Record<string, unknown>>
  /** 建会话并等到 ready（真握手 + session/new） */
  createSession(label?: string): Promise<{ id: string }>
  cleanup(): Promise<void>
}

/** 同名空壳服务：只为满足 BridgeService 的注入依赖（对话方法不碰它们） */
function stubService(name: string) {
  class Stub extends Service {
    constructor(ctx: Context) {
      super(ctx, name)
    }
  }
  return Stub
}

export async function makeConversationBridgeHarness(scenario: string): Promise<ConversationBridgeHarness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-conv-win-'))
  const spawns: SpawnRecord[] = []
  const logs: Array<Record<string, unknown>> = []

  const spawnProcess: ConversationSpawn = (plan, cwd, env) => {
    const child: ChildProcess = spawn(process.execPath, [FAKE_AGENT, '--scenario', scenario], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const record: SpawnRecord = {
      plan,
      cwd,
      pid: child.pid,
      alive: () => child.pid != null && child.exitCode == null && !child.killed,
    }
    spawns.push(record)
    const proc: ConversationProcess = {
      pid: child.pid,
      stdin: child.stdin!,
      stdout: child.stdout!,
      onExit: (cb) => child.once('exit', (code, signal) => cb(code, signal)),
      killTree: () => { try { child.kill() } catch { /* 尽力 */ } },
    }
    return proc
  }

  const ctx = new Context()
  for (const name of ['clock', 'panelData', 'search', 'settings', 'focus', 'plugins', 'taskbar', 'pluginConfig']) {
    ctx.plugin(stubService(name))
  }
  ctx.plugin(ConversationService, {
    dshHome: path.join(tmp, 'dsh-home'),
    workspacesRoot: path.join(tmp, 'workspaces'),
    metadataFile: path.join(tmp, 'metadata.json'),
    deps: {
      resolveBackend: async () => ({ exe: 'C:\\fake\\DeepSeek Harness.exe', cliJs: 'C:\\fake\\cli.js', source: 'test' }),
      spawnProcess,
      createJobObject: () => null,
      env: { DECK_TEST: '1' },
      log: (e) => logs.push(e),
    },
  })
  ctx.plugin(BridgeService, { quit: () => { /* 离线不退出 */ } })
  await ctx.start()

  const service = ctx.conversation as ConversationService
  const bridge = ctx.bridge as BridgeService

  const harness: ConversationBridgeHarness = {
    ctx,
    service,
    bridge,
    spawns,
    logs,
    createSession: async (label?: string) => {
      const res = await service.create(label)
      if (!res.ok || !res.session) throw new Error(`建会话失败：${res.error ?? '未知'}`)
      await until(() => service.sessions().find((s) => s.id === res.session!.id)?.status === 'ready')
      return { id: res.session.id }
    },
    cleanup: async () => {
      service.dispose()
      try { await ctx.stop() } catch { /* 已停即略 */ }
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄滞后尽力 */ }
    },
  }
  return harness
}

/** 轮询直到谓词为真（真链异步推进，等的是事实不是时钟） */
export async function until<T>(pred: () => T | null | undefined, timeoutMs = 8000, stepMs = 30): Promise<T> {
  const started = Date.now()
  for (;;) {
    try {
      const v = pred()
      if (v) return v
    } catch { /* 谓词内部异常按未就绪处理 */ }
    if (Date.now() - started > timeoutMs) throw new Error('until 超时')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
