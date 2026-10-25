/** 数据面协议纯逻辑测试：lnk 目标解析代理（凑批/在途去重/缓存语义）+ 剪贴板读取代理
 * （工单30：回执驱动 Promise，trash 同法）。 */
import { describe, expect, it } from 'vitest'
import { ProxyClipboardRead, ProxyShortcutResolver } from '../src/main/dataplane-protocol'

/** setImmediate 凑批落定后再断言（setTimeout(0) 排在同时钟轮的 immediate 之后） */
function flushBatching(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('ProxyShortcutResolver（子进程侧 lnk 目标解析代理）', () => {
  it('未解析返回 null，同拍未命中凑成一批发问；重复未命中不重复登记', async () => {
    const asked: string[][] = []
    const r = new ProxyShortcutResolver((paths) => asked.push(paths))
    expect(r.resolve('C:\\a.lnk')).toBeNull()
    expect(r.resolve('C:\\b.lnk')).toBeNull()
    expect(r.resolve('C:\\a.lnk')).toBeNull()
    expect(asked).toEqual([]) // 凑批未落定
    await flushBatching()
    expect(asked).toEqual([['C:\\a.lnk', 'C:\\b.lnk']])
  })

  it('回复入缓存后命中；null 结果同样入缓存不重问', async () => {
    const asked: string[][] = []
    const r = new ProxyShortcutResolver((paths) => asked.push(paths))
    r.resolve('C:\\a.lnk')
    r.resolve('C:\\dead.lnk')
    await flushBatching()
    r.deliver({ 'C:\\a.lnk': 'C:\\target.exe', 'C:\\dead.lnk': null })
    expect(r.resolve('C:\\a.lnk')).toBe('C:\\target.exe')
    expect(r.resolve('C:\\dead.lnk')).toBeNull()
    r.resolve('C:\\a.lnk')
    r.resolve('C:\\dead.lnk')
    await flushBatching()
    expect(asked).toHaveLength(1) // 缓存命中不再发问
  })

  it('在途路径不重问；下一拍新路径再凑一批', async () => {
    const asked: string[][] = []
    const r = new ProxyShortcutResolver((paths) => asked.push(paths))
    r.resolve('C:\\a.lnk')
    await flushBatching()
    r.resolve('C:\\a.lnk') // 在途
    await flushBatching()
    expect(asked).toEqual([['C:\\a.lnk']])
    r.resolve('C:\\b.lnk')
    await flushBatching()
    expect(asked).toEqual([['C:\\a.lnk'], ['C:\\b.lnk']])
    r.deliver({ 'C:\\a.lnk': null })
    expect(r.resolve('C:\\a.lnk')).toBeNull() // 已入缓存（null 也不再问）
    await flushBatching()
    expect(asked).toHaveLength(2)
  })
})

describe('ProxyClipboardRead（子进程侧剪贴板读取代理，工单30）', () => {
  it('read 按 id 发问，回执驱动 Promise：null（无文件）与文件清单都能回', async () => {
    const asked: number[] = []
    const p = new ProxyClipboardRead((id) => asked.push(id))
    const first = p.read()
    const second = p.read()
    expect(asked).toEqual([1, 2])
    p.deliver(1, null)
    p.deliver(2, { paths: ['C:\a.txt'], effect: 'copy' })
    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toEqual({ paths: ['C:\a.txt'], effect: 'copy' })
  })

  it('未知 id 回执是迟到噪声：丢弃不影响在途请求', async () => {
    const asked: number[] = []
    const p = new ProxyClipboardRead((id) => asked.push(id))
    const first = p.read()
    p.deliver(99, null)
    p.deliver(1, null)
    await expect(first).resolves.toBeNull()
  })
})
