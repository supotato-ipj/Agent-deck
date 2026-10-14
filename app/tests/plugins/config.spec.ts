import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../../src/main/kernel'

/**
 * 插件私有状态存储（工单178，ADR-0014 决策 (c)）：内核桥接 `plugin-config/get|set`
 * 一对方法，按插件 id 命名空间落 userData。
 *
 * 缝 = 内核桥接契约：经 createKernel 起真内核、直驱 `ctx.bridge.invoke`，断言请求/响应
 * 与命名空间文件的落盘形态。文件系统是真 fs 落 tmp（与 plugins/service.spec.ts 同款），
 * Electron 零依赖——读写真源（tmp+rename 原子写）在此即真 fs 真源，不假源化。
 */

/** 命名空间存储目录：缺省生产落 userData/plugin-config，测试注入 tmp（绝不触真 userData） */
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pcfg-'))
  fs.mkdirSync(path.join(d, 'user'), { recursive: true })
  fs.mkdirSync(path.join(d, 'common'), { recursive: true })
  return d
}

function kernelOpts(dir: string, pluginConfigOver: Record<string, unknown> = {}) {
  let storeText: string | null = null
  return {
    tickIntervalMs: 0,
    hardwareIntervalMs: 0,
    usageIntervalMs: 0,
    searchIntervalMs: 0,
    desktop: {
      roots: { user: path.join(dir, 'user'), common: path.join(dir, 'common') },
      deps: {
        readStoreText: () => storeText,
        writeStoreText: (_f: string, text: string) => { storeText = text },
      },
    },
    usage: {
      dir: path.join(dir, 'usage'),
      deps: {
        runningPidExes: () => new Map<number, string>(),
        foregroundExe: () => null,
        readPrior: async () => new Map(),
      },
    },
    pluginConfig: { dir: path.join(dir, 'plugin-config'), ...pluginConfigOver },
  }
}

describe('插件私有状态存储（工单178 plugin-config）', () => {
  it('plugin-config/set 落盘后 plugin-config/get 原样读回', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      const written = await ctx.bridge.invoke('plugin-config/set', {
        id: 'doc-cards',
        patch: { groups: [{ name: 'Word', members: ['a.docx'] }], collapsed: false },
      })
      expect(written.config).toEqual({ groups: [{ name: 'Word', members: ['a.docx'] }], collapsed: false })
      await expect(ctx.bridge.invoke('plugin-config/get', { id: 'doc-cards' }))
        .resolves.toEqual({ config: { groups: [{ name: 'Word', members: ['a.docx'] }], collapsed: false }, warnings: [] })
    } finally {
      await ctx.stop()
    }
  })

  it('plugin-config/get 对从未写过的 id 回落空对象（缺失默认值，不抛）', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('plugin-config/get', { id: 'never-written' }))
        .resolves.toEqual({ config: {}, warnings: [] })
    } finally {
      await ctx.stop()
    }
  })

  it('命名空间按 id 分文件：两个 id 互不串味', async () => {
    const dir = tmpDir()
    const store = path.join(dir, 'plugin-config')
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      await ctx.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { mine: 'A' } })
      await ctx.bridge.invoke('plugin-config/set', { id: 'other-pkg', patch: { mine: 'B' } })
      // 每 id 一个文件（不共用一份、不共用一个键空间）
      expect(fs.readdirSync(store).sort()).toEqual(['doc-cards.json', 'other-pkg.json'])
      await expect(ctx.bridge.invoke('plugin-config/get', { id: 'doc-cards' }))
        .resolves.toEqual({ config: { mine: 'A' }, warnings: [] })
      await expect(ctx.bridge.invoke('plugin-config/get', { id: 'other-pkg' }))
        .resolves.toEqual({ config: { mine: 'B' }, warnings: [] })
    } finally {
      await ctx.stop()
    }
  })

  /**
   * 命名空间隔离**仅为约定式**——ADR-0014 Consequences 的可执行记录，防止后来者把它
   * 「修」成强制隔离（或反过来写注释声称有强制力）而无人察觉：主进程不校验调用方身份、
   * 不查 id 是否属某个已装载的插件包，id 由调用方自证。这里用一个**根本没有对应插件包**
   * 的 id 取状态并成功——若日后有人加了「id 必须是在册插件」这道闸门，本用例会红，
   * 那正是要先改 ADR-0014 而不是悄悄加护栏的信号。
   */
  it('命名空间隔离仅为约定式：不校验 id 归属、在册与否一律放行（无强制力，ADR-0014）', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      // plugins 根目录是空的：宿主没装载任何插件包，这两个 id 都不在册
      await ctx.bridge.invoke('plugin-config/set', { id: 'ghost-pkg', patch: { claimed: 'anyone' } })
      await expect(ctx.bridge.invoke('plugin-config/get', { id: 'ghost-pkg' }))
        .resolves.toEqual({ config: { claimed: 'anyone' }, warnings: [] })
    } finally {
      await ctx.stop()
    }
  })

  it('坏值逐键回退而非整体失败：同批好键照常落盘，每个坏键各记一条 warning', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await ctx.start()
    try {
      const r = await ctx.bridge.invoke('plugin-config/set', {
        id: 'doc-cards',
        // 三个静默丢信息的坏值 + 一个好键：undefined 被 JSON 整个丢掉、NaN 静默变 null、
        // Date 静默变成字符串——三者都不许悄悄进盘
        patch: { seq: 7, missing: undefined, nan: Number.NaN, when: new Date(0) },
      })
      expect(r.config).toEqual({ seq: 7 })
      // 逐键告警：点名到键，且键名互不串
      expect(r.warnings.some((w) => w.includes('missing'))).toBe(true)
      expect(r.warnings.some((w) => w.includes('nan'))).toBe(true)
      expect(r.warnings.some((w) => w.includes('when'))).toBe(true)
      expect(r.warnings.some((w) => w.includes('seq'))).toBe(false)
      // warning 同时进内核日志（这是内核侧唯一的告警出口）
      expect(warn.mock.calls.some(([m]) => String(m).includes('deck-plugin-config') && String(m).includes('nan'))).toBe(true)
    } finally {
      warn.mockRestore()
      await ctx.stop()
    }
  })

  it('坏值逐键回退落到既有值上：该键保留旧值，其余键正常更新', async () => {
    const dir = tmpDir()
    const ctx = createKernel(kernelOpts(dir))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await ctx.start()
    try {
      await ctx.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { seq: 1, keep: '原值' } })
      const r = await ctx.bridge.invoke('plugin-config/set', {
        id: 'doc-cards',
        patch: { seq: () => 2, keep: '新值' }, // seq 是函数 → 回退保留 1；keep 正常更新
      })
      expect(r.config).toEqual({ seq: 1, keep: '新值' })
      expect(r.warnings).toHaveLength(1)
      expect(r.warnings[0]).toContain('seq')
      // 回退是真回退：盘上那个键仍是旧值，不是被整体清空
      await expect(ctx.bridge.invoke('plugin-config/get', { id: 'doc-cards' }))
        .resolves.toMatchObject({ config: { seq: 1, keep: '新值' } })
    } finally {
      warn.mockRestore()
      await ctx.stop()
    }
  })

  it('坏 JSON 视同空对象并记 warning（损坏自愈，下次保存覆写原文件）', async () => {
    const dir = tmpDir()
    const store = path.join(dir, 'plugin-config')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'doc-cards.json'), '{ 半份坏 JSON', 'utf8')
    const ctx = createKernel(kernelOpts(dir))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await ctx.start()
    try {
      const read = await ctx.bridge.invoke('plugin-config/get', { id: 'doc-cards' })
      expect(read.config).toEqual({})
      expect(read.warnings).toHaveLength(1)
      expect(warn.mock.calls.some(([m]) => String(m).includes('deck-plugin-config'))).toBe(true)
      // 自愈：读不出不代表写不进——下一次保存覆写那份坏文件
      await ctx.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { seq: 1 } })
      expect(JSON.parse(fs.readFileSync(path.join(store, 'doc-cards.json'), 'utf8'))).toEqual({ seq: 1 })
    } finally {
      warn.mockRestore()
      await ctx.stop()
    }
  })

  it('原子写不留半份文件：写完目录里只有目标文件，没有 .tmp 残留', async () => {
    const dir = tmpDir()
    const store = path.join(dir, 'plugin-config')
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      await ctx.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { seq: 1 } })
      await ctx.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { seq: 2 } })
      expect(fs.readdirSync(store)).toEqual(['doc-cards.json'])
      // 目标文件是完整可解析的一份，不是写到一半的半截
      expect(JSON.parse(fs.readFileSync(path.join(store, 'doc-cards.json'), 'utf8'))).toEqual({ seq: 2 })
    } finally {
      await ctx.stop()
    }
  })

  it('写盘失败如实抛出（不静默吞），既有落盘内容原样保住', async () => {
    const dir = tmpDir()
    const store = path.join(dir, 'plugin-config')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'doc-cards.json'), JSON.stringify({ seq: 1 }), 'utf8')
    const ctx = createKernel(kernelOpts(dir, {
      deps: { writeStoreText: () => { throw new Error('EACCES 盘只读') } },
    }))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { seq: 2 } }))
        .rejects.toThrow(/EACCES/)
      // 写失败即抛：原文件一个字节没动（先写盘后提交，失败不留下改了一半的态）
      expect(JSON.parse(fs.readFileSync(path.join(store, 'doc-cards.json'), 'utf8'))).toEqual({ seq: 1 })
    } finally {
      await ctx.stop()
    }
  })

  it('载荷超限被拒并如实回报：一个字节都不写，绝不静默截断', async () => {
    const dir = tmpDir()
    const store = path.join(dir, 'plugin-config')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'doc-cards.json'), JSON.stringify({ seq: 1 }), 'utf8')
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      // 单键 100 KiB 字符串，远超 64 KiB 上限
      const huge = 'x'.repeat(100 * 1024)
      await expect(ctx.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { blob: huge } }))
        .rejects.toThrow(/超限/)
      // 拒收是真拒收：原文件保持原样，既没被超限载荷覆盖，也没被截断成半份
      expect(JSON.parse(fs.readFileSync(path.join(store, 'doc-cards.json'), 'utf8'))).toEqual({ seq: 1 })
    } finally {
      await ctx.stop()
    }
  })

  it('状态跨面板重启保持：换一台内核（同目录）原样读回', async () => {
    const dir = tmpDir()
    const first = createKernel(kernelOpts(dir))
    await first.start()
    try {
      await first.bridge.invoke('plugin-config/set', { id: 'doc-cards', patch: { seq: 42, name: '组卡' } })
    } finally {
      await first.stop()
    }
    const second = createKernel(kernelOpts(dir))
    await second.start()
    try {
      await expect(second.bridge.invoke('plugin-config/get', { id: 'doc-cards' }))
        .resolves.toEqual({ config: { seq: 42, name: '组卡' }, warnings: [] })
    } finally {
      await second.stop()
    }
  })

  /**
   * id 形态收口防的是**寻址安全**——id 直接当文件名，不收口就能把文件写到
   * plugin-config 目录之外。这一条与命名空间隔离无关（见上一用例：隔离本就是约定式）。
   */
  it('id 形态非法拒收（路径穿越/非字符串），文件不会落到存储目录之外', async () => {
    const dir = tmpDir()
    const store = path.join(dir, 'plugin-config')
    const ctx = createKernel(kernelOpts(dir))
    await ctx.start()
    try {
      for (const id of ['../escaped', 'a/b', 'C:\\win', '', 'Doc-Cards', '..', 42, null, undefined]) {
        await expect(ctx.bridge.invoke('plugin-config/get', { id } as never))
          .rejects.toThrow(/plugin-config 插件 id 非法/)
        await expect(ctx.bridge.invoke('plugin-config/set', { id, patch: { a: 1 } } as never))
          .rejects.toThrow(/plugin-config 插件 id 非法/)
      }
      expect(fs.existsSync(store)).toBe(false)
      expect(fs.readdirSync(dir).sort()).toEqual(['common', 'user'])
    } finally {
      await ctx.stop()
    }
  })
})
