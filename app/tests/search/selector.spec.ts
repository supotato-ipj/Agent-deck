/**
 * 搜索引擎选择器测试（工单13）：config 显式引擎 → 传输真源绑定的纯决策。
 * 假传输注入，无网络；auto 的探测语义在后续工单接入，过渡期回落 Listary。
 * 异常原样上抛是硬断言——offline/error 分类语义不受装配层影响。
 */
import { describe, expect, it } from 'vitest'
import { ListaryNetworkError } from '../../src/main/search/engine'
import { createEngineSearch, type EngineTransport } from '../../src/main/search/selector'

/** 记录型假传输：返回端口与查询词，便于断言「选了谁、用的哪个端口」 */
function fakeTransport(name: string): EngineTransport {
  return (endpoint: { port: number }, query: string) => {
    void endpoint
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

  it('auto 过渡期回落 Listary（探测在后续工单接入）', async () => {
    const search = createEngineSearch({
      engine: 'auto',
      listaryPort: 38431,
      everythingPort: 8080,
      listarySearchFn: fakeTransport('listary'),
      everythingSearchFn: fakeTransport('everything'),
    })
    await expect(search('word', 8, 0)).resolves.toBe('listary@38431:word')
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
