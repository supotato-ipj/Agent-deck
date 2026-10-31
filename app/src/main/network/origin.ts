/**
 * origin 正典化与匹配（工单338，ADR-0025 网络节「按精确 scheme／host／port 授予」）。
 *
 * 两条口径分离：
 * - **请求 URL**（包发起）：任意 path/query 均可（origin 内路径与方法同属授权——GET 不是
 *   安全边界），只要求 http(s) 且可解析；匹配键 = WHATWG `URL.origin`（scheme/host 小写、
 *   默认端口省略）——声明面与请求面用同一个键，不做自定义归一（自己写归一会漏默认端口、
 *   大小写、IPv6 方括号等边角）。
 * - **声明 origin**（manifest）：必须是「纯 origin」——不许带 path（除根）、query、hash、
 *   userinfo。声明面含糊即配置错误，早期报迁移问题而不是运行期猜。
 *
 * 纯字符串/URL 逻辑：无 fs、无 Electron、无网络。命中与否只看精确相等（不按主域、不按
 * 前缀、不按端口范围——ADR 明确否掉了「按主域名授权」）。
 */

export type OriginCheck =
  | { ok: true; origin: string; protocol: 'http:' | 'https:' }
  | { ok: false; reason: 'invalid' | 'unsupported_scheme' | 'not_pure_origin'; message: string }

/** 请求 URL → 授权匹配键（http/https 才可发；其余 scheme 一律不支持） */
export function originOfRequestUrl(raw: string): OriginCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid', message: `URL 不可解析：${String(raw).slice(0, 200)}` }
  }
  const protocol = url.protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme', message: `仅支持 HTTP(S) 请求-响应（首版不含 ${protocol} / WebSocket / 原始 Socket）` }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'not_pure_origin', message: '请求 URL 不得内嵌 userinfo（凭证注入归命名凭证面）' }
  }
  return { ok: true, origin: url.origin, protocol }
}

/** manifest 声明 origin → 正典串（必须是纯 origin；返回的 origin 是与请求面同一个匹配键） */
export function originOfDeclaration(raw: string): OriginCheck {
  const check = originOfRequestUrl(raw)
  if (!check.ok) return check
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid', message: `origin 不可解析：${String(raw).slice(0, 200)}` }
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return {
      ok: false,
      reason: 'not_pure_origin',
      message: `声明 origin 必须是纯 origin（scheme://host[:port]），不得带路径/查询/片段：${String(raw).slice(0, 200)}——origin 内路径与方法本来就同属授权`,
    }
  }
  return { ok: true, origin: url.origin, protocol: check.protocol }
}

/** 请求是否命中授权集（精确相等；未授权 origin 默认拒绝） */
export function originGranted(grantedOrigins: readonly string[] | undefined | null, origin: string): boolean {
  if (!grantedOrigins) return false
  for (const g of grantedOrigins) if (g === origin) return true
  return false
}
