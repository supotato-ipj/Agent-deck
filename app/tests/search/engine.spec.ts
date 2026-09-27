/**
 * Listary 引擎纯逻辑测试（工单07，tests/test_listary_engine.py 移植）：
 * 防抖窗口、请求构造（offset 翻页）、响应解析、错误分类、限流退避曲线。
 * 路径显示的父子拆分与截断随渲染层走（视觉行为，真机电池盯）。
 */
import { describe, expect, it } from 'vitest'
import {
  BASE_HOST,
  BASE_PORT,
  DEFAULT_LIMIT,
  Debouncer,
  ListaryNetworkError,
  SEARCH_PATH,
  backoffDelay,
  buildRequest,
  classifyFailure,
  parseResponse,
} from '../../src/main/search/engine'

describe('Debouncer（时间可注入防抖）', () => {
  it('窗口内连续变更合并到最后一词', () => {
    const d = new Debouncer(200)
    d.feed('r', 0)
    d.feed('re', 50)
    d.feed('rea', 100)
    expect(d.due(150)).toBeNull() // 还在窗口内
    expect(d.due(290)).toBeNull() // 距最后一次改动不足 200ms
    expect(d.due(300)).toBe('rea')
    expect(d.due(500)).toBeNull() // 只发一次
  })

  it('更新的查询词胜出', () => {
    const d = new Debouncer(200)
    d.feed('readme', 0)
    d.feed('readme.md', 100)
    expect(d.due(310)).toBe('readme.md')
  })

  it('同词不重发', () => {
    const d = new Debouncer(200)
    d.feed('abc', 0)
    expect(d.due(200)).toBe('abc')
    d.feed('abc', 1000)
    expect(d.due(1200)).toBeNull()
  })

  it('空查询永不到期', () => {
    const d = new Debouncer(200)
    d.feed('', 0)
    expect(d.due(500)).toBeNull()
  })

  it('cancel 丢弃在途查询', () => {
    const d = new Debouncer(200)
    d.feed('abc', 0)
    d.cancel()
    expect(d.due(1000)).toBeNull()
  })

  it('reset 允许重发同词（退待机再激活语义）', () => {
    const d = new Debouncer(200)
    d.feed('abc', 0)
    expect(d.due(200)).toBe('abc')
    d.reset()
    d.feed('abc', 1000)
    expect(d.due(1200)).toBe('abc')
  })

  it('feedDue 绕过防抖窗口立即到期（引擎离线/限流重试用）', () => {
    const d = new Debouncer(200)
    d.feed('abc', 100_000)
    expect(d.due(100_050)).toBeNull() // 窗口内
    d.feedDue('abc')
    expect(d.due(100_060)).toBe('abc') // 立即到期
  })

  it('feedDue 允许重发同词；空词不入队', () => {
    const d = new Debouncer(200)
    d.feedDue('abc')
    expect(d.due(0)).toBe('abc')
    d.feedDue('abc')
    expect(d.due(1000)).toBe('abc') // 已发过，重复 feedDue 仍去重
    d.feedDue('')
    expect(d.due(2000)).toBeNull()
  })
})

describe('buildRequest（请求构造）', () => {
  it('默认 limit=8 offset=0', () => {
    expect(buildRequest('word')).toEqual({ query: 'word', limit: DEFAULT_LIMIT, offset: 0 })
  })

  it('offset 翻页透传', () => {
    expect(buildRequest('word', 20, 40)).toEqual({ query: 'word', limit: 20, offset: 40 })
  })

  it('端点常量只指本机回环', () => {
    expect(BASE_HOST).toBe('127.0.0.1')
    expect(BASE_PORT).toBe(38431)
    expect(SEARCH_PATH).toBe('/api/v1/search')
  })
})

describe('parseResponse（响应解析）', () => {
  const payload = (results: unknown[], total: number): unknown => ({
    ok: true,
    data: { query: 'q', total, offset: 0, limit: 8, count: results.length, results },
  })

  it('解析行字段与总数（snake_case → 驼峰）', () => {
    const r = parseResponse(payload([
      { path: 'D:\\Work\\invoice.pdf', name: 'invoice.pdf', type: 'file', size_bytes: 1, modified_at: 'x', score: 9 },
    ], 42))
    expect(r.total).toBe(42)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toEqual({
      path: 'D:\\Work\\invoice.pdf', name: 'invoice.pdf', type: 'file', sizeBytes: 1, modifiedAt: 'x', score: 9,
    })
  })

  it('空结果', () => {
    const r = parseResponse(payload([], 0))
    expect(r.total).toBe(0)
    expect(r.items).toEqual([])
  })

  it('data 缺失退化为零结果而非崩溃', () => {
    expect(parseResponse({ ok: true, data: null })).toEqual({ total: 0, items: [] })
    expect(parseResponse('not a dict')).toEqual({ total: 0, items: [] })
  })

  it('超 limit 行数原样保留（截断归渲染层）', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ path: `C:\\f${i}.txt`, name: `f${i}.txt` }))
    expect(parseResponse(payload(rows, 12)).items).toHaveLength(12)
  })

  it('行内非对象跳过、缺失字段补默认', () => {
    const r = parseResponse(payload(['junk', { path: 'C:\\a.txt' }], 2))
    expect(r.items).toEqual([{
      path: 'C:\\a.txt', name: '', type: 'file', sizeBytes: 0, modifiedAt: '', score: 0,
    }])
  })
})

describe('classifyFailure（错误分类）', () => {
  it('网络不可达归 offline（不冒充其他故障）', () => {
    expect(classifyFailure(new ListaryNetworkError('ECONNREFUSED'))).toBe('offline')
  })

  it('SEARCH_UNAVAILABLE 归 offline（引擎未就绪）', () => {
    expect(classifyFailure({ ok: false, error: 'SEARCH_UNAVAILABLE' })).toBe('offline')
  })

  it('TOO_MANY_REQUESTS 归 rate_limited', () => {
    expect(classifyFailure({ ok: false, error: 'TOO_MANY_REQUESTS' })).toBe('rate_limited')
  })

  it('其他载荷错误归 error', () => {
    expect(classifyFailure({ ok: false, error: 'INTERNAL_ERROR' })).toBe('error')
  })

  it('ok 载荷不是失败', () => {
    expect(classifyFailure({ ok: true, data: {} })).toBeNull()
  })

  it('引擎在线但吐非法载荷归 error（不能冒充离线）', () => {
    expect(classifyFailure(new SyntaxError('bad json'))).toBe('error')
    expect(classifyFailure({})).toBe('error')
  })
})

describe('backoffDelay（限流退避曲线）', () => {
  it('0.5s 起步倍增封顶 5s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000])
  })
})
