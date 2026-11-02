/**
 * 托盘协议编解码纯逻辑测试（工单48 路线 C spike，接缝③）：
 * WM_COPYDATA(dwData=1) 的 SHELLTRAYDATA 字节负载 → 规范化托盘事件。
 * 合成字节负载进出，零 Win32；真实负载语料见 fixtures/trayhost/（真机捕获后固化）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packTrayClick, summarizeTrayDelivery, WM_CONTEXTMENU, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP } from '../src/main/trayhost/protocol'
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

/** 托盘点击回放打包（工单56/164，接缝③）：两代负载语义的纯函数合成，无 Win32。
 * 口径 = MSDN NOTIFYICONDATAW uCallbackMessage 备注（工单163 取证报告 §5，2026-10-11 复核原文）：
 * - v0（version 0/未协商）：wParam = 图标 uID（可 32 位长），lParam = 鼠标/键盘消息；
 * - v4（NOTIFYICON_VERSION_4）：LOWORD(lParam) = 通知事件（右键 WM_CONTEXTMENU、左键
 *   WM_LBUTTONUP），HIWORD(lParam) = 图标 ID（限 16 位），wParam = 锚点坐标
 *   （GET_X_LPARAM 取低字、GET_Y_LPARAM 取高字，即 MAKELPARAM(x,y)）。
 * 旧实现把 v0 两参数整体互换 + WM_LBUTTONUP 常量误为 0x0203（实为 WM_LBUTTONDBLCLK，
 * 真值 0x0202）+ v4 lParam 布局错位——#163 真机 A/B 坐实为回放全哑主因，工单164 修正。 */
describe('summarizeTrayDelivery（投递序列的投递口径，工单363 O3）', () => {
  it('全部成功：posted=true、partial=false、delivered=total（posted 恒指「整条序列都投出去了」）', () => {
    expect(summarizeTrayDelivery([{ posted: true }, { posted: true }])).toEqual({
      total: 2, delivered: 2, posted: true, partial: false,
    })
  })

  it('部分成功（应用退场致第二条被拒收）：posted=false、partial=true、delivered=1 —— 不静默当成功', () => {
    expect(summarizeTrayDelivery([{ posted: true }, { posted: false }])).toEqual({
      total: 2, delivered: 1, posted: false, partial: true,
    })
  })

  it('全部失败：posted=false、partial=false、delivered=0（部分成功与全失败分得开）', () => {
    expect(summarizeTrayDelivery([{ posted: false }, { posted: false }])).toEqual({
      total: 2, delivered: 0, posted: false, partial: false,
    })
  })

  it('空序列：posted=false、partial=false（一条都没投出去不算成功）', () => {
    expect(summarizeTrayDelivery([])).toEqual({ total: 0, delivered: 0, posted: false, partial: false })
  })
})

describe('packTrayClick', () => {
  const V4 = { uid: 0x1234, callbackMessage: 0x0400, version: 4 }

  it('常量：鼠标消息族真值（按下/抬起）＋WM_CONTEXTMENU=0x007B', () => {
    expect(WM_LBUTTONDOWN).toBe(0x0201)
    expect(WM_LBUTTONUP).toBe(0x0202)
    expect(WM_RBUTTONDOWN).toBe(0x0204)
    expect(WM_RBUTTONUP).toBe(0x0205)
    expect(WM_CONTEXTMENU).toBe(0x007b)
  })

  it('v4：wParam = MAKELPARAM(x,y)，lParam = (uID << 16) | 事件（LOWORD=事件、HIWORD=uID）', () => {
    const pack = packTrayClick(V4, 'left', { x: 100, y: 200 })[0]
    expect(pack.message).toBe(0x0400)
    expect(pack.wparam).toBe((200 << 16) | 100)
    expect(pack.lparam).toBe((0x1234 << 16) | 0x0202)
  })

  it('v4 右键：事件 = WM_CONTEXTMENU（v4 语义下外壳右键即此消息，#163 §5-4）', () => {
    const pack = packTrayClick(V4, 'right', { x: 5, y: 6 })[0]
    expect(pack.wparam).toBe((6 << 16) | 5)
    expect(pack.lparam).toBe((0x1234 << 16) | 0x007b)
  })

  it('v4 只投一条（通知码口径：右键 WM_CONTEXTMENU、左键 WM_LBUTTONUP）', () => {
    expect(packTrayClick(V4, 'right', { x: 5, y: 6 })).toHaveLength(1)
    expect(packTrayClick(V4, 'left', { x: 5, y: 6 })).toHaveLength(1)
  })

  it('v4：光标坐标取低 16 位（负坐标/超屏不串位）', () => {
    const pack = packTrayClick(V4, 'left', { x: -1, y: 0 })[0]
    expect(pack.wparam & 0xffff).toBe(0xffff)
    expect((pack.wparam >>> 16) & 0xffff).toBe(0)
  })

  it('v4：uid 取高 16 位（v4 图标 ID 限 16 位，MSDN）', () => {
    const pack = packTrayClick({ ...V4, uid: 0xdeadbeef }, 'left', { x: 1, y: 2 })[0]
    expect((pack.lparam >>> 16) & 0xffff).toBe(0xbeef)
  })

  it('v0：wParam = uID（32 位不截），lParam = 鼠标消息**对**（按下 + 抬起，外壳口径）', () => {
    const legacy = { uid: 0x2710, callbackMessage: 0x0401, version: 0 }
    expect(packTrayClick(legacy, 'left', { x: 9, y: 9 })).toEqual([
      { message: 0x0401, wparam: 0x2710, lparam: 0x0201 },
      { message: 0x0401, wparam: 0x2710, lparam: 0x0202 },
    ])
    expect(packTrayClick(legacy, 'right', { x: 9, y: 9 })).toEqual([
      { message: 0x0401, wparam: 0x2710, lparam: 0x0204 },
      { message: 0x0401, wparam: 0x2710, lparam: 0x0205 },
    ])
  })

  it('左右键同构：左键同样是「按下 + 抬起」两条（外壳对两个键逐条转发原始鼠标消息）', () => {
    // 工单363 O2 取舍：左键不收窄成单条。外壳对左键同样转发按下与抬起两条，
    // 应用按哪一条动作由它自己决定（自家 Electron 托盘只认按下族⇒只发抬起时
    // 自家菜单永不弹）。「双触发」是外壳同款投递的固有面：认两条的应用须自行去重
    // （Electron 托盘即如此），不是我们替应用改口径的理由——收窄左键会让只认按下
    // 族的应用（左键默认动作）同样收不到动作。
    const legacy = { uid: 7, callbackMessage: 0x400, version: 0 }
    const left = packTrayClick(legacy, 'left', { x: 0, y: 0 })
    const right = packTrayClick(legacy, 'right', { x: 0, y: 0 })
    expect(left).toHaveLength(2)
    expect(right).toHaveLength(2)
    expect(left.map((p) => p.lparam)).toEqual([WM_LBUTTONDOWN, WM_LBUTTONUP])
    expect(right.map((p) => p.lparam)).toEqual([WM_RBUTTONDOWN, WM_RBUTTONUP])
    // 两键同形：wParam 恒为 uID，消息族只差按键
    expect(left.every((p) => p.wparam === legacy.uid)).toBe(true)
    expect(right.every((p) => p.wparam === legacy.uid)).toBe(true)
  })

  it('v0：消息对的**顺序**是按下先、抬起后（外壳逐条转发鼠标消息的顺序）', () => {
    const legacy = { uid: 7, callbackMessage: 0x401, version: 0 }
    const lps = packTrayClick(legacy, 'right', { x: 0, y: 0 }).map((p) => p.lparam)
    expect(lps).toEqual([0x0204, 0x0205])
  })

  it('v0：uID 超 16 位原样在 wParam（MSDN：标识符可 32 位长，#163 P3-B 口径）', () => {
    const packs = packTrayClick({ uid: 0xdeadbeef, callbackMessage: 0x400, version: 0 }, 'right', { x: 0, y: 0 })
    expect(packs.every((p) => p.wparam === 0xdeadbeef)).toBe(true)
    expect(packs.map((p) => p.lparam)).toEqual([0x0204, 0x0205])
  })

  it('未协商版本（0）按 v0 语义', () => {
    const packs = packTrayClick({ uid: 1, callbackMessage: 0x400, version: 0 }, 'left', { x: 0, y: 0 })
    expect(packs.map((p) => p.lparam)).toEqual([0x0201, 0x0202])
    expect(packs.every((p) => p.wparam === 1)).toBe(true)
  })
})
