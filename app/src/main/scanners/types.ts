/**
 * 五工具会话采集的共享类型与判定常量（ADR-0003-multi-tool 会话模型）。
 * 判定语义自 Python agent_sessions.py 逐字段平移：90 秒时间窗判 RUNNING、10 分钟活跃池。
 * 本目录是纯逻辑：文件系统与 SQLite 直读，不走任何 API/IPC，可离线测试。
 */
import path from 'node:path'
import type { SessionInfo, QoderStatus } from '../../shared/contract'

export type { SessionInfo, QoderStatus }

export const RUNNING_WINDOW = 90.0
export const ACTIVE_WINDOW = 600.0

/** roots 为 {工具名: 数据根路径}，now 为墙钟秒——与 Python collect_sessions 同一接缝 */
export type SessionRoots = Record<string, string>
export type Scanner = (root: string, now: number) => SessionInfo[]

/** Python _dir_name：空值给空串，其余取路径末段 */
export function dirName(pathStr: unknown): string {
  return typeof pathStr === 'string' && pathStr ? path.win32.basename(pathStr) : ''
}

/** 单条会话的组装（Python _session 的字段集与缺省语义）；tasks_done 可为 null（zcode SUM 空） */
export function makeSession(
  tool: string,
  sid: string,
  project: string,
  age: number,
  state: string,
  options: { running?: boolean; tasks?: [number | null, number] } = {},
): SessionInfo {
  return {
    tool,
    id: sid,
    project,
    running: options.running ?? age <= RUNNING_WINDOW,
    age: Math.round(age),
    tasks_done: options.tasks === undefined ? null : options.tasks[0],
    tasks_total: options.tasks === undefined ? null : options.tasks[1],
    state,
  }
}
