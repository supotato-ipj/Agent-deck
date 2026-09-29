/**
 * Listary 本地 HTTP API 的唯一 I/O 层（工单07）：仅发往本机回环（host 常量收口在
 * engine.ts，不取自输入）；每次请求新建连接、用完即关（API 无 keep-alive）。
 * 连接失败/超时抛 ListaryNetworkError（→ offline）；非法 JSON 抛普通异常（→ error）；
 * 服务端错误载荷（ok:false）原样上交，由 classifyFailure 分类。
 */
import http from 'node:http'
import {
  BASE_HOST,
  HTTP_TIMEOUT_MS,
  ListaryNetworkError,
  SEARCH_PATH,
  buildRequest,
} from './engine'

export interface ListaryEndpoint {
  /** Listary 本地 API 端口（config.json search.port 下发；验收指假端口复现引擎离线） */
  port: number
  timeoutMs?: number
}

export function listarySearch(endpoint: ListaryEndpoint, query: string, limit: number, offset: number): Promise<unknown> {
  const body = JSON.stringify(buildRequest(query, limit, offset))
  const timeoutMs = endpoint.timeoutMs ?? HTTP_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: BASE_HOST,
      port: endpoint.port,
      path: SEARCH_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
      },
      agent: false,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    req.on('timeout', () => {
      req.destroy(new ListaryNetworkError(`listary timeout after ${timeoutMs}ms`))
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(err instanceof ListaryNetworkError ? err : new ListaryNetworkError(String(err.code ?? err.message)))
    })
    req.end(body)
  })
}
