/**
 * 搜索引擎选择器测试（工单13 显式锁定 / 工单14 auto 一次探测）：config 引擎选择 →
 * 传输真源绑定的纯决策。假传输 + 假探针注入，无网络；探针可达性/传输路由可换挡。
 * 异常原样上抛是硬断言——offline/error 分类语义不受装配层影响。
 */
import { describe, expect, it } from 'vitest'
import { ListaryNetworkError } from '../../src/main/search/engine'
import { createEngineSearch, type EngineTransport } from '../../src/main/search/selector'

/** 记录型假传输：返回端口与查询词，便于断言「选了谁、用的哪个端口」 */
function fakeTransport(name: string): EngineTransport {
  return (endpoint: { port: number }, query: string) => {
    void query
    return Promise.resolve(`${name}@${endpoint.port}:${query}`)
  }
}

describe('createEngineSearch（引擎选择·显式分支）', () => {
  it('engine=everything 走 Everything 传输，端口用 everythingPort', async () => {
    const search = createEngineSearch({
      engine: 'everything',
      listaryPort: 38431,
      everythingPort: 8080,
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(search('word', 8, 0)).resolves.toBe('everything@8080:word')
  })

  it('engine=listary 走 Listary 传输，端口用 listaryPort', async () => {
    const search = createEngineSearch({
      engine: 'listary',
      listaryPort: 38431,
      everythingPort: 8080,
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(search('word', 8, 0)).resolves.toBe('listary@38431:word')
  })

  it('显式引擎不触发探针（显式配置优先，两个显式值同等，工单14）', async () => {
    const throwProbe = () => {
      throw new Error('探针不应被调用')
    }
    const listary = createEngineSearch({
      engine: 'listary',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: throwProbe,
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(listary('x', 8, 0)).resolves.toBe('listary@38431:x')
    const everything = createEngineSearch({
      engine: 'everything',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: throwProbe,
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(everything('x', 8, 0)).resolves.toBe('everything@8080:x')
  })

  it('limit/offset 透传所选传输', async () => {
    const seen: Array<{ limit: number; offset: number }> = []
    const everything: EngineTransport = (_endpoint, _query, limit, offset) => {
      seen.push({ limit, offset })
      return Promise.resolve(null)
    }
    const search = createEngineSearch({
      engine: 'everything',
      listaryPort: 38431,
      everythingPort: 80,
      everythingSearchFn: everything,
    })
    await search('x', 20, 40)
    expect(seen).toEqual([{ limit: 20, offset: 40 }])
  })

  it('所选传输的异常原样上抛（offline 语义不受装配层影响）', async () => {
    const search = createEngineSearch({
      engine: 'everything',
      listaryPort: 38431,
      everythingPort: 80,
      everythingSearchFn: () => Promise.reject(new ListaryNetworkError('ECONNREFUSED')),
    })
    await expect(search('x', 8, 0)).rejects.toBeInstanceOf(ListaryNetworkError)
  })
})

describe('createEngineSearch（引擎选择·auto 一次探测，工单14）', () => {
  it('探针可达 → Everything 传输（everythingPort）；跨多次查询探针恰好一次', async () => {
    let probes = 0
    const search = createEngineSearch({
      engine: 'auto',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: () => {
        probes += 1
        return Promise.resolve(true)
      },
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(search('a', 8, 0)).resolves.toBe('everything@8080:a')
    await expect(search('b', 8, 0)).resolves.toBe('everything@8080:b')
    await expect(search('c', 8, 0)).resolves.toBe('everything@8080:c')
    expect(probes).toBe(1)
  })

  it('探针不可达 → Listary 传输（listaryPort），选择同样缓存', async () => {
    let probes = 0
    const search = createEngineSearch({
      engine: 'auto',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: () => {
        probes += 1
        return Promise.resolve(false)
      },
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(search('a', 8, 0)).resolves.toBe('listary@38431:a')
    await expect(search('b', 8, 0)).resolves.toBe('listary@38431:b')
    expect(probes).toBe(1)
  })

  it('探测在途的并发查询只探一次、各自命中同一引擎', async () => {
    let release!: (reachable: boolean) => void
    const gate = new Promise<boolean>((resolve) => {
      release = resolve
    })
    let probes = 0
    const search = createEngineSearch({
      engine: 'auto',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: () => {
        probes += 1
        return gate
      },
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    const first = search('a', 8, 0)
    const second = search('b', 8, 0)
    release(true)
    await expect(first).resolves.toBe('everything@8080:a')
    await expect(second).resolves.toBe('everything@8080:b')
    expect(probes).toBe(1)
  })

  it('选择缓存后不重探：Everything 中途挂掉仍走 Everything（离线语义归服务层，不切 Listary）', async () => {
    let probes = 0
    let everythingCalls = 0
    const search = createEngineSearch({
      engine: 'auto',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: () => {
        probes += 1
        return Promise.resolve(true)
      },
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: () => {
        everythingCalls += 1
        return everythingCalls === 1 ? Promise.resolve('ok') : Promise.reject(new ListaryNetworkError('ECONNREFUSED'))
      },
    })
    await expect(search('a', 8, 0)).resolves.toBe('ok')
    await expect(search('b', 8, 0)).rejects.toBeInstanceOf(ListaryNetworkError)
    await expect(search('c', 8, 0)).rejects.toBeInstanceOf(ListaryNetworkError)
    expect(probes).toBe(1)
    expect(everythingCalls).toBe(3)
  })

  it('双引擎都不可达：探针回落 Listary 后 Listary 也挂 → 异常照常上抛（服务层归 offline，工单14）', async () => {
    const search = createEngineSearch({
      engine: 'auto',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: () => Promise.resolve(false),
      listarySearchFn: () => Promise.reject(new ListaryNetworkError('ECONNREFUSED')),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(search('x', 8, 0)).rejects.toBeInstanceOf(ListaryNetworkError)
  })

  it('注入探针抛出：单次查询失败但缓存复位，下次查询重探（防单次异常焊死选择）', async () => {
    let probes = 0
    const search = createEngineSearch({
      engine: 'auto',
      listaryPort: 38431,
      everythingPort: 8080,
      everythingProbeFn: () => {
        probes += 1
        return probes === 1 ? Promise.reject(new Error('probe glitch')) : Promise.resolve(true)
      },
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(search('a', 8, 0)).rejects.toBeInstanceOf(Error)
    await expect(search('b', 8, 0)).resolves.toBe('everything@8080:b')
    expect(probes).toBe(2)
  })
})
