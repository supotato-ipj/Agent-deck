import { Service } from 'cordis'
import { CredentialStore, type CredentialCipherPort, type CredentialView } from './store'

/**
 * 命名凭证域服务（工单339）：面板主进程内的凭证库装配。
 *
 * - **可信 UI 面**（BridgeService 转发）：list/set/remove/bind/unbind——出口只有元数据，
 *   secret 永不回传（写入是单向的）。
 * - **运行时面**（NetworkBroker）：resolve(packageId, name, origin)——只在绑定精确匹配时
 *   交出注入头；插件永远拿不到 secret。
 * - 加密端口由装配层下发（生产 = safeStorage）；不可用 = 拒绝保存（不落明文）。
 * - 卸载清理经 install.credentials.clearBindingsFor（凭证本体保留）。
 */

export interface CredentialServiceOptions {
  /** 凭证库文件（生产 = userData/credentials.json；缺省 = 内存态空库，不落盘） */
  file?: string
  /** 加密端口（生产 = safeStorage；缺省 = 不可用——保存被拒，绝不落明文） */
  cipher?: CredentialCipherPort
  log?(event: Record<string, unknown>): void
}

/** 缺省加密端口：明确不可用（未装配真实加密能力时，凭证只读不写） */
const UNAVAILABLE_CIPHER: CredentialCipherPort = {
  available() { return false },
  encrypt() { throw new Error('加密能力不可用') },
  decrypt() { throw new Error('加密能力不可用') },
}

export class CredentialService extends Service {
  readonly store: CredentialStore

  constructor(ctx: import('cordis').Context, options: CredentialServiceOptions = {}) {
    super(ctx, 'credentials')
    const log = options.log ?? (() => {})
    this.store = new CredentialStore({
      // 缺省文件落进程临时目录（离线装配/测试）；生产装配显式给 userData 路径
      file: options.file ?? `${process.cwd()}/.credentials-memory.json`,
      cipher: options.cipher ?? UNAVAILABLE_CIPHER,
      now: () => Date.now(),
      log,
    })
  }

  list(): CredentialView[] {
    return this.store.list()
  }

  set(name: string, secret: string, opts?: { headerName?: string; valuePrefix?: string }) {
    return this.store.set(name, secret, opts)
  }

  remove(name: string) {
    return this.store.remove(name)
  }

  bind(packageId: string, credentialName: string, origin: string) {
    return this.store.bind(packageId, credentialName, origin)
  }

  unbind(packageId: string, credentialName: string, origin: string) {
    return this.store.unbind(packageId, credentialName, origin)
  }

  /** 网络 Broker 的解析口（只给注入头；未绑定/不存在 = credential_unavailable） */
  resolve(packageId: string, credentialName: string, origin: string) {
    return this.store.resolve(packageId, credentialName, origin)
  }

  /** 卸载清理（凭证本体保留） */
  clearBindingsFor(packageId: string): void {
    this.store.clearBindingsFor(packageId)
  }
}
