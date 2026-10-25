/**
 * 全网接口计数读取：iphlpapi GetIfTable（MIB_IFROW 平铺布局）经 koffi 直调。
 * 布局常量在本机与 Get-NetAdapterStatistics 交叉实证（2026-09，工单04）：
 * 表头 DWORD 数组起点 offset 4；行 860 字节；dwInOctets@552、dwOutOctets@576（32 位，回绕在 rates 层处理）。
 * 仅主进程加载；离线测试以 Map 快照替身注入，不触本模块。
 */
import koffi from 'koffi'
import type { NetCounters } from './rates'

const ROW_SIZE = 860
const OFF_INDEX = 512
const OFF_IN_OCTETS = 552
const OFF_OUT_OCTETS = 576
const ERROR_INSUFFICIENT_BUFFER = 111

const iphlpapi = koffi.load('iphlpapi.dll')
const GetIfTable = iphlpapi.func('uint32_t __stdcall GetIfTable(_Out_ uint8_t *table, _Inout_ uint32_t *size)')

/** 各接口（以 dwIndex 为键）的收发字节计数快照 */
export function readNetCounters(): Map<number, NetCounters> {
  const size = Buffer.alloc(4)
  size.writeUInt32LE(64 * ROW_SIZE)
  let buf = Buffer.alloc(64 * ROW_SIZE)
  let ret: number = GetIfTable(buf, size)
  if (ret === ERROR_INSUFFICIENT_BUFFER) {
    buf = Buffer.alloc(size.readUInt32LE(0))
    ret = GetIfTable(buf, size)
  }
  if (ret !== 0) throw new Error(`GetIfTable 失败: ${ret}`)
  const n = buf.readUInt32LE(0)
  const out = new Map<number, NetCounters>()
  for (let i = 0; i < n; i++) {
    const row = buf.subarray(4 + i * ROW_SIZE)
    out.set(row.readUInt32LE(OFF_INDEX), {
      in: row.readUInt32LE(OFF_IN_OCTETS),
      out: row.readUInt32LE(OFF_OUT_OCTETS),
    })
  }
  return out
}
