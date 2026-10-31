import { safeStorage } from 'electron'
import type { CredentialCipherPort } from './store'

/**
 * 生产加密端口（工单339）：Electron safeStorage（Windows = DPAPI，按当前用户绑定）。
 *
 * - 加密不可用（如 Linux 无 keyring 的后备态）时 `available()` 为 false——凭证保存被拒，
 *   绝不落明文兜底；已在册凭证也解不开（如实 credential_unavailable）。
 * - 密文只在主进程内存与凭证文件里；本端口不碰文件、不记日志。
 */
export function createSafeStorageCipher(log: (event: Record<string, unknown>) => void): CredentialCipherPort {
  return {
    available() {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch (err) {
        log({ type: 'credential-cipher-probe-failed', message: err instanceof Error ? err.message : String(err) })
        return false
      }
    },
    encrypt(plain: string): string {
      return safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(cipher: string): string {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    },
  }
}
