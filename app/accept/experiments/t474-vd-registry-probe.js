// t474 真机探针（工单474，spec #472 / ADR-0032）：advapi32 注册表进程内直读 +
// RegNotifyChangeKeyValue 变更通知的 koffi 绑定形状实证。跑在 t371/t407 同一先例位
// （app/accept/experiments/），实现 desktop/vd-registry.ts 前先行，全绿才落模块。
//
// 实证四事：
//   P1 进程内直读与 reg.exe 单查询同值（GUID 换算走 virtual-desktop.regBytesToGuid 同源）
//   P2 变更通知端到端：布防 → 值写入 → 内核事件点火（2s 预算）；消费=复位+重新布防
//   P3 重新布防后再次点火（一次性通知的续挂语义）
//   P4 真键（VirtualDesktops）布防静默期零误报（500ms 无变化 → 超时而非点火）
//
// 运行：node app/accept/experiments/t474-vd-registry-probe.js（plain node，零 electron；
// 产生一次 reg.exe 子进程自用与一次探针值写入——写的是自建探针键，不碰 VirtualDesktops）
'use strict'
const { execFileSync, spawnSync } = require('child_process')
const koffi = require('koffi')

const ADVAPI = koffi.load('advapi32.dll')
const KERNEL = koffi.load('kernel32.dll')
const regOpenKeyExW = ADVAPI.func('int32 __stdcall RegOpenKeyExW(void *hKey, const char16_t *lpSubKey, uint32_t ulOptions, uint32_t samDesired, _Out_ void **phkResult)')
const regCloseKey = ADVAPI.func('int32 __stdcall RegCloseKey(void *hKey)')
const regQueryValueExW = ADVAPI.func('int32 __stdcall RegQueryValueExW(void *hKey, const char16_t *lpValueName, void *lpReserved, _Out_ uint32_t *lpType, uint8_t *lpData, _Inout_ uint32_t *lpcbData)')
const regNotifyChangeKeyValue = ADVAPI.func('int32 __stdcall RegNotifyChangeKeyValue(void *hKey, uint32_t bWatchSubtree, uint32_t dwNotifyFilter, void *hEvent, uint32_t fAsynchronous)')
const createEventW = KERNEL.func('void *__stdcall CreateEventW(void *lpEventAttributes, uint32_t bManualReset, uint32_t bInitialState, const char16_t *lpName)')
const waitForSingleObject = KERNEL.func('uint32_t __stdcall WaitForSingleObject(void *hHandle, uint32_t dwMilliseconds)')
const resetEvent = KERNEL.func('uint32_t __stdcall ResetEvent(void *hEvent)')
const closeHandle = KERNEL.func('uint32_t __stdcall CloseHandle(void *hObject)')

const HKCU = 0x80000001
const KEY_READ = 0x20019
const REG_BINARY = 3
const REG_NOTIFY_CHANGE_LAST_SET = 0x4
const REG_NOTIFY_THREAD_AGNOSTIC = 0x10000000
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102
const VD_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops'
const PROBE_KEY = 'Software\\AgentDeckProbe474'

/** 注册表原始 16 字节（Data1/2/3 小端）→ GUID 标准形（virtual-desktop.regBytesToGuid 同源拷贝） */
function regBytesToGuid(hex) {
  const b = []
  for (let i = 0; i + 2 <= hex.length; i += 2) b.push(parseInt(hex.slice(i, i + 2), 16))
  const p = (n, w) => n.toString(16).padStart(w, '0')
  const swap = (arr) => arr.slice().reverse().map((x) => p(x, 2)).join('')
  if (b.length < 16) return ''
  return `${swap(b.slice(0, 4))}-${swap(b.slice(4, 6))}-${swap(b.slice(6, 8))}-${b.slice(8, 10).map((x) => p(x, 2)).join('')}-${b.slice(10, 16).map((x) => p(x, 2)).join('')}`
}

/** 两步读一个 REG_BINARY 值：先探大小（lpData=null）再按大小读（koffi.alloc + decode） */
function readBinary(hKey, name) {
  const type = [0]
  const size = [0]
  const r1 = regQueryValueExW(hKey, name, null, type, null, size)
  if (r1 !== 0 && r1 !== 234) return { err: `size-probe hr=${r1}` }
  if (!size[0]) return { err: 'size=0' }
  const buf = koffi.alloc('uint8_t', size[0])
  const len = [size[0]]
  const r2 = regQueryValueExW(hKey, name, null, type, buf, len)
  if (r2 !== 0) { koffi.free(buf); return { err: `read hr=${r2}` } }
  const bytes = koffi.decode(buf, 'uint8_t', len[0])
  koffi.free(buf)
  if (type[0] !== REG_BINARY) return { err: `type=${type[0]} 非 REG_BINARY` }
  return { bytes: Buffer.from(bytes) }
}

function openKey(path) {
  const hk = [null]
  const hr = regOpenKeyExW(HKCU, path, 0, KEY_READ, hk)
  return hr === 0 ? hk[0] : null
}

function arm(hKey, hEvent) {
  return regNotifyChangeKeyValue(hKey, 0, REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC, hEvent, 1)
}

let failed = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' —— ' + detail : ''}`)
  if (!ok) failed++
}

// —— P1 进程内直读 ↔ reg.exe 同值 ——
const hVd = openKey(VD_KEY)
check('P0 真键打开', Boolean(hVd), VD_KEY)
if (hVd) {
  const ids = readBinary(hVd, 'VirtualDesktopIDs')
  const cur = readBinary(hVd, 'CurrentVirtualDesktop')
  console.log('P1 diagnostic: ids.err=', ids.err ?? 'none', 'cur.err=', cur.err ?? 'none', 'ids.len=', ids.bytes ? ids.bytes.length : 0)
  const hex = (b) => b.toString('hex').toUpperCase()
  const directIds = ids.bytes ? (hex(ids.bytes).match(/.{32}/g) || []).map(regBytesToGuid) : []
  const directCur = cur.bytes ? regBytesToGuid(hex(cur.bytes)) : null
  const regOut = execFileSync('reg', ['query', 'HKCU\\' + VD_KEY], { encoding: 'utf8' })
  const mIds = regOut.match(/VirtualDesktopIDs\s+REG_BINARY\s+([0-9A-Fa-f]+)/)
  const mCur = regOut.match(/CurrentVirtualDesktop\s+REG_BINARY\s+([0-9A-Fa-f]+)/)
  const regIds = mIds ? (mIds[1].toUpperCase().match(/.{32}/g) || []).map(regBytesToGuid) : []
  const regCur = mCur ? regBytesToGuid(mCur[1].toUpperCase()) : null
  check('P1a VirtualDesktopIDs 直读=reg.exe', JSON.stringify(directIds) === JSON.stringify(regIds),
    `direct=${directIds.length} reg=${regIds.length}`)
  check('P1b CurrentVirtualDesktop 直读=reg.exe', directCur === regCur,
    `direct=${directCur && directCur.slice(0, 8)} reg=${regCur && regCur.slice(0, 8)}`)
  regCloseKey(hVd)
}

// —— P2/P3 探针键变更通知端到端 ——
spawnSync('reg', ['delete', 'HKCU\\' + PROBE_KEY, '/f'], { stdio: 'ignore' })
spawnSync('reg', ['add', 'HKCU\\' + PROBE_KEY, '/ve', '/d', 'seed', '/f'], { stdio: 'ignore' })
const hProbe = openKey(PROBE_KEY)
const hEvent = createEventW(null, 1, 0, null)
check('P2a 探针键打开+事件创建', Boolean(hProbe) && Boolean(hEvent))
if (hProbe && hEvent) {
  check('P2b 布防受理', arm(hProbe, hEvent) === 0)
  check('P2c 静默期零误报（wait 200ms = 超时）', waitForSingleObject(hEvent, 200) === WAIT_TIMEOUT)
  spawnSync('reg', ['add', 'HKCU\\' + PROBE_KEY, '/v', 'probe1', '/d', '1', '/f'], { stdio: 'ignore' })
  const fired = waitForSingleObject(hEvent, 2000)
  check('P2d 值写入 → 2s 内点火', fired === WAIT_OBJECT_0, `wait=${fired}`)
  // 消费：复位 + 重新布防（vd-registry.consumeFired 的语义原型）
  check('P2e 复位受理', resetEvent(hEvent) !== 0)
  check('P3a 重新布防受理', arm(hProbe, hEvent) === 0)
  check('P3b 消费后静默（wait 200ms = 超时）', waitForSingleObject(hEvent, 200) === WAIT_TIMEOUT)
  spawnSync('reg', ['add', 'HKCU\\' + PROBE_KEY, '/v', 'probe2', '/d', '2', '/f'], { stdio: 'ignore' })
  check('P3c 重布防后再点火', waitForSingleObject(hEvent, 2000) === WAIT_OBJECT_0)
  regCloseKey(hProbe)
  closeHandle(hEvent)
}
spawnSync('reg', ['delete', 'HKCU\\' + PROBE_KEY, '/f'], { stdio: 'ignore' })

// —— P4 真键布防静默（复用真键 500ms 无变化窗口）——
const hVd2 = openKey(VD_KEY)
if (hVd2) {
  const hEvent2 = createEventW(null, 1, 0, null)
  if (hEvent2 && arm(hVd2, hEvent2) === 0) {
    check('P4 真键布防 500ms 静默零误报', waitForSingleObject(hEvent2, 500) === WAIT_TIMEOUT,
      '（若恰逢用户切桌面会误报——单跑时静置即可）')
    regCloseKey(hVd2)
    closeHandle(hEvent2)
  }
}

console.log(failed === 0 ? 'PROBE VERDICT: ALL GREEN' : `PROBE VERDICT: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
