import { Service } from 'cordis'
import { NetworkAuditService, type NetworkAuditBucket } from './audit'
import { NetworkBroker, type NetworkBrokerOptions, type CredentialResolverPort, type NetworkRequestSpec, type NetworkResult } from './broker'
import type { PluginAuthorizationLedger } from '../plugins/authorization-ledger'

/**
 * 网络域服务（工单338，ADR-0025 网络节）：面板主进程内的网络 Broker 装配。
 *
 * - Broker（授权门/限额/审计层）在主进程；包页仍无出站网络（session 级 webRequest + CSP
 *   全拒），放行只经 `deckHost.network.request` → 宿主 IPC → 这里。
 * - 审计：完整请求记录独立 JSONL（userData/network-audit.jsonl，与控制面审计分离），
 *   聚合桶（包+权限+时间窗）经 auditBuckets() 投影给可信 UI；记录不含头/正文/query。
 * - 授权账实例由装配层下发（与插件宿主/媒体共享同一账——撤销即断供同源）。
 */

export interface NetworkServiceOptions {
  /** 审计完整记录文件（生产 = userData/network-audit.jsonl；缺省 = 不记账） */
  auditFile?: string
  /** 授权账（与插件宿主服务共用实例；缺省 = 无授权面——任何请求都拿不到放行） */
  authorization?: PluginAuthorizationLedger | null
  /** 工单339：命名凭证解析（生产 = CredentialStore；缺省 = 无凭证面） */
  credentials?: CredentialResolverPort | null
  log?(event: Record<string, unknown>): void
 /** 契约限额覆盖（缺省 = catalog limits 同源默认值） */
  limits?: NetworkBrokerOptions['limits']
}

export class NetworkService extends Service {
  readonly audit: NetworkAuditService | null
  readonly broker: NetworkBroker

  constructor(ctx: import('cordis').Context, options: NetworkServiceOptions = {}) {
    super(ctx, 'network')
    const log = options.log ?? (() => {})
    this.audit = options.auditFile
      ? new NetworkAuditService({ file: options.auditFile, now: () => Date.now(), log })
      : null
    this.broker = new NetworkBroker({
      authorization: options.authorization ?? null,
      credentials: options.credentials ?? null,
      audit: this.audit,
      log,
      ...(options.limits ? { limits: options.limits } : {}),
    })
  }

  /** 包请求（宿主 IPC 转发；授权门/限额/审计在 Broker） */
  requestForPackage(packageId: string, spec: NetworkRequestSpec): Promise<NetworkResult> {
    return this.broker.requestForPackage(packageId, spec)
  }

  /** 审计聚合投影（可信 UI 数据面；完整记录仅在审计文件） */
  auditBuckets(): NetworkAuditBucket[] {
    return this.audit?.aggregate() ?? []
  }

  dispose(): void { /* 无进程/无定时器：Broker 无常驻资源 */ }
}
