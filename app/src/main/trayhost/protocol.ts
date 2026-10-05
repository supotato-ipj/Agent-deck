// 托盘协议编解码（工单48 路线 C spike，接缝③ 纯 TS、零 Win32）：
// Shell_NotifyIcon 底层是发给 Shell_TrayWnd 的 WM_COPYDATA（dwData=1），负载为
// SHELLTRAYDATA：signature(0x34753423)@0 + dwMessage@4 + nid@8（真机语料 +
// Geoff Chappell 协议分析佐证）。nid 是发送方进程位数的 NOTIFYICONDATAW：
// 32 位应用给 32 位紧凑布局，64 位应用给 64 位布局（WOW64 不做转换），收方按
// cbSize 判位。另兼容无签名的旧式封装（dwMessage@0，ReactOS 形态）。
// 本模块只做字节 ⇄ 规范化托盘事件，效果层（host.ts）负责取字节、提图标像素。
//
// cbSize 实测值表（shellapi.h 布局推导，真机语料 fixtures/trayhost/ 佐证）：
//   x86: V1=152  V2=936  V3=952(Vista RTM 无 hBalloonIcon) / 956
//   x64: V1=168  V2=952  V3=968(无 hBalloonIcon) / 976
// 952 在两位数下都出现——先查 x86 表再查 x64 表（同 nid 起点，无歧义）。

/** SHELLTRAYDATA 签名（WM_COPYDATA 负载首 4 字节，Geoff Chappell 记录的现行封装） */
export const TRAY_SIGNATURE = 0x34753423

/** NOTIFYICONDATA 消息（SHELLTRAYDATA.dwMessage） */
export const NIM_ADD = 0
export const NIM_MODIFY = 1
export const NIM_DELETE = 2
export const NIM_SETFOCUS = 3
export const NIM_SETVERSION = 4

/** NOTIFYICONDATA.uFlags */
export const NIF_MESSAGE = 0x1
export const NIF_ICON = 0x2
export const NIF_TIP = 0x4
export const NIF_STATE = 0x8
export const NIF_INFO = 0x10
export const NIF_GUID = 0x20

/** WM_COPYDATA 的 COPYDATASTRUCT.dwData：1 = 托盘通知，3 = AppBar */
export const COPYDATA_TRAY = 1

export type TrayArch = 'x86' | 'x64'

interface NidLayout {
  hWnd: number
  uID: number
  uFlags: number
  uCallbackMessage: number
  hIcon: number
  szTip: number
  dwState: number
  dwStateMask: number
  uVersion: number
  guidItem: number
  sizes: Record<number, 1 | 2 | 3>
}

const LAYOUTS: Record<TrayArch, NidLayout> = {
  x86: {
    hWnd: 4, uID: 8, uFlags: 12, uCallbackMessage: 16, hIcon: 20,
    szTip: 24, dwState: 280, dwStateMask: 284, uVersion: 288, guidItem: 936,
    sizes: { 152: 1, 936: 2, 952: 3, 956: 3 },
  },
  x64: {
    hWnd: 8, uID: 16, uFlags: 20, uCallbackMessage: 24, hIcon: 32,
    szTip: 40, dwState: 296, dwStateMask: 300, uVersion: 304, guidItem: 952,
    sizes: { 168: 1, 952: 2, 968: 3, 976: 3 },
  },
}

/** 一次 Shell_NotifyIcon 调用的解析结果（位无关） */
export interface DecodedNotify {
  dwMessage: number
  arch: TrayArch
  cbSize: number
  hwnd: number
  uid: number
  flags: number
  callbackMessage: number
  hicon: number
  tooltip: string
  /** V1 无以下三段 → null */
  state: number | null
  stateMask: number | null
  version: number | null
  /** 仅 V3 且 uFlags 带 NIF_GUID 时采信 */
  guid: string | null
}

function readWideString(buf: Buffer, offset: number, maxChars: number): string {
  let end = offset
  const limit = Math.min(buf.length, offset + maxChars * 2)
  while (end + 1 < limit && buf.readUInt16LE(end) !== 0) end += 2
  return buf.toString('utf16le', offset, end)
}

function readGuid(buf: Buffer, offset: number): string {
  const h = (n: number, len: number) => n.toString(16).padStart(len, '0')
  const d1 = buf.readUInt32LE(offset)
  const d2 = buf.readUInt16LE(offset + 4)
  const d3 = buf.readUInt16LE(offset + 6)
  const tail = Array.from(buf.subarray(offset + 8, offset + 16), (b) => h(b, 2)).join('')
  return `${h(d1, 8)}-${h(d2, 4)}-${h(d3, 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`
}

function decodeNid(buf: Buffer, base: number, arch: TrayArch, dwMessage: number): DecodedNotify | null {
  const L = LAYOUTS[arch]
  if (buf.length < base + 4) return null
  const cbSize = buf.readUInt32LE(base)
  const ver = L.sizes[cbSize]
  if (!ver) return null
  if (buf.length < base + cbSize) return null
  const readHandle = (off: number) =>
    Number(arch === 'x64' ? buf.readBigUInt64LE(base + off) : BigInt(buf.readUInt32LE(base + off)))
  const flags = buf.readUInt32LE(base + L.uFlags)
  const hasGuid = ver >= 3 && (flags & NIF_GUID) !== 0
  return {
    dwMessage,
    arch,
    cbSize,
    hwnd: readHandle(L.hWnd),
    uid: buf.readUInt32LE(base + L.uID),
    flags,
    callbackMessage: buf.readUInt32LE(base + L.uCallbackMessage),
    hicon: readHandle(L.hIcon),
    tooltip: readWideString(buf, base + L.szTip, ver >= 2 ? 128 : 64),
    state: ver >= 2 ? buf.readUInt32LE(base + L.dwState) : null,
    stateMask: ver >= 2 ? buf.readUInt32LE(base + L.dwStateMask) : null,
    version: ver >= 2 ? buf.readUInt32LE(base + L.uVersion) : null,
    guid: hasGuid ? readGuid(buf, base + L.guidItem) : null,
  }
}

/** SHELLTRAYDATA 负载 → 解析结果；畸形/未知 cbSize/截断一律 null（不抛） */
export function decodeTrayPayload(payload: Uint8Array): DecodedNotify | null {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  if (buf.length < 8) return null
  if (buf.readUInt32LE(0) === TRAY_SIGNATURE) {
    // 现行封装：签名@0 + dwMessage@4 + nid@8（两位数同起点；nid@8 天然 8 对齐）
    const dwMessage = buf.readUInt32LE(4)
    return decodeNidAt(buf, 8, dwMessage)
  }
  // 旧式封装（ReactOS 形态）：dwMessage@0 + nid@4(x86 紧凑) / @8(x64 对齐填充)
  const dwMessage = buf.readUInt32LE(0)
  return decodeNid(buf, 4, 'x86', dwMessage) ?? decodeNid(buf, 8, 'x64', dwMessage)
}

/**
 * 同起点 nid 的位数判别。952 是唯一的表碰撞（x86 V3-无气球图标 vs x64 V2）：
 * x64 的 cbSize 后有 4 字节零填充，x86 同位置是非零 hWnd（托盘图标必挂真窗口）——
 * 以此分辨；其余 cbSize 只在一表中，先试 x86 再试 x64。
 */
function decodeNidAt(buf: Buffer, base: number, dwMessage: number): DecodedNotify | null {
  if (buf.length >= base + 8 && buf.readUInt32LE(base) === 952) {
    return decodeNid(buf, base, buf.readUInt32LE(base + 4) === 0 ? 'x64' : 'x86', dwMessage)
  }
  return decodeNid(buf, base, 'x86', dwMessage) ?? decodeNid(buf, base, 'x64', dwMessage)
}

// —— 规范化托盘事件（ADR-0007 内部边界：增/改/删 + tooltip + 图标像素——像素由效果层补挂）——

export interface TrayIconPixels {
  width: number
  height: number
  /** 32bpp 顶向下 BGRA 原始字节（alpha 已按 AND 掩码修复），base64 */
  bgraBase64: string
}

export interface TrayWireEvent {
  kind: 'add' | 'update' | 'delete' | 'version' | 'focus' | 'unknown'
  /** 图标身份键：NIF_GUID 在则 guid:<guid>，否则 <hwnd>:<uid> */
  key: string
  /** 十进制串（句柄值，结构化克隆友好） */
  hwnd: string
  uid: number
  guid: string | null
  tooltip: string
  callbackMessage: number
  /** NIM_SETVERSION 协商版本（V1 负载为 0） */
  version: number
  flags: number
  /** NIM_ADD/MODIFY 且 NIF_ICON 时的图标句柄（十进制串，效果层提取像素用） */
  hicon: string | null
  icon?: TrayIconPixels | null
}

const KINDS: Record<number, TrayWireEvent['kind']> = {
  [NIM_ADD]: 'add',
  [NIM_MODIFY]: 'update',
  [NIM_DELETE]: 'delete',
  [NIM_SETVERSION]: 'version',
  [NIM_SETFOCUS]: 'focus',
}

export function toTrayEvent(n: DecodedNotify): TrayWireEvent {
  const hasIcon = (n.flags & NIF_ICON) !== 0 && n.hicon !== 0
  return {
    kind: KINDS[n.dwMessage] ?? 'unknown',
    key: n.guid ? `guid:${n.guid}` : `${n.hwnd}:${n.uid}`,
    hwnd: String(n.hwnd),
    uid: n.uid,
    guid: n.guid,
    tooltip: n.tooltip,
    callbackMessage: n.callbackMessage,
    version: n.version ?? 0,
    flags: n.flags,
    hicon: hasIcon ? String(n.hicon) : null,
  }
}

// —— 编码（测试合成负载 + 验收探针直调 Shell_NotifyIconW 的 NOTIFYICONDATAW 构造）——

export interface EncodeNotifyOptions {
  arch: TrayArch
  version: 1 | 2 | 3
  hwnd: number
  uid: number
  flags: number
  callbackMessage: number
  hicon: number
  tooltip?: string
  /** V2+ 的 uVersion 字段（缺省 4 = NOTIFYICON_VERSION_4） */
  uVersion?: number
  /** 仅 V3 有意义（配合 NIF_GUID 写出 guidItem） */
  guid?: string
}

const CB_SIZE: Record<TrayArch, Record<1 | 2 | 3, number>> = {
  x86: { 1: 152, 2: 936, 3: 956 },
  x64: { 1: 168, 2: 952, 3: 976 },
}

function writeGuid(buf: Buffer, offset: number, guid: string): void {
  const hex = guid.replace(/-/g, '')
  const raw = Buffer.from(hex, 'hex')
  buf.writeUInt32LE(raw.readUInt32BE(0), offset)
  buf.writeUInt16LE(raw.readUInt16BE(4), offset + 4)
  buf.writeUInt16LE(raw.readUInt16BE(6), offset + 6)
  raw.subarray(8, 16).copy(buf, offset + 8)
}

/** 单条 NOTIFYICONDATAW 字节（验收探针直调 Shell_NotifyIconW 也用它） */
export function encodeNotifyIconData(o: EncodeNotifyOptions): Buffer {
  const L = LAYOUTS[o.arch]
  const cbSize = CB_SIZE[o.arch][o.version]
  const buf = Buffer.alloc(cbSize)
  buf.writeUInt32LE(cbSize, 0)
  const writeHandle = (off: number, v: number) => {
    if (o.arch === 'x64') buf.writeBigUInt64LE(BigInt(v), off)
    else buf.writeUInt32LE(v, off)
  }
  writeHandle(L.hWnd, o.hwnd)
  buf.writeUInt32LE(o.uid, L.uID)
  buf.writeUInt32LE(o.flags, L.uFlags)
  buf.writeUInt32LE(o.callbackMessage, L.uCallbackMessage)
  writeHandle(L.hIcon, o.hicon)
  if (o.tooltip) {
    buf.write(o.tooltip.slice(0, (o.version >= 2 ? 128 : 64) - 1), L.szTip, 'utf16le')
  }
  if (o.version >= 2) {
    buf.writeUInt32LE(o.uVersion ?? 4, L.uVersion)
  }
  if (o.version >= 3 && o.guid) writeGuid(buf, L.guidItem, o.guid)
  return buf
}

/**
 * 包一层 SHELLTRAYDATA 头成 WM_COPYDATA 负载：现行封装 = 签名@0 + dwMessage@4 + nid@8
 * （两位数同起点）；legacy = 旧式无签名封装（dwMessage@0 + nid@4(x86)/@8(x64)）。
 */
export function encodeTrayPayload(o: EncodeNotifyOptions & { dwMessage: number; legacy?: boolean }): Buffer {
  const nid = encodeNotifyIconData(o)
  if (o.legacy) {
    const base = o.arch === 'x64' ? 8 : 4
    const buf = Buffer.alloc(base + nid.length)
    buf.writeUInt32LE(o.dwMessage, 0)
    nid.copy(buf, base)
    return buf
  }
  const buf = Buffer.alloc(8 + nid.length)
  buf.writeUInt32LE(TRAY_SIGNATURE, 0)
  buf.writeUInt32LE(o.dwMessage, 4)
  nid.copy(buf, 8)
  return buf
}
