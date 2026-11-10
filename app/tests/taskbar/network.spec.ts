// 联网判定纯函数（工单461，spec #457 T3 网络状态格——全 spec 唯一新接缝）：
// 网卡快照 → 布尔（存在带 IP 的活动非内部网卡即联网；GLOSSARY「网络状态格」口径）。
// 判定只读快照入参、不发任何探测包（ADR-0031）——本文件全部用例喂合成快照，零网络 IO。
// 重点覆盖票面三边界：全内部网卡 / 无 IP / 多网卡并存。
import { describe, expect, it } from 'vitest'
import { isNetworkUp, toAdapterSnapshot } from '../../src/main/taskbar/network'
import type { AdapterSnapshot } from '../../src/main/taskbar/network'

/** 合成快照行（快照形状的最小面——判定只看 internal 与 addresses 两维） */
const nic = (over: Partial<AdapterSnapshot> = {}): AdapterSnapshot => ({
  name: 'WLAN',
  internal: false,
  addresses: ['192.168.1.165'],
  ...over,
})

describe('isNetworkUp（工单461 联网判定：快照→布尔，不发探测包）', () => {
  it('空快照 → 断网', () => {
    expect(isNetworkUp([])).toBe(false)
  })

  it('全内部网卡（仅回环，带 IP）→ 断网', () => {
    const adapters = [
      nic({ name: 'Loopback Pseudo-Interface 1', internal: true, addresses: ['127.0.0.1', '::1'] }),
    ]
    expect(isNetworkUp(adapters)).toBe(false)
  })

  it('非内部网卡无 IP（media disconnected 残账）→ 断网', () => {
    const adapters = [nic({ addresses: [] })]
    expect(isNetworkUp(adapters)).toBe(false)
  })

  it('非内部网卡带 IP → 联网', () => {
    expect(isNetworkUp([nic()])).toBe(true)
  })

  it('多网卡并存：内部带 IP + 非内部无 IP → 断网（内部 IP 不顶账）', () => {
    const adapters = [
      nic({ name: 'Loopback', internal: true, addresses: ['127.0.0.1'] }),
      nic({ name: 'WLAN', addresses: [] }),
    ]
    expect(isNetworkUp(adapters)).toBe(false)
  })

  it('多网卡并存：内部带 IP + 非内部带 IP → 联网', () => {
    const adapters = [
      nic({ name: 'Loopback', internal: true, addresses: ['127.0.0.1'] }),
      nic({ name: 'WLAN', addresses: ['192.168.1.165', 'fe80::e510:b089:ea9f:43ff'] }),
    ]
    expect(isNetworkUp(adapters)).toBe(true)
  })

  it('多网卡并存：多枚非内部，其一带 IP 即联网（不要求全体带 IP）', () => {
    const adapters = [
      nic({ name: 'Teredo Tunneling Pseudo-Interface', addresses: [] }),
      nic({ name: 'vEthernet (Default Switch)', addresses: [] }),
      nic({ name: '以太网', addresses: ['10.0.0.2'] }),
    ]
    expect(isNetworkUp(adapters)).toBe(true)
  })

  it('不区分媒体类型：WiFi 与以太网同判据（spec 裁决——按名字断言不出差异）', () => {
    const wifi = [nic({ name: 'WLAN' })]
    const ethernet = [nic({ name: '以太网' })]
    expect(isNetworkUp(wifi)).toBe(isNetworkUp(ethernet))
  })
})

describe('toAdapterSnapshot（os.networkInterfaces 输出 → 判定快照投影）', () => {
  it('按网卡名归并地址、透传 internal 标记', () => {
    const raw = {
      WLAN: [
        { address: 'fe80::e510:b089:ea9f:43ff', family: 'IPv6', internal: false, mac: 'aa:bb' },
        { address: '192.168.1.165', family: 'IPv4', internal: false, mac: 'aa:bb' },
      ],
      'Loopback Pseudo-Interface 1': [
        { address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00' },
      ],
    }
    expect(toAdapterSnapshot(raw)).toEqual([
      { name: 'WLAN', internal: false, addresses: ['fe80::e510:b089:ea9f:43ff', '192.168.1.165'] },
      { name: 'Loopback Pseudo-Interface 1', internal: true, addresses: ['127.0.0.1'] },
    ])
  })

  it('缺地址段的网卡（键在值空）→ 地址清单为空、不缺席（无 IP 边界的快照侧形状）', () => {
    expect(toAdapterSnapshot({ WLAN: [] })).toEqual([{ name: 'WLAN', internal: false, addresses: [] }])
  })
})
