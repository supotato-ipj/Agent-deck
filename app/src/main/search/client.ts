/**
 * 搜索引擎本地 HTTP API 的唯一 I/O 层（工单07 Listary / 工单13 Everything）：
 * 仅发往本机回环（host 常量收口在 engine.ts，不取自输入）；每次请求新建连接、
 * 用完即关（API 无 keep-alive）。连接失败/超时抛 ListaryNetworkError（→ offline）；
 * 非法 JSON 抛普通异常（→ error）；服务端错误载荷（ok:false）原样上交，
 * 由 classifyFailure 分类。Everything 响应在传输层归一化成 Listary ok 载荷形状。
 */
import http from 'node:http'
import {
  BASE_HOST,
  EVERYTHING_PROBE_PATH,
  EVERYTHING_TIMEOUT_MS,
  HTTP_TIMEOUT_MS,
  ListaryNetworkError,
  SEARCH_PATH,
  buildRequest,
  everythingNormalize,
} from './engine'

export interface ListaryEndpoint {
  /** Listary 本地 API 端口（config.json search.port 下发；验收指假端口复现引擎离线） */
  port: number
  timeoutMs?: number
}

export interface EverythingEndpoint {
  /** Everything http_server 插件端口（config.json search.everythingPort 下发；默认 80） */
  port: number
  timeoutMs?: number
}

/**
 * 回环 JSON 请求（两引擎共用的传输骨架）：新建连接、超时/连接异常统一映射
 * ListaryNetworkError；载荷交给 handle 解析（解析异常 → 普通异常，不冒充离线）。
 * handle 第二参 = HTTP 状态码（探针判可达用；查询载荷解析不依赖它）。
 */
function loopbackRequest(
  endpoint: { port: number; timeoutMs?: number },
  fallbackTimeoutMs: number,
  path: string,
  method: 'GET' | 'POST',
  body: string | null,
  handle: (raw: string, status: number | undefined) => unknown,
): Promise<unknown> {
  const timeoutMs = endpoint.timeoutMs ?? fallbackTimeoutMs
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: BASE_HOST,
      port: endpoint.port,
      path,
      method,
      headers: body === null
        ? { Connection: 'close' }
        : {
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
          resolve(handle(Buffer.concat(chunks).toString('utf8'), res.statusCode))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
    req.on('timeout', () => {
      req.destroy(new ListaryNetworkError(`search engine timeout after ${timeoutMs}ms`))
    })
    req.on('error', (err: NodeJS.ErrnoException) => {
      reject(err instanceof ListaryNetworkError ? err : new ListaryNetworkError(String(err.code ?? err.message)))
    })
    req.end(body ?? undefined)
  })
}

export function listarySearch(endpoint: ListaryEndpoint, query: string, limit: number, offset: number): Promise<unknown> {
  const body = JSON.stringify(buildRequest(query, limit, offset))
  return loopbackRequest(endpoint, HTTP_TIMEOUT_MS, SEARCH_PATH, 'POST', body, (raw) => JSON.parse(raw))
}

/** Everything GET JSON（工单13，Python everything_http_search 平移）：查询词只进
 * 查询串；count=limit、offset 翻页、path_column/size_column 取全路径与大小。 */
export function everythingSearch(endpoint: EverythingEndpoint, query: string, limit: number, offset: number): Promise<unknown> {
  const params = new URLSearchParams({
    search: query,
    json: '1',
    count: String(limit),
    offset: String(offset),
    path_column: '1',
    size_column: '1',
  })
  return loopbackRequest(
    endpoint,
    EVERYTHING_TIMEOUT_MS,
    `/?${params.toString()}`,
    'GET',
    null,
    (raw) => everythingNormalize(JSON.parse(raw)),
  )
}

/**
 * Everything 可达性探针（工单14，Python _everything_reachable 平移）：
 * GET /?json=1&count=1&search=test，HTTP 200 = 可达。连接失败/超时/非 200
 * 一律 false——探测失败不是查询失败，本函数永不抛（引擎选择据此回落 Listary）。
 */
export async function everythingProbe(endpoint: EverythingEndpoint): Promise<boolean> {
  try {
    return (await loopbackRequest(
      endpoint,
      EVERYTHING_TIMEOUT_MS,
      EVERYTHING_PROBE_PATH,
      'GET',
      null,
      (_raw, status) => status === 200,
    )) === true
  } catch {
    return false
  }
}
