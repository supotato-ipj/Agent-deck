// 事件磁带 EventTape（工单205，spec #201 B 分支合刀批1 的前置模块票）：磁带四方法的
// 外部行为契约。seam = 工厂返回的四方法（母票决策7 定稿的对外接口）——只测公开语义，
// 不断言内部实现：半行容错与自愈、since 时间门、超时返回 null、waitStable 安静判据、
// 解析缓存不改变可见行为、构造默认超时与显式覆盖的关系。
//
// 工单205 独立审计补测（变异存活欠账）：审计 31 个变异里 10 个存活，4 个落在批1 迁移
// 的 214 个调用点主路径上——根因是「所有 wait 命中场景都是事件在调用前就已存在」，
// 没有一条用例断言「事件在等待期间到达能被接到」。本文件按此补齐四条盲区：
//   必补1 wait() 的谓词路径（第一拍不满足、第二拍满足 → 交出第二拍）
//   必补2 wait() 的等待期间重读（等待途中落盘的新事件能被接到）
//   必补3 waitStable() 的等待期间重读（等待途中的更新拍才是交出的那一拍）
//   必补4 latest() 的 pred 腿与 since 腿（两条腿此前零覆盖）
// 外加三处口径同步：d.ts 的 pred 放宽为 | null、解析缓存注释改如实口径、
// 兜底默认档与 waitStable 默认值各钉一条断言。
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

// —— 工单205 审计补测·必补1/4：谓词路径与 latest 的两条腿 ——
// 审计根因：既有 wait 命中场景全是「事件在调用前就存在」，谓词这条腿（批1 迁移的 214 个
// 调用点里 206 个带谓词）从未被独立断言过——wait 独吞 pred 也照样全绿。
describe('谓词路径与 latest 的两条腿（工单205 审计补测）', () => {
  it('必补1 wait() 谓词路径：只有第二拍满足谓词 → 交出第二拍（谓词真的参与了筛选）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('hit', 100, { n: 1 })}\n${line('hit', 200, { n: 2 })}\n`, 'utf8')
    const tape = createEventTape(file)
    const got = await tape.wait('hit', (e) => e.n === 2, { timeoutMs: 500 })
    // 谓词若被独吞，find 会交出第一拍（t=100）
    expect(got?.t).toBe(200)
    expect(got?.n).toBe(2)
  })

  it('必补1 wait() 谓词路径：无一拍满足谓词 → 超时 null（不拿不满足的那一拍充数）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('hit', 100, { n: 1 })}\n${line('hit', 200, { n: 2 })}\n`, 'utf8')
    const tape = createEventTape(file)
    await expect(tape.wait('hit', (e) => e.n === 99, { timeoutMs: 120 })).resolves.toBeNull()
  })

  it('必补4 latest() 谓词腿：只认满足谓词的拍（不取全场最新那一拍）', () => {
    const file = tempEventsFile()
    writeFileSync(
      file,
      `${line('a', 100, { n: 1 })}\n${line('a', 200, { n: 2 })}\n${line('a', 300, { n: 3 })}\n`,
      'utf8',
    )
    const tape = createEventTape(file)
    // 谓词若被独吞，latest 会交出全场最新那一拍（t=300）
    expect(tape.latest('a', (e) => e.n === 2)?.t).toBe(200)
  })

  it('必补4 latest() 的 pred 腿与 since 腿同时生效：断任一条腿都转红', () => {
    const file = tempEventsFile()
    writeFileSync(
      file,
      `${line('a', 100, { n: 1 })}\n${line('a', 200, { n: 2 })}\n${line('a', 300, { n: 3 })}\n`,
      'utf8',
    )
    const tape = createEventTape(file)
    // 两条腿同时上：pred 选出 n=2 那拍、since=150 又把更早的 t=100 挡在门外 → 交出 t=200
    // 断 pred（独吞谓词）→ 命中集变成 t>=150 的两拍 → 交出全场最新 t=300（红）
    // 断 since（忽略时间门）→ 这条断言仍绿，故下面那条负向断言才是 since 腿的杀手
    expect(tape.latest('a', (e) => e.n === 2, { since: 150 })?.t).toBe(200)
    // since 门把那唯一命中拍（t=200）排除 → null（since 腿此前零覆盖）
    // 断 since → 会交出 t=200（红）
    expect(tape.latest('a', (e) => e.n === 2, { since: 250 })).toBeNull()
  })

  it('附带A null 谓词被接受：等价于「无谓词」（正典 8 处调用点显式传 null 作谓词）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('a', 100, { n: 1 })}\n${line('a', 200, { n: 2 })}\n`, 'utf8')
    const tape = createEventTape(file)
    // 类型口径：d.ts 的 pred 放宽为 | null，严格 TS 下 pred?: 不接受 null
    expect(tape.latest('a', null)?.t).toBe(200)
    expect(tape.all('a', null).map((e) => e.t)).toEqual([100, 200])
    await expect(tape.wait('a', null, { timeoutMs: 500 })).resolves.toMatchObject({ t: 100 })
  })
})

// —— 工单205 审计补测·必补2/3 + 附带C：等待语义（等待期间重读）与默认档 ——
// 假时钟断（时间是系统边界，可 mock——见 tdd skill 的 mocking 口径）：
// 等待期语义靠真实计时器既慢又不确定（等 6s/12s），假时钟能把「等多久」钉成毫秒级断言。
describe('等待语义（工单205 审计补测：等待期间重读 + 默认档）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('必补2 wait() 等待期间重读：等待途中落盘的新事件能被接到（不是只读一次盘）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('boot', 100)}\n`, 'utf8')
    const tape = createEventTape(file)
    let resolved = false
    const p = tape.wait('late', undefined, { timeoutMs: 5000 }).then((v) => {
      resolved = true
      return v
    })

    // 先让 wait 至少读过一轮盘（读盘发生在落盘之前）
    await vi.advanceTimersByTimeAsync(200)
    expect(resolved).toBe(false)

    // 等待途中面板落盘了新事件
    appendFileSync(file, `${line('late', 777, { n: 7 })}\n`, 'utf8')
    // 推进到超时线：若实现是「整个等待只读一次盘」，这里干净收工返 null（断言红）
    await vi.advanceTimersByTimeAsync(5000)

    const got = await p
    expect(got?.n).toBe(7)
    expect(got?.t).toBe(777)
  })

  it('必补3 waitStable() 等待期间重读：等待途中的更新拍才是交出的那一拍', async () => {
    const file = tempEventsFile()
    const t0 = Date.now()
    writeFileSync(file, `${line('a', t0, { n: 1 })}\n`, 'utf8')
    const tape = createEventTape(file)
    const p = tape.waitStable('a', 600, 5000)

    await vi.advanceTimersByTimeAsync(200)
    // 等待途中落盘了更新的第二拍
    appendFileSync(file, `${line('a', Date.now(), { n: 2 })}\n`, 'utf8')
    await vi.advanceTimersByTimeAsync(5000)

    const got = await p
    // 若实现是「整个等待只读一次盘」，交出的会是第一拍（n=1）
    expect(got?.n).toBe(2)
  })

  it('附带C 构造省略 defaultTimeoutMs → 兜底 6000 档（d.ts 明写「省略时兜底 6000」）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('boot', 100)}\n`, 'utf8')
    const tape = createEventTape(file) // 省略 options → 走兜底档
    let done = false
    const p = tape.wait('never').then((v) => {
      done = true
      return v
    })

    await vi.advanceTimersByTimeAsync(5900)
    expect(done).toBe(false) // 还没到 6000 兜底档

    await vi.advanceTimersByTimeAsync(200)
    expect(done).toBe(true)
    expect(await p).toBeNull()
  })

  it('附带C waitStable() 默认安静判据 2000ms：1500ms 时还不算安静（默认档不是更小的值）', async () => {
    const file = tempEventsFile()
    const t0 = Date.now()
    writeFileSync(file, `${line('a', t0)}\n`, 'utf8')
    const tape = createEventTape(file)
    let done = false
    const p = tape.waitStable('a').then((v) => {
      done = true
      return v
    })

    await vi.advanceTimersByTimeAsync(1500)
    expect(done).toBe(false) // 默认 quietMs=2000：1500ms 未达安静线

    await vi.advanceTimersByTimeAsync(1000)
    expect(done).toBe(true)
    expect((await p)?.t).toBe(t0)
  })

  it('附带C waitStable() 默认超时 12000ms：不到 12s 不收工，超时返 null（默认档不是更小的值）', async () => {
    const file = tempEventsFile()
    writeFileSync(file, `${line('boot', 100)}\n`, 'utf8') // 没有该类型的事件 → 永远不安静
    const tape = createEventTape(file)
    let done = false
    const p = tape.waitStable('never').then((v) => {
      done = true
      return v
    })

    await vi.advanceTimersByTimeAsync(11900)
    expect(done).toBe(false)

    await vi.advanceTimersByTimeAsync(300)
    expect(done).toBe(true)
    expect(await p).toBeNull()
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
