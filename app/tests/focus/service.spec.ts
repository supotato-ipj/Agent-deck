/** 会话行直达服务（工单09）：假窗口源驱动状态机——不触 FFI、不启动真实工具。 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { FocusService } from '../../src/main/services/focus'
import type { WindowCandidate } from '../../src/main/focus/plan'

interface Recorder {
  focused: number[]
  launched: string[]
  ctx: Context
  service: FocusService
}

async function harness(windows: WindowCandidate[], opts: { focusOk?: boolean; launchErr?: string; env?: Record<string, string | undefined> } = {}): Promise<Recorder> {
  const focused: number[] = []
  const launched: string[] = []
  const ctx = new Context()
  ctx.plugin(FocusService, {
    tools: {
      zcode: { launch: '%PF%\\ZCode\\ZCode.exe', processes: ['zcode'] },
      hermes: { launch: '', processes: ['hermes'] },
    },
    deps: {
      listWindows: () => windows,
      focusWindow: (hwnd: number) => {
        if (opts.focusOk === false) return false
        focused.push(hwnd)
        return true
      },
      launch: async (exe: string) => {
        launched.push(exe)
        return opts.launchErr ?? ''
      },
      env: opts.env ?? { PF: 'C:\\Program Files' },
    },
  })
  await ctx.start()
  return { focused, launched, ctx, service: ctx.focus }
}

const ZCODE_WIN: WindowCandidate = { hwnd: 0x2000, pid: 77, exe: 'ZCode.exe', visible: true, minimized: false }

describe('会话行直达服务', () => {
  it('工具在跑 → 聚焦既有窗口，不启动', async () => {
    const h = await harness([ZCODE_WIN])
    try {
      await expect(h.service.focusTool('zcode')).resolves.toEqual({ ok: true, action: 'focused', hwnd: 0x2000 })
      expect(h.focused).toEqual([0x2000])
      expect(h.launched).toEqual([])
    } finally {
      await h.ctx.stop()
    }
  })

  it('工具未运行 → 启动配置 exe（%VAR% 已展开）', async () => {
    const h = await harness([])
    try {
      await expect(h.service.focusTool('zcode')).resolves.toEqual({ ok: true, action: 'launched' })
      expect(h.launched).toEqual(['C:\\Program Files\\ZCode\\ZCode.exe'])
    } finally {
      await h.ctx.stop()
    }
  })

  it('未知工具 → 静默降级，不启动任何东西', async () => {
    const h = await harness([ZCODE_WIN])
    try {
      const r = await h.service.focusTool('nope')
      expect(r.ok).toBe(false)
      expect(r.action).toBe('degraded')
      expect(h.launched).toEqual([])
    } finally {
      await h.ctx.stop()
    }
  })

  it('无启动目标且未运行 → 降级（hermes）', async () => {
    const h = await harness([])
    try {
      const r = await h.service.focusTool('hermes')
      expect(r.action).toBe('degraded')
      expect(h.launched).toEqual([])
    } finally {
      await h.ctx.stop()
    }
  })

  it('系统拒绝置前 → 降级而非抛错（面板不崩）', async () => {
    const h = await harness([ZCODE_WIN], { focusOk: false })
    try {
      const r = await h.service.focusTool('zcode')
      expect(r.ok).toBe(false)
      expect(r.action).toBe('degraded')
      expect(r.error).toBeTruthy()
    } finally {
      await h.ctx.stop()
    }
  })

  it('启动失败 → 降级并带回原因', async () => {
    const h = await harness([], { launchErr: '找不到文件' })
    try {
      const r = await h.service.focusTool('zcode')
      expect(r).toMatchObject({ ok: false, action: 'degraded', error: '找不到文件' })
    } finally {
      await h.ctx.stop()
    }
  })

  it('窗口枚举抛错时仍走启动路径（工具未运行照样能启动）', async () => {
    const launched: string[] = []
    const ctx = new Context()
    ctx.plugin(FocusService, {
      tools: { zcode: { launch: 'C:\\ZCode.exe', processes: ['zcode'] } },
      deps: {
        listWindows: () => { throw new Error('FFI 不可用') },
        focusWindow: () => true,
        launch: async (exe: string) => { launched.push(exe); return '' },
        env: {},
      },
    })
    await ctx.start()
    try {
      await expect(ctx.focus.focusTool('zcode')).resolves.toEqual({ ok: true, action: 'launched' })
      expect(launched).toEqual(['C:\\ZCode.exe'])
    } finally {
      await ctx.stop()
    }
  })

  it('原型链键名按未知工具降级（不 reject，面板不崩）', async () => {
    const h = await harness([ZCODE_WIN])
    try {
      for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
        const r = await h.service.focusTool(key)
        expect(r.action, `${key} 应当降级`).toBe('degraded')
      }
      expect(h.launched).toEqual([])
    } finally {
      await h.ctx.stop()
    }
  })

  it('路径型工具名无从执行：查表未命中即降级（任意路径执行防线）', async () => {
    const h = await harness([])
    try {
      for (const evil of ['C:\\Windows\\System32\\cmd.exe', '../../evil.exe', '/bin/sh']) {
        const r = await h.service.focusTool(evil)
        expect(r.action).toBe('degraded')
      }
      expect(h.launched).toEqual([])
    } finally {
      await h.ctx.stop()
    }
  })

  it('缺省工具映射含五工具（config 未下发时也不至于全部降级）', async () => {
    const ctx = new Context()
    ctx.plugin(FocusService, { deps: { listWindows: () => [], focusWindow: () => true, launch: async () => '', env: {} } })
    await ctx.start()
    try {
      expect(Object.keys(ctx.focus.toolsForTest()).sort()).toEqual(['hermes', 'kimicode', 'kimiwork', 'qoder', 'zcode'])
    } finally {
      await ctx.stop()
    }
  })
})
