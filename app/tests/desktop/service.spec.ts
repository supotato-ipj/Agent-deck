/**
 * 桌面承载服务测试（工单05）：扫描→状态、失败沿用上一轮、图标预热闹、
 * 启动限当前扫描池内路径（拒绝任意路径执行）。依赖束全假源，纯离线。
 */
import { Context } from 'cordis'
import { describe, expect, it, vi } from 'vitest'
import { DesktopService } from '../../src/main/services/desktop'
import type { DesktopDirEntry } from '../../src/main/desktop/scan'

function entry(name: string, over: Partial<DesktopDirEntry> = {}): DesktopDirEntry {
  return { name, isDirectory: false, isHidden: false, mtimeMs: 1000, ...over }
}

function fakeWorld(user: DesktopDirEntry[], common: DesktopDirEntry[] = []) {
  const extract = vi.fn(async (p: string) => `icon:${p}`)
  const open = vi.fn(async () => '')
  let userEntries = user
  let commonEntries = common
  let failScan = false
  const ctx = new Context()
  const svc = new DesktopService(ctx, {
    roots: { user: 'C:\\u', common: 'C:\\c' },
    deps: {
      listDir: (dir: string) => {
        if (failScan) throw new Error('dir gone')
        return dir === 'C:\\u' ? userEntries : commonEntries
      },
      extractIcon: extract,
      open,
    },
  })
  return {
    ctx,
    svc,
    extract,
    open,
    setEntries(v: { user?: DesktopDirEntry[]; common?: DesktopDirEntry[] }) {
      if (v.user) userEntries = v.user
      if (v.common) commonEntries = v.common
    },
    failNextScans() { failScan = true },
    healScans() { failScan = false },
  }
}

describe('DesktopService', () => {
  it('扫描合并去重入池：state 给条目与指纹，随刷新收敛', async () => {
    const w = fakeWorld(
      [entry('Kimi Code.lnk'), entry('note.txt')],
      [entry('Kimi Code.lnk', { mtimeMs: 9 }), entry('WeChat.lnk')],
    )
    await w.ctx.start()
    try {
      const s = w.svc.state()
      expect(s.items.map((i) => i.name).sort()).toEqual(['Kimi Code.lnk', 'WeChat.lnk', 'note.txt'])
      expect(s.items.find((i) => i.name === 'Kimi Code.lnk')?.path).toBe('C:\\u\\Kimi Code.lnk')
      expect(s.fingerprint).toBeTruthy()

      w.setEntries({ user: [entry('Kimi Code.lnk'), entry('note.txt'), entry('new', { isDirectory: true })] })
      w.svc.refresh()
      expect(w.svc.state().items).toHaveLength(4)
      expect(w.svc.state().fingerprint).not.toBe(s.fingerprint)
    } finally {
      await w.ctx.stop()
    }
  })

  it('扫描失败沿用上一轮条目（桌面不闪空；与会话「失败给空表」语义之别）', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    const before = w.svc.state()
    w.failNextScans()
    w.svc.refresh()
    expect(w.svc.state()).toEqual(before)
    w.healScans()
    w.svc.refresh()
    expect(w.svc.state().items.map((i) => i.name)).toEqual(['a.lnk'])
    await w.ctx.stop()
  })

  it('刷新为新键预热图标；icon() 缓存命中不重提取', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    try {
      const key = w.svc.state().items[0].iconKey
      await new Promise((r) => setTimeout(r, 0)) // 预热 Promise 落定
      expect(w.extract).toHaveBeenCalledWith('C:\\u\\a.lnk')
      expect(await w.svc.icon(key)).toBe('icon:C:\\u\\a.lnk')
      expect(w.extract).toHaveBeenCalledTimes(1)
    } finally {
      await w.ctx.stop()
    }
  })

  it('launch：池内路径经 open 启动；任意路径拒绝；open 报错透传', async () => {
    const w = fakeWorld([entry('a.lnk')])
    await w.ctx.start()
    try {
      const ok = await w.svc.launch('C:\\u\\a.lnk')
      expect(ok).toEqual({ ok: true })
      expect(w.open).toHaveBeenCalledWith('C:\\u\\a.lnk')

      const outside = await w.svc.launch('C:\\Windows\\System32\\cmd.exe')
      expect(outside.ok).toBe(false)
      expect(w.open).toHaveBeenCalledTimes(1)

      w.open.mockResolvedValueOnce('找不到应用程序')
      const err = await w.svc.launch('C:\\u\\a.lnk')
      expect(err).toEqual({ ok: false, error: '找不到应用程序' })
    } finally {
      await w.ctx.stop()
    }
  })

  it('icon() 对渲染层迟到的旧键：按缓存键反解路径仍可提取', async () => {
    const w = fakeWorld([entry('a.lnk', { mtimeMs: 5 })])
    await w.ctx.start()
    try {
      // 快照轮之间 mtime 变过：渲染层拿到的键可能不在当前预热队列
      const staleKey = `C:\\u\\a.lnk|999`
      expect(await w.svc.icon(staleKey)).toBe('icon:C:\\u\\a.lnk')
    } finally {
      await w.ctx.stop()
    }
  })
})
