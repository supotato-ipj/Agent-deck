// 联网判定（工单461，spec #457 T3 网络状态格）：判定本体是纯函数——网卡快照 → 布尔
// （存在带 IP 的活动非内部网卡即联网；GLOSSARY「网络状态格」/ADR-0031 口径）。只读本机
// 网卡快照（os.networkInterfaces 的进程内快照），不发任何探测包；不区分 WiFi/以太网媒体
// 类型。状态随 1Hz taskbar/status 数据帧下发（bridge.push 载荷增 network 段），不开新事件
// 通道。
import os from 'node:os'

/** 网卡快照行（判定的唯一输入面）：名字仅存证、判定只看 internal 与 addresses 两维 */
export interface AdapterSnapshot {
  /** 网卡名（Windows 连接名，如 WLAN /以太网——快照自证，不参与判定） */
  name: string
  /** 是否内部网卡（回环等）——内部网卡即使带 IP 也不顶账 */
  internal: boolean
  /** 该网卡名下的全部地址（IPv4/IPv6 原文；不区分媒体类型） */
  addresses: string[]
}

/** 快照输入行的最小结构面（本投影只消费 address/internal 两字段）：os 的
 * NetworkInterfaceInfo（IPv4/IPv6 联合）两字段齐备可赋——入参不钉 Node 全型，
 * 合成快照（单测夹具）也不必伪造 scopeid/netmask/cidr 等不进判定面的字段。 */
export interface AdapterInfoRow {
  address: string
  internal: boolean
}

/**
 * os.networkInterfaces() 输出 → 判定快照投影（纯函数）：按网卡名归并地址行。
 * 输入行只消费 address/internal 两字段（family/mac/netmask/cidr 不进判定面）；
 * 同名网卡各行 internal 取或（Node 语义里同一接口各行同 flag——回环/物理整卡一致）。
 */
export function toAdapterSnapshot(
  ifaces: NodeJS.Dict<readonly AdapterInfoRow[]>,
): AdapterSnapshot[] {
  return Object.entries(ifaces).map(([name, infos]) => ({
    name,
    internal: (infos ?? []).some((info) => info.internal),
    addresses: (infos ?? []).map((info) => info.address),
  }))
}

/**
 * 联网判定（纯函数，spec #457 唯一新接缝）：存在带 IP 的活动非内部网卡即联网。
 * 快照由 readAdapterSnapshot 取（os.networkInterfaces 只列出到场网卡——断开的物理网卡
 * 无地址可报）；不发探测包、零网络 IO、零副作用。
 */
export function isNetworkUp(adapters: readonly AdapterSnapshot[]): boolean {
  return adapters.some((a) => !a.internal && a.addresses.length > 0)
}

/** 本机网卡快照（判定的生产取数点——1Hz 量级的进程内系统调用，无子进程、无包） */
export function readAdapterSnapshot(): AdapterSnapshot[] {
  return toAdapterSnapshot(os.networkInterfaces())
}
