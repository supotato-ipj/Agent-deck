// 事件磁带 EventTape（工单205，spec #201 B 分支合刀批1 的前置模块票）：磁带四方法的
// 外部行为契约。seam = 工厂返回的四方法（母票决策7 定稿的对外接口）——只测公开语义，
// 不断言内部实现：半行容错与自愈、since 时间门、超时返回 null、waitStable 安静判据、
// 解析缓存不改变可见行为、构造默认超时与显式覆盖的关系。
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEventTape } from '../../accept/lib/event-tape'

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** 每例一个临时目录 + 其中的事件文件路径（磁带绑定的就是这一个文件） */
function tempEventsFile() {
  const dir = mkdtempSync(join(tmpdir(), 'event-tape-'))
  dirs.push(dir)
  return join(dir, 'events.jsonl')
}

/** 事件行（面板写事件的口径：t 是 Date.now() 毫秒，type 是事件名） */
function line(type: string, t: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ t, type, ...extra })
}

describe('事件磁带·四方法外部行为（工单205）', () => {
  it('all() 裸读全量：按文件序返回全部事件', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('boot', 100)}\n${line('desktop-rendered', 200)}\n`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.all().map((e) => e.type)).toEqual(['boot', 'desktop-rendered'])
  })

  it('wait() 超时返回 null（不抛错）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('boot', 100)}\n`, 'utf8')
    const tape = createEventTape(file)
    await expect(tape.wait('never', undefined, { timeoutMs: 120 })).resolves.toBeNull()
  })

  it('wait() 命中即返回「首个」匹配拍（既有 waitEvent 的 find 口径，不跳到最新）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('hit', 100, { n: 1 })}\n${line('hit', 200, { n: 2 })}\n`, 'utf8')
    const tape = createEventTape(file)
    const got = await tape.wait('hit', undefined, { timeoutMs: 500 })
    expect(got?.t).toBe(100)
  })

  it('since 门：all() 只认 e.t >= since 的拍', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100)}\n${line('a', 200)}\n${line('a', 300)}\n`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.all('a', undefined, { since: 200 }).map((e) => e.t)).toEqual([200, 300])
  })

  it('since 门：wait() 越过的拍不认——只等 since 之后的拍', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100)}\n${line('a', 200)}\n`, 'utf8')
    const tape = createEventTape(file)
    const got = await tape.wait('a', undefined, { since: 200, timeoutMs: 500 })
    expect(got?.t).toBe(200)
  })

  it('since 门：since 之后无匹配拍 → 超时 null（不拿 since 之前的拍充数）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100)}\n`, 'utf8')
    const tape = createEventTape(file)
    await expect(tape.wait('a', undefined, { since: 200, timeoutMs: 120 })).resolves.toBeNull()
  })

  it('latest() 现取最新一拍（既有 readEvents().filter(...).pop() 口径）', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100, { n: 1 })}\n${line('b', 150)}\n${line('a', 200, { n: 2 })}\n`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.latest('a')?.t).toBe(200)
    expect(tape.latest('a')?.n).toBe(2)
  })

  it('latest() 无匹配拍 → null', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100)}\n`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.latest('nope')).toBeNull()
  })

  it('all() 支持 type 过滤与谓词过滤', () => {
    const file = tempEventsFile()
    writeFileSync(
      file,
      `${line('a', 100, { n: 1 })}\n${line('b', 200, { n: 5 })}\n${line('a', 300, { n: 9 })}\n`,
      'utf8',
    )
    const tape = createEventTape(file)
    expect(tape.all('a').map((e) => e.t)).toEqual([100, 300])
    expect(tape.all(undefined, (e) => e.n >= 5).map((e) => e.t)).toEqual([200, 300])
  })

  it('waitStable() 等「最后一拍距今安静」：安静够 quietMs 即交出那一拍', async () => {
    const file = tempEventsFile()
    const past = Date.now() - 5000
    writeFileSync(file, `${line('a', past)}\n`, 'utf8')
    const tape = createEventTape(file)
    const got = await tape.waitStable('a', 1000, 3000)
    expect(got?.t).toBe(past)
  })

  it('waitStable() 还在动的拍不放手：最后一拍刚来 → 超时 null', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', Date.now())}\n`, 'utf8')
    const tape = createEventTape(file)
    await expect(tape.waitStable('a', 5000, 200)).resolves.toBeNull()
  })

  it('waitStable() 安静判据只看「最后一拍」：前面那拍再旧也不算数', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', Date.now() - 9000)}\n${line('a', Date.now())}\n`, 'utf8')
    const tape = createEventTape(file)
    await expect(tape.waitStable('a', 2000, 200)).resolves.toBeNull()
  })

  it('waitStable() 交出的是该类型的最后一拍（不是第一拍）', async () => {
    const file = tempEventsFile()
    const past = Date.now() - 5000
    writeFileSync(file, `${line('a', past, { n: 1 })}\n${line('a', past + 1, { n: 2 })}\n`, 'utf8')
    const tape = createEventTape(file)
    const got = await tape.waitStable('a', 1000, 3000)
    expect(got?.n).toBe(2)
  })

  it('半行容错：写了一半的行被静默滤过（不抛错、不算一拍）', () => {
    const file = tempEventsFile()
    // 第二行只写了一半（面板正在往事件文件里追加）
    writeFileSync(file, `${line('boot', 100)}\n{"type":"half","t":200`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.all().map((e) => e.type)).toEqual(['boot'])
  })

  it('半行自愈：那一行补写完之后，下一拍就认（先滤过、后自愈）', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('boot', 100)}\n{"type":"half","t":200`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.all().map((e) => e.type)).toEqual(['boot'])
    // 面板把这行补写完
    appendFileSync(file, '}\n', 'utf8')
    expect(tape.all().map((e) => e.type)).toEqual(['boot', 'half'])
  })

  it('半行自愈在 wait() 上同样成立：半行不算命中，补完即命中', async () => {
    const file = tempEventsFile()
    writeFileSync(file, '{"type":"half","t":200', 'utf8')
    const tape = createEventTape(file)
    // 半行在 → 不是命中拍
    await expect(tape.wait('half', undefined, { timeoutMs: 150 })).resolves.toBeNull()
    // 补完 → 命中
    appendFileSync(file, '}\n', 'utf8')
    const got = await tape.wait('half', undefined, { timeoutMs: 1000 })
    expect(got?.t).toBe(200)
  })

  it('事件文件缺位 → 空数组/null，不抛错（面板还没起、fresh worktree 场景）', async () => {
    const file = tempEventsFile() // 故意不落文件
    const tape = createEventTape(file)
    expect(tape.all()).toEqual([])
    expect(tape.latest('a')).toBeNull()
    await expect(tape.wait('a', undefined, { timeoutMs: 120 })).resolves.toBeNull()
  })

  it('解析缓存：文件没变 → 不重复解析（读盘一次即复用已解析结果）', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100)}\n`, 'utf8')
    const tape = createEventTape(file)
    const spy = vi.spyOn(fs, 'readFileSync')
    try {
      expect(tape.all().map((e) => e.t)).toEqual([100])
      expect(tape.all().map((e) => e.t)).toEqual([100])
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('解析缓存：文件长了 → 立刻看到新事件（缓存不拿陈数据充数）', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100)}\n`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.all().map((e) => e.t)).toEqual([100])
    appendFileSync(file, `${line('a', 200)}\n`, 'utf8')
    expect(tape.all().map((e) => e.t)).toEqual([100, 200])
  })

  it('解析缓存：大小相同但 mtime 变 → 看到新内容（缓存键含 mtime）', () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100)}\n`, 'utf8')
    const tape = createEventTape(file)
    expect(tape.all().map((e) => e.t)).toEqual([100])
    // 同样长度的新内容，并把 mtime 显式推到未来——只有键含 mtime 才认得出这次改写
    writeFileSync(file, `${line('a', 999)}\n`, 'utf8')
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)
    expect(tape.all().map((e) => e.t)).toEqual([999])
  })
})

// 超时语义用假时钟断（时间是系统边界，可 mock——见 tdd skill 的 mocking 口径）：
// 真实时钟跑 6s/8s 太慢，而「哪一档收工」正是母票决策8 要保真的东西。
describe('超时语义（工单205：两档默认保真 + 显式覆盖）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 造一个永远等不到的事件磁带（文件里只有别的类型） */
  function neverHitTape(defaultTimeoutMs: number) {
    const file = tempEventsFile()
    writeFileSync(file, `${line('boot', 100)}\n`, 'utf8')
    return createEventTape(file, { defaultTimeoutMs })
  }

  it('两档默认超时保真：6000 档收工时 8000 档还在等（不「顺手统一」成单一档）', async () => {
    const a = neverHitTape(6000)
    const b = neverHitTape(8000)
    let aDone = false
    let bDone = false
    const pa = a.wait('never').then((v) => { aDone = true; return v })
    const pb = b.wait('never').then((v) => { bDone = true; return v })

    await vi.advanceTimersByTimeAsync(7000)
    expect(aDone).toBe(true) // 6000 档已收工
    expect(bDone).toBe(false) // 8000 档还在等

    await vi.advanceTimersByTimeAsync(2000)
    expect(await pa).toBeNull()
    expect(await pb).toBeNull()
  })

  it('构造默认档生效：未到构造档不收工，超时返回 null（不抛错）', async () => {
    const tape = neverHitTape(6000)
    let done = false
    const p = tape.wait('never').then((v) => { done = true; return v })

    await vi.advanceTimersByTimeAsync(5900)
    expect(done).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(true)
    expect(await p).toBeNull()
  })

  it('显式 timeoutMs 覆盖构造默认档：不等满构造档就收工', async () => {
    const tape = neverHitTape(6000)
    let done = false
    const p = tape.wait('never', undefined, { timeoutMs: 500 }).then((v) => { done = true; return v })

    // 1500ms：越过显式的 500ms，远不到构造档 6000ms
    await vi.advanceTimersByTimeAsync(1500)
    expect(done).toBe(true)
    expect(await p).toBeNull()
  })
})
