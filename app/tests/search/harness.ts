/**
 * 搜索测试共享假源束（service.spec 与 contract.spec 共用）：合成时钟 +
 * 记录型 search/open/reveal + 换挡应答。放非 spec 文件——跨 spec 导入会重跑 describe。
 */
import type { SearchResultItem, SearchUiState } from '../../src/shared/contract'
import type { SearchDeps } from '../../src/main/services/search'
import { ListaryNetworkError } from '../../src/main/search/engine'

export function okPayload(items: Array<Record<string, unknown>>, total?: number): unknown {
  return { ok: true, data: { query: 'q', total: total ?? items.length, offset: 0, limit: 8, count: items.length, results: items } }
}

export function harness() {
  let t = 0
  const calls: Array<{ query: string; limit: number; offset: number }> = []
  const opened: string[] = []
  const revealed: string[] = []
  let openError = ''
  let respond: (query: string) => unknown = (q) => okPayload([{ path: `C:\\${q}.txt`, name: `${q}.txt`, type: 'file' }])
  const deps: SearchDeps = {
    search: async (query, limit, offset) => {
      calls.push({ query, limit, offset })
      return respond(query)
    },
    open: async (p) => {
      opened.push(p)
      return openError
    },
    reveal: (p) => {
      revealed.push(p)
    },
    now: () => t,
  }
  return {
    deps,
    calls,
    opened,
    revealed,
    advance(ms: number) {
      t += ms
    },
    respondWith(fn: (query: string) => unknown) {
      respond = fn
    },
    goOffline() {
      respond = () => {
        throw new ListaryNetworkError('ECONNREFUSED')
      }
    },
    goBroken() {
      respond = () => {
        throw new Error('bad json')
      }
    },
    goRateLimited() {
      respond = () => ({ ok: false, error: 'TOO_MANY_REQUESTS' })
    },
    failOpen(message: string) {
      openError = message
    },
  }
}

export interface SearchObservations {
  states: SearchUiState[]
  results: Array<{ total: number; items: SearchResultItem[] }>
}

/** 让在途 async search 落定（假源同拍 resolve，微任务即清） */
export const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
