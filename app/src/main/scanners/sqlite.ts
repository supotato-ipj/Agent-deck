/**
 * SQLite 只读打开的共用形态（ADR-0003：一律只读；库被写方独占时快速失败走静默跳过）。
 * node:sqlite 无 URI 形态，readOnly 选项即 Python `file:...?mode=ro` 的等价物；
 * busy_timeout 调短对应 Python timeout=0.5——不拖住 1Hz 面板轮询。
 */
import { DatabaseSync } from 'node:sqlite'

export function openReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 500')
  } catch {
    db.close()
    throw new Error(`busy_timeout 设置失败: ${dbPath}`)
  }
  return db
}
