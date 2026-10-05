/**
 * 托盘协议编解码纯逻辑测试（工单48 路线 C spike，接缝③）：
 * WM_COPYDATA(dwData=1) 的 SHELLTRAYDATA 字节负载 → 规范化托盘事件。
 * 合成字节负载进出，零 Win32；真实负载语料见 fixtures/trayhost/（真机捕获后固化）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NIM_ADD,
  NIM_DELETE,
  NIM_MODIFY,
  NIM_SETFOCUS,
  NIM_SETVERSION,
  NIF_GUID,
  NIF_ICON,
  NIF_MESSAGE,
  NIF_TIP,
  decodeTrayPayload,
  encodeTrayPayload,
  toTrayEvent,
} from '../src/main/trayhost/protocol'

const BASE = {
  dwMessage: NIM_ADD,
  hwnd: 0x12345678,
  uid: 42,
  flags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
  callbackMessage: 0x8001,
  hicon: 0x9abcdef0,
  tooltip: '测试托盘',
}

describe('decodeTrayPayload（SHELLTRAYDATA → 解析结果）', () => {
  it.each(['x86', 'x64'] as const)('%s V3 NIM_ADD：字段全解析（含 tooltip）', (arch) => {
    const buf = encodeTrayPayload({ ...BASE, arch, version: 3 })
    const n = decodeTrayPayload(buf)
    expect(n).not.toBeNull()
    expect(n!.arch).toBe(arch)
    expect(n!.dwMessage).toBe(NIM_ADD)
    expect(n!.hwnd).toBe(BASE.hwnd)
    expect(n!.uid).toBe(BASE.uid)
    expect(n!.flags).toBe(BASE.flags)
    expect(n!.callbackMessage).toBe(BASE.callbackMessage)
    expect(n!.hicon).toBe(BASE.hicon)
    expect(n!.tooltip).toBe(BASE.tooltip)
    expect(n!.version).toBe(4) // encode 默认 uVersion=4（NOTIFYICON_VERSION_4）
    expect(n!.state).toBe(0)
  })

  it.each(['x86', 'x64'] as const)('%s V1：无 state/version 段，szTip 仅 64 字符位', (arch) => {
    const buf = encodeTrayPayload({ ...BASE, arch, version: 1, tooltip: '短提示' })
    const n = decodeTrayPayload(buf)
    expect(n).not.toBeNull()
    expect(n!.tooltip).toBe('短提示')
    expect(n!.state).toBeNull()
    expect(n!.version).toBeNull()
    expect(n!.guid).toBeNull()
  })

  it('x86 V3 带 NIF_GUID：guidItem 解析为标准 GUID 串', () => {
    const guid = '00112233-4455-6677-8899-aabbccddeeff'
    const buf = encodeTrayPayload({ ...BASE, arch: 'x86', version: 3, flags: BASE.flags | NIF_GUID, guid })
    const n = decodeTrayPayload(buf)
    expect(n!.guid).toBe(guid)
  })

  it('x64 V3 带 NIF_GUID：guidItem 解析为标准 GUID 串', () => {
    const guid = 'deadcafe-1234-5678-9abc-def012345678'
    const buf = encodeTrayPayload({ ...BASE, arch: 'x64', version: 3, flags: BASE.flags | NIF_GUID, guid })
    const n = decodeTrayPayload(buf)
    expect(n!.guid).toBe(guid)
  })

  it('V3 但无 NIF_GUID：guid 为 null（guidItem 不采信）', () => {
    const buf = encodeTrayPayload({ ...BASE, arch: 'x86', version: 3, guid: '00112233-4455-6677-8899-aabbccddeeff' })
    const n = decodeTrayPayload(buf)
    expect(n!.guid).toBeNull()
  })

  it('截断/畸形负载返回 null 而不抛异常', () => {
    expect(decodeTrayPayload(Buffer.alloc(0))).toBeNull()
    expect(decodeTrayPayload(Buffer.alloc(4))).toBeNull()
    expect(decodeTrayPayload(Buffer.alloc(8))).toBeNull()
    const good = encodeTrayPayload({ ...BASE, arch: 'x86', version: 3 })
    expect(decodeTrayPayload(good.subarray(0, 100))).toBeNull()
  })

  it('未知 cbSize 返回 null（不认识的大小不硬解）', () => {
    const good = encodeTrayPayload({ ...BASE, arch: 'x86', version: 3 })
    const bad = Buffer.from(good)
    bad.writeUInt32LE(12345, 8) // 现行封装 nid@8 起点的 cbSize 篡改为未知值
    expect(decodeTrayPayload(bad)).toBeNull()
  })

  it.each(['x86', 'x64'] as const)('旧式无签名封装（ReactOS 形态）同样可解：%s', (arch) => {
    const buf = encodeTrayPayload({ ...BASE, arch, version: 3, legacy: true })
    const n = decodeTrayPayload(buf)
    expect(n).not.toBeNull()
    expect(n!.arch).toBe(arch)
    expect(n!.tooltip).toBe(BASE.tooltip)
    expect(n!.hwnd).toBe(BASE.hwnd)
  })
})

describe('toTrayEvent（解析结果 → 规范化托盘事件）', () => {
  const decode = (over: Partial<Parameters<typeof encodeTrayPayload>[0]>) =>
    decodeTrayPayload(encodeTrayPayload({ ...BASE, arch: 'x64', version: 3, ...over }))!

  it('消息种类映射：add/update/delete/version/focus', () => {
    expect(toTrayEvent(decode({ dwMessage: NIM_ADD })).kind).toBe('add')
    expect(toTrayEvent(decode({ dwMessage: NIM_MODIFY })).kind).toBe('update')
    expect(toTrayEvent(decode({ dwMessage: NIM_DELETE })).kind).toBe('delete')
    expect(toTrayEvent(decode({ dwMessage: NIM_SETVERSION })).kind).toBe('version')
    expect(toTrayEvent(decode({ dwMessage: NIM_SETFOCUS })).kind).toBe('focus')
  })

  it('未知 dwMessage 归为 unknown 且不进事件流', () => {
    expect(toTrayEvent(decode({ dwMessage: 99 })).kind).toBe('unknown')
  })

  it('图标身份键：无 guid 时 hwnd:uid；有 guid 时 guid: 前缀（应用多图标去重键）', () => {
    expect(toTrayEvent(decode({})).key).toBe(`${BASE.hwnd}:${BASE.uid}`)
    const withGuid = decode({ flags: BASE.flags | NIF_GUID, guid: '00112233-4455-6677-8899-aabbccddeeff' })
    expect(toTrayEvent(withGuid).key).toBe('guid:00112233-4455-6677-8899-aabbccddeeff')
  })

  it('delete 事件保留身份键与来源 hwnd（宿主据此移除图标）', () => {
    const e = toTrayEvent(decode({ dwMessage: NIM_DELETE }))
    expect(e.kind).toBe('delete')
    expect(e.key).toBe(`${BASE.hwnd}:${BASE.uid}`)
    expect(e.hwnd).toBe(String(BASE.hwnd))
  })
})

describe('编码往返一致性（encode → decode 恒等）', () => {
  it.each(['x86', 'x64'] as const)('%s 全版本往返', (arch) => {
    for (const version of [1, 2, 3] as const) {
      const buf = encodeTrayPayload({ ...BASE, arch, version, tooltip: `v${version} 往返` })
      const n = decodeTrayPayload(buf)
      expect(n).not.toBeNull()
      expect(n!.tooltip).toBe(`v${version} 往返`)
      expect(n!.hwnd).toBe(BASE.hwnd)
      expect(n!.hicon).toBe(BASE.hicon)
    }
  })
})

describe('真实字节语料夹具（fixtures/trayhost/real-corpus.json，真机捕获固化）', () => {
  interface CorpusEntry {
    label: string
    dwMessage: number
    arch: 'x86' | 'x64'
    cbSize: number
    tooltip: string
    guid: string | null
    hex: string
  }
  const corpus = JSON.parse(
    readFileSync(resolve(__dirname, 'fixtures/trayhost/real-corpus.json'), 'utf8'),
  ) as CorpusEntry[]

  it.each(corpus.map((e) => [e.label, e] as const))('%s：逐字段符合捕获时的记录', (_label, e) => {
    const n = decodeTrayPayload(Buffer.from(e.hex, 'hex'))
    expect(n).not.toBeNull()
    expect(n!.dwMessage).toBe(e.dwMessage)
    expect(n!.arch).toBe(e.arch)
    expect(n!.cbSize).toBe(e.cbSize)
    expect(n!.tooltip).toBe(e.tooltip)
    expect(n!.guid ?? null).toBe(e.guid)
    // 事件化不丢身份键（宿主侧增删图标依赖它）
    expect(toTrayEvent(n!).key).toBeTruthy()
  })
})
