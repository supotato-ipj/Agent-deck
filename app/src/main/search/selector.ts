/**
 * 搜索引擎选择装配（工单13）：config 显式引擎 → 传输真源绑定；搜索服务状态机
 * 保持引擎无感（deps.search 注入即换源）。auto 的一次探测语义在后续工单接入——
 * 过渡期回落 Listary（现役行为，存量用户零感知）。传输源可注入（测试假源），
 * 所选传输的异常原样上抛：offline/error 分类语义不受装配层影响。
 */
import { everythingSearch, listarySearch, type EverythingEndpoint, type ListaryEndpoint } from './client'
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
  listarySearchFn?: EngineTransport
  everythingSearchFn?: EngineTransport
}

export function createEngineSearch(options: EngineSelectorOptions): (query: string, limit: number, offset: number) => Promise<unknown> {
  const listary = options.listarySearchFn ?? listarySearch
  const everything = options.everythingSearchFn ?? everythingSearch
  if (options.engine === 'everything') {
    const endpoint: EverythingEndpoint = { port: options.everythingPort }
    return (query, limit, offset) => everything(endpoint, query, limit, offset)
  }
  const endpoint: ListaryEndpoint = { port: options.listaryPort }
  return (query, limit, offset) => listary(endpoint, query, limit, offset)
}
