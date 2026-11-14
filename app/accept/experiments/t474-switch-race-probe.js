// t474 switch-race 探针 phase2（工单474）：实测「CreateDesktop 后立即 SwitchDesktop」
// 是否被 shell 忽略——对照「建后停 100/300ms 再切」。r1 电池 P2 形态：配对成立（建桌
// +落盘都成功）、双源 3s 停旧桌面；直读提速把建→切间隔压到 ~10ms 级，本探针分辨
// 「切太早被忽略」vs「环境抖动」。
// 3 组各 3 轮：立即切 / 停100ms 切 / 停300ms 切（均切回+删桌清理，屏幕会闪 3 次/组）。
'use strict'
const koffi = require('koffi')
const ole32 = koffi.load('ole32.dll')

koffi.struct('T474_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: 'uint8[8]' });
const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 dwCoInit)')
const CLSIDFromString = ole32.func('int32 __stdcall CLSIDFromString(const char16_t *lpsz, _Out_ T474_GUID *clsid)')
const CoCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(const T474_GUID *clsid, void *outer, uint32 clsCtx, const T474_GUID *iid, _Out_ void **outObj)')
const PTRSZ = koffi.sizeof(koffi.pointer('void'))
const protoRelease = koffi.proto('__stdcall', 'T474_Release', 'uint32', ['void *'])
const protoQueryService = koffi.proto('__stdcall', 'T474_QueryService', 'int32', ['void *', 'const T474_GUID *', 'const T474_GUID *', koffi.out('void **')])
const protoGetDesktops = koffi.proto('__stdcall', 'T474_VdmiGetDesktops', 'int32', ['void *', koffi.out('void **')])
const protoGetCurrent = koffi.proto('__stdcall', 'T474_VdmiGetCurrent', 'int32', ['void *', koffi.out('void **')])
const protoSwitch = koffi.proto('__stdcall', 'T474_VdmiSwitch', 'int32', ['void *', 'void *'])
const protoCreate = koffi.proto('__stdcall', 'T474_VdmiCreate', 'int32', ['void *', koffi.out('void **')])
const protoRemove = koffi.proto('__stdcall', 'T474_VdmiRemove', 'int32', ['void *', 'void *', 'void *'])
const protoVdGetId = koffi.proto('__stdcall', 'T474_VdGetId', 'int32', ['void *', koffi.out('T474_GUID *')])
const protoObjArrCount = koffi.proto('__stdcall', 'T474_ObjArrCount', 'int32', ['void *', koffi.out('int32 *')])
const protoObjArrGetAt = koffi.proto('__stdcall', 'T474_ObjArrGetAt', 'int32', ['void *', 'int32', 'const T474_GUID *', koffi.out('void **')])

const CLSID = { immersiveShell: 'C2F03A33-21F5-47FA-B4BB-156362A2F239', vdmi: 'C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B' }
const IID = { vdmi_24H2: '53F5CA0B-158F-4124-900C-057158060B27', virtualDesktop: '3F07F4BE-B107-441A-AF0F-39D82529072C', serviceProvider: '6D5140C1-7436-11CE-8034-00AA006009FA' }

function guidFromStr(s) {
  const g = [null]
  const hr = CLSIDFromString('{' + s + '}', g)
  if (hr !== 0) throw new Error(`CLSIDFromString(${s}) hr=${hr}`)
  return g[0]
}
function comGuidToStr(q) {
  if (!q || !q.d4) return ''
  const p = (n, w) => n.toString(16).padStart(w, '0')
  const d4 = Array.from({ length: 8 }, (_, i) => q.d4[i])
  return `${p(q.d1 >>> 0, 8)}-${p(q.d2, 4)}-${p(q.d3, 4)}-${d4.slice(0, 2).map((b) => p(b, 2)).join('')}-${d4.slice(2).map((b) => p(b, 2)).join('')}`
}
const slot = (obj, i) => koffi.decode(koffi.decode(obj, 'void *'), i * PTRSZ, 'void *')
const release = (obj) => { try { if (obj) koffi.call(slot(obj, 2), protoRelease, obj) } catch { /* 尽力 */ } }

const hrInit = CoInitializeEx(null, 0)
if (hrInit !== 0 && hrInit !== 1 && hrInit !== -2147417850) throw new Error(`CoInitializeEx hr=${hrInit}`)
const shell = [null]
const hrShell = CoCreateInstance(guidFromStr(CLSID.immersiveShell), null, 1 | 4, guidFromStr(IID.serviceProvider), shell)
if (hrShell !== 0 || !shell[0]) throw new Error(`shell hr=${hrShell}`)
const svc = [null]
const hrQs = koffi.call(slot(shell[0], 3), protoQueryService, shell[0], guidFromStr(CLSID.vdmi), guidFromStr(IID.vdmi_24H2), svc)
release(shell[0])
if (hrQs !== 0 || !svc[0]) throw new Error(`VDMI QueryService hr=${hrQs}`)
const vdmi = svc[0]

const vdIdOf = (d) => {
  const g = [null]
  const r = koffi.call(slot(d, 4), protoVdGetId, d, g)
  if (r !== 0) throw new Error(`GetId hr=${r}`)
  return comGuidToStr(g[0])
}
const desktops = () => {
  const arr = [null]
  const hr = koffi.call(slot(vdmi, 7), protoGetDesktops, vdmi, arr)
  if (hr !== 0 || !arr[0]) throw new Error(`GetDesktops hr=${hr}`)
  try {
    const n = [0]
    koffi.call(slot(arr[0], 3), protoObjArrCount, arr[0], n)
    const out = []
    for (let i = 0; i < n[0]; i++) {
      const d = [null]
      const r = koffi.call(slot(arr[0], 4), protoObjArrGetAt, arr[0], i, guidFromStr(IID.virtualDesktop), d)
      if (r === 0 && d[0]) out.push(vdIdOf(d[0]))
    }
    return out
  } finally { release(arr[0]) }
}
const currentId = () => {
  const d = [null]
  const hr = koffi.call(slot(vdmi, 6), protoGetCurrent, vdmi, d)
  return (hr === 0 && d[0]) ? vdIdOf(d[0]) : null
}
const switchTo = (id) => {
  const arr = [null]
  const hr = koffi.call(slot(vdmi, 7), protoGetDesktops, vdmi, arr)
  if (hr !== 0 || !arr[0]) throw new Error(`GetDesktops hr=${hr}`)
  let target = null
  try {
    const n = [0]
    koffi.call(slot(arr[0], 3), protoObjArrCount, arr[0], n)
    for (let i = 0; i < n[0]; i++) {
      const d = [null]
      const r = koffi.call(slot(arr[0], 4), protoObjArrGetAt, arr[0], i, guidFromStr(IID.virtualDesktop), d)
      if (r === 0 && d[0] && vdIdOf(d[0]) === id) { target = d[0]; break }
    }
    if (!target) return 'TARGET-MISSING'
    const hrS = koffi.call(slot(vdmi, 9), protoSwitch, vdmi, target)
    return hrS === 0 ? 'OK' : `HR=${hrS}`
  } finally { release(target); release(arr[0]) }
}
const createDesktop = () => {
  const d = [null]
  const hr = koffi.call(slot(vdmi, 11), protoCreate, vdmi, d)
  if (hr !== 0 || !d[0]) throw new Error(`CreateDesktop hr=${hr}`)
  try { return vdIdOf(d[0]) } finally { release(d[0]) }
}
const removeDesktop = (id, fallbackId) => {
  const arr = [null]
  const hr = koffi.call(slot(vdmi, 7), protoGetDesktops, vdmi, arr)
  if (hr !== 0 || !arr[0]) throw new Error(`GetDesktops hr=${hr}`)
  let target = null, fallback = null
  try {
    const n = [0]
    koffi.call(slot(arr[0], 3), protoObjArrCount, arr[0], n)
    for (let i = 0; i < n[0]; i++) {
      const d = [null]
      const r = koffi.call(slot(arr[0], 4), protoObjArrGetAt, arr[0], i, guidFromStr(IID.virtualDesktop), d)
      if (r !== 0 || !d[0]) continue
      const idHere = vdIdOf(d[0])
      if (idHere === id) target = d[0]
      else if (idHere === fallbackId) fallback = d[0]
      else if (!fallback) fallback = d[0]
    }
    if (!target) return true
    const hrR = koffi.call(slot(vdmi, 13), protoRemove, vdmi, target, fallback ?? null)
    if (hrR !== 0) throw new Error(`RemoveDesktop hr=${hrR}`)
    return true
  } finally { release(target); release(fallback); release(arr[0]) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function attempt(label, settleMs) {
  const orig = currentId()
  const t0 = Date.now()
  const id = createDesktop()
  if (settleMs > 0) await sleep(settleMs)
  const swAt = Date.now() - t0
  const sw = switchTo(id)
  let applied = null
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (currentId() === id) { applied = Date.now() - t0; break }
    await sleep(20)
  }
  console.log(`${label}: 建${swAt}ms后切(${sw}) → 系统落到新桌面 ${applied === null ? 'TIMEOUT>3s（旧桌面=' + String(currentId()).slice(0, 8) + '）' : applied + 'ms'}`)
  // 清理：切回原桌面再删
  const back = switchTo(orig)
  await sleep(120)
  const removed = removeDesktop(id, orig)
  await sleep(120)
  const backOk = currentId() === orig && !desktops().includes(id)
  console.log(`${label}: 清理 切回(${back}) removed=${removed} 复原=${backOk}`)
  return applied !== null
}

async function main() {
  const groups = [['立即切', 0], ['停100ms切', 100], ['停300ms切', 300]]
  const summary = {}
  for (const [label, ms] of groups) {
    const results = []
    for (let i = 1; i <= 3; i++) results.push(await attempt(`${label}#${i}`, ms))
    summary[label] = results.filter(Boolean).length
    await sleep(300)
  }
  console.log('汇总（3 轮中落到新桌面次数）:', JSON.stringify(summary))
  console.log('PROBE VERDICT: DONE')
}
main().then(() => process.exit(0)).catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1) })
