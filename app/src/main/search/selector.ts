/**
 * 搜索引擎选择装配（工单13 显式锁定 / 工单14 auto 一次探测）：config 引擎选择 →
 * 传输真源绑定；搜索服务状态机保持引擎无感（deps.search 注入即换源）。
 * auto = 首次查询前惰性探针一次（可达优先 Everything，否则 Listary），选择缓存于
 * 本装配器生命周期（生产 = SearchService 单例，即进程生命周期；服务重插会重探，
 * 插件宿主不重插搜索服务）——会话内不重探、不逐查询回退，Everything 中途退出由
 * 服务层离线语义兜底（Python a7bd4ad 语义平移）。传输源/探针可注入（测试假源），
 * 所选传输的异常原样上抛：offline/error 分类语义不受装配层影响。
 */
import { everythingProbe, everythingSearch, listarySearch } from './client'
import type { SearchEngineChoice } from './engine'

/** 传输源形状（真源 = client 两引擎；测试注入假源） */
export type EngineTransport = (
  endpoint: { port: number },
  query: string,
  limit: number,
  offset: number,
) => Promise<unknown>

export interface EngineSelectorOptions {
  engine: SearchEngineChoice
  /** Listary 本地 API 端口（config.json search.port） */
  listaryPort: number
  /** Everything http_server 插件端口（config.json search.everythingPort） */
  everythingPort: number
  /** Everything 可达性探针（真源 = client.everythingProbe；测试注入假探针） */
  everythingProbeFn?: (endpoint: { port: number }) => Promise<boolean>
  listarySearchFn?: EngineTransport
  everythingSearchFn?: EngineTransport
}

/** 绑定好端口的查询函数（选择落定后的形状） */
type BoundSearch = (query: string, limit: number, offset: number) => Promise<unknown>

export function createEngineSearch(options: EngineSelectorOptions): BoundSearch {
  const listary = options.listarySearchFn ?? listarySearch
  const everything = options.everythingSearchFn ?? everythingSearch
  const bindEverything: BoundSearch = (query, limit, offset) => everything({ port: options.everythingPort }, query, limit, offset)
  const bindListary: BoundSearch = (query, limit, offset) => listary({ port: options.listaryPort }, query, limit, offset)
  if (options.engine === 'everything') return bindEverything
  if (options.engine === 'listary') return bindListary
  // auto（工单14）：探针在首次查询时惰性触发，选择以 Promise 缓存——跨查询恰好
  // 探测一次，在途并发查询共享同一次探测（gate 测试盯的就是它）。探针真源永不抛
  //（失败 = false）；注入探针若抛出则复位缓存重探下次查询，不把单次异常焊死成永久失败。
  const probe = options.everythingProbeFn ?? everythingProbe
  let chosen: Promise<BoundSearch> | null = null
  return (query, limit, offset) => {
    if (chosen === null) {
      chosen = probe({ port: options.everythingPort })
        .then((reachable) => (reachable ? bindEverything : bindListary))
        .catch((err: unknown) => {
          chosen = null
          throw err
        })
    }
    return chosen.then((search) => search(query, limit, offset))
  }
}
