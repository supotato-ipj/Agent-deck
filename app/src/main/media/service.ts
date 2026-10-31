import fs from 'node:fs'
import { Service } from 'cordis'
import { MediaAuditService, type MediaAuditBucket } from './audit'
import { MediaBroker, type MediaBrokerOptions, type MediaSnapshotDTO, type MediaThumbnailResult, createProductionBridge } from './broker'
import type { MediaBridgePort } from './bridge-client'
import type { PluginAuthorizationLedger } from '../plugins/authorization-ledger'

/**
 * 媒体域服务（工单336，ADR-0025 媒体节）：面板主进程内的媒体 Broker 装配。
 *
 * - Broker（权限/DTO/审计层）在主进程；WinRT 桥 = 独立 .NET helper 进程（t329 拍板：
 *   隔离 COM/WinRT 故障与 API 漂移，崩溃重启廉价）。桥 exe 缺席 = 桥不拉起（Broker
 *   走不可用明确态——真机验收前置自证 exe 在场）。
 * - 审计：完整存取记录独立 JSONL（userData/media-audit.jsonl，与控制面审计分离），
 *   聚合桶（包+权限+时间窗）经 auditBuckets() 投影给可信 UI。
 * - 授权账实例由装配层下发（与插件宿主服务共用同一账——撤销即断供 + 撤销即停同源）。
 */

export interface MediaServiceOptions {
  /** 审计完整记录文件（生产 = userData/media-audit.jsonl；缺省 = 不记账） */
  auditFile?: string
  /** GSMTC 桥 exe 绝对路径（生产 = app/resources/gsmtc-bridge/bridge.exe；缺省/缺席 = 桥不拉起） */
  bridgeExePath?: string
  /** 授权账（与插件宿主服务共用实例；缺省 = 无授权面——媒体数据不供任何包） */
  authorization?: PluginAuthorizationLedger | null
  log?(event: Record<string, unknown>): void
}

/** 桥缺席端口（exe 缺失/未装配）：一切请求如实不可用 */
function unavailableBridge(reason: string): MediaBridgePort {
  return {
    start() { /* 无进程可起 */ },
    stop() { /* 无进程可停 */ },
    watch() { /* 无进程可订 */ },
    async list() { return { ok: false as const, error: reason } },
    async thumb() { return { ok: false as const, error: reason } },
    onEvent() { return () => {} },
    onAvailability() { return () => {} },
  }
}

export class MediaService extends Service {
  readonly audit: MediaAuditService | null
  readonly broker: MediaBroker

  constructor(ctx: import('cordis').Context, options: MediaServiceOptions = {}) {
    super(ctx, 'media')
    const log = options.log ?? (() => {})
    this.audit = options.auditFile
      ? new MediaAuditService({ file: options.auditFile, now: () => Date.now(), log })
      : null
    // 桥拉起前置自证：exe 在场才 spawn（缺席不拉起、不重试风暴——明确不可用态）
    let bridge: MediaBridgePort
    if (options.bridgeExePath && fs.existsSync(options.bridgeExePath)) {
      bridge = createProductionBridge(options.bridgeExePath, log)
      log({ type: 'media-bridge-wired', exePath: options.bridgeExePath })
    } else {
      bridge = unavailableBridge(options.bridgeExePath ? '桥 exe 缺席（未构建）' : '桥未装配')
      log({ type: 'media-bridge-absent', exePath: options.bridgeExePath ?? null })
    }
    const brokerOpts: MediaBrokerOptions = {
      bridge,
      authorization: options.authorization ?? null,
      audit: this.audit,
      log,
    }
    this.broker = new MediaBroker(brokerOpts)
    this.broker.start()
    // 快照代次变化 → 宿主即时重推（包页只见 view.media 更新；面板兜底 tick 另有 1Hz 同拍）
    this.broker.onSnapshot(() => {
      this.emitMediaChanged()
    })
  }

  /** 快照代次变化事件（index.ts 订阅 → droppedPackageHost.refreshMedia()） */
  private emitMediaChanged(): void {
    this.ctx.emit('media/snapshot-changed', { generation: this.broker.snapshot().generation })
  }

  /** 包媒体段查询（宿主投喂授权门；未授权 = null 不投） */
  viewForPackage(packageId: string): { media: MediaSnapshotDTO } | null {
    return this.broker.viewForPackage(packageId)
  }

  /** 受控缩略图（宿主 IPC 转发；授权/校验/审计在 Broker） */
  thumbnailForPackage(packageId: string, key: string): Promise<MediaThumbnailResult> {
    return this.broker.thumbnailForPackage(packageId, key)
  }

  /** 审计聚合投影（可信 UI 数据面；完整记录仅在审计文件） */
  auditBuckets(): MediaAuditBucket[] {
    return this.audit?.aggregate() ?? []
  }

  /** 当前脱敏快照（诊断读数） */
  snapshot(): MediaSnapshotDTO {
    return this.broker.snapshot()
  }

  dispose(): void {
    this.broker.stop()
  }
}
