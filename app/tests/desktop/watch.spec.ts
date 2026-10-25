/**
 * 桌面目录看门狗测试（工单06）：settle 合并语义 + 真临时目录 fs.watch 集成。
 * 全程真时钟——fs.watch 事件走 libuv 异步轮，假定时器拦不到它。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { watchDesktopRoots } from '../../src/main/desktop/watch'

const dirs: string[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mkRoot(): { user: string; common: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-watch-'))
  dirs.push(root)
  const user = path.join(root, 'user')
  const common = path.join(root, 'common')
  fs.mkdirSync(user)
  fs.mkdirSync(common)
  return { user, common }
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('watchDesktopRoots（真 fs.watch 集成）', () => {
  it('新建文件：settle 窗口内不触发，稳定后恰好一次', async () => {
    const roots = mkRoot()
    const onChange = vi.fn()
    watchDesktopRoots(roots, onChange, { settleMs: 120 })
    fs.writeFileSync(path.join(roots.user, 'new.txt'), 'x')
    await sleep(50)
    expect(onChange).not.toHaveBeenCalled() // 事件已到但窗口未满
    await sleep(400)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('删除与跨根写入并入同一轮（风暴合并为一次）', async () => {
    const roots = mkRoot()
    const file = path.join(roots.user, 'a.txt')
    fs.writeFileSync(file, 'x')
    const onChange = vi.fn()
    watchDesktopRoots(roots, onChange, { settleMs: 120 })
    fs.unlinkSync(file)
    fs.writeFileSync(path.join(roots.common, 'b.txt'), 'x')
    fs.writeFileSync(path.join(roots.common, 'c.txt'), 'x')
    await sleep(600)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('停听后不再触发', async () => {
    const roots = mkRoot()
    const onChange = vi.fn()
    const stop = watchDesktopRoots(roots, onChange, { settleMs: 80 })
    stop()
    fs.writeFileSync(path.join(roots.user, 'new.txt'), 'x')
    await sleep(400)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('目录不存在不抛错（1Hz 重扫描兜底网在场）', () => {
    expect(() =>
      watchDesktopRoots({ user: 'Z:\\gone\\user', common: 'Z:\\gone\\common' }, () => {}, { settleMs: 10 }),
    ).not.toThrow()
  })
})
