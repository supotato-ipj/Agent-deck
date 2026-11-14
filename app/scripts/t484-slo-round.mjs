#!/usr/bin/env node
/**
 * 工单484 SLO 终验轮编排器（guard hold 内执行的三线真机测量）：
 *   线2 冷启动 ×3 轮：electron --panel 拉起 → boot-phase 六相位（#473 载体，DECK_RESIDENT_EVENT_LOG
 *      隔离落点）+ 拉起命令→面板窗/条带窗/panel-visible 的墙钟——「重启面板冷启动」形态；
 *   线3 点击：任务栏应用组真点击（SetCursorPos 驻留 ≥200ms → clickPhys，#483 P29 同法）→
 *      launching 态 DOM 时延（CDP 轮询 .tb-app.launching）+ issuedMs 事件戳（#483 口径）+
 *      普通应用（explorer/notepad）首窗出场墙钟；Win+D shell 态探针（#475 移交项触发条件判定）；
 *   线1 空闲 CPU 长测：静置 30s 后 panel-cpu-sample.mjs ≥12 分钟（入仓工具）+
 *      背景负载采样器全程标注（#478 教训：环境因子必须同窗量化）。
 * 收尾：--panel-quit 优雅退 → taskbar-layout.json 备份还原核对 → 生产面板从主检出 --panel 链恢复。
 *
 * 用法：node t484-orchestrator.mjs --app <worktree>/app --out <证据目录> [--cpu-ms 720000] [--skip-cpu]
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const thisDir = path.dirname(fileURLToPath(import.meta.url))

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

const appDir = path.resolve(arg('app', ''))
const outDir = path.resolve(arg('out', ''))
const cpuMs = Number(arg('cpu-ms', '720000'))
const skipCpu = process.argv.includes('--skip-cpu')
const cdpPort = String(arg('cdp-port', '9223'))

if (!appDir || !fs.existsSync(path.join(appDir, 'dist', 'main', 'index.js'))) {
  console.error('[t484] --app 必须指向已构建的 app 目录（dist/main/index.js 在场）')
  process.exit(2)
}
fs.mkdirSync(outDir, { recursive: true })

const electronExe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const mainCheckoutApp = 'D:\\test-folder\\wallpaperengine-research\\app'
const win32 = require(path.join(appDir, 'accept', 'lib', 'win32.js'))
const user32 = win32.koffi.load('user32.dll')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)')

const results = {
  startedAt: new Date().toISOString(),
  appDir,
  integrationTip: (() => {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: appDir, encoding: 'utf8' })
    return (r.stdout || '').trim() || 'unknown'
  })(),
  cpuMs,
  rounds: [],
  clicks: [],
  windProbe: null,
  cpuLong: null,
  env: {},
  layoutPin: null,
  restore: null,
  notes: [],
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) => console.log(`[t484] ${new Date().toISOString().slice(11, 23)} ${msg}`)
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const panelAlive = async (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

function titleOf(hwnd) {
  const buf = Buffer.alloc(1024)
  const n = GetWindowTextW(hwnd, buf, 512)
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2))
  return s
}

function visibleWindows() {
  return win32.topLevelWindows().map((h) => ({
    hwnd: Number(h),
    title: titleOf(h),
    cls: win32.className(h),
    exe: win32.exeNameOfWindow(h),
    pid: win32.threadIdOf(h).pid,
  }))
}

function readEvents(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 半行自愈口径：畸形行跳过 */ }
  }
  return out
}

function findWindowBy(pred) {
  return visibleWindows().find(pred) || null
}

// —— CDP（t477 同款：/json/list 找 target → WebSocket Runtime.evaluate）——
async function waitCdpTarget(urlSubstr, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      const hit = targets.find((t) => (t.url || '').includes(urlSubstr) && t.webSocketDebuggerUrl)
      if (hit) return hit
    } catch { /* 面板未就绪 */ }
    await sleep(400)
  }
  throw new Error(`CDP target ${urlSubstr} 未就绪（${timeoutMs}ms）`)
}

async function cdpEval(target, expression, timeoutMs = 8000) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const timer = setTimeout(() => { try { ws.close() } catch { } reject(new Error('CDP eval 超时')) }, timeoutMs)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id !== 1) return
      clearTimeout(timer)
      try { ws.close() } catch { }
      if (msg.error) reject(new Error(`CDP 错误: ${JSON.stringify(msg.error)}`))
      else if (msg.result?.result?.exceptionDetails) reject(new Error(`CDP 异常: ${JSON.stringify(msg.result.result.exceptionDetails)}`))
      else resolve(msg.result?.result?.value)
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket 连接失败')) }
  })
}

// —— 环境探针（如实标注：shell 态 / 并行负载 / 面板进程在场性）——
function envProbe(tag) {
  const progman = Number(win32.FindWindowExW(0, 0, 'Progman', null))
  let workerW = 0
  const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)')
  const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)')
  let cur = Number(GetTopWindow(0))
  let guardCount = 0
  while (cur && guardCount++ < 2048) {
    if (win32.className(cur) === 'WorkerW') workerW++
    cur = Number(GetWindow(cur, 2))
  }
  const wins = visibleWindows()
  const explorerFiles = wins.filter((w) => w.exe === 'explorer' && w.cls === 'CabinetWClass')
  const electrons = wins.filter((w) => w.exe === 'electron')
  const probe = {
    tag,
    at: new Date().toISOString(),
    progmanPresent: progman !== 0,
    workerWCount: workerW,
    nativeTaskbarVisible: win32.nativeTaskbarVisible(),
    desktopIconsVisible: win32.desktopIconsVisible(),
    explorerFileWindows: explorerFiles.map((w) => w.title),
    electronWindows: electrons.map((w) => ({ title: w.title, pid: w.pid })),
    topVisibleWindows: wins.length,
  }
  try {
    const psOut = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$t=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor | ? {$_.Name -eq '_Total'}).PercentProcessorTime; ` +
      `$tops=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ? {$_.Name -notin @('Idle','_Total') -and $_.PercentProcessorTime -gt 3} | sort PercentProcessorTime -desc | select -first 6 | % { \"$($_.Name)=$($_.PercentProcessorTime)%\" }; ` +
      `"cpu=$t;top=" + ($tops -join ';')`], { encoding: 'utf8', timeout: 30000 })
    const m = psOut.trim().match(/^cpu=(\d+);top=(.*)$/)
    if (m) { probe.cpuTotalPct = Number(m[1]); probe.topConsumers = m[2] }
  } catch (e) { probe.topProbeError = String(e.message || e) }
  results.env[tag] = probe
  log(`环境[${tag}] Progman=${probe.progmanPresent} WorkerW=${probe.workerW} 原生栏=${probe.nativeTaskbarVisible} ` +
    `cpu=${probe.cpuTotalPct ?? '?'}% top=${probe.topConsumers || '-'} electron窗=${probe.electronWindows.length}`)
  return probe
}

// —— 线2：冷启动轮（boot-phase 六相位 + 墙钟）——
async function bootRound(n, extraEnv = {}) {
  const evFile = path.join(outDir, `round-${n}`, 'events.jsonl')
  fs.rmSync(path.join(outDir, `round-${n}`), { recursive: true, force: true })
  const env = { ...process.env, DECK_RESIDENT_EVENT_LOG: evFile, DECK_CDP_PORT: cdpPort, ...extraEnv }
  const spawnT0 = Date.now()
  const child = spawn(electronExe, [appDir, '--panel'], { cwd: appDir, env, stdio: 'ignore', detached: true })
  child.unref()
  log(`round-${n} 面板拉起 pid=${child.pid}`)
  const marks = { windowPanelMs: null, windowStripMs: null, panelVisibleWallMs: null, taskbarReadyWallMs: null }
  let firstEventWallMs = null
  const deadline = spawnT0 + 60_000
  const seenPhases = []
  while (Date.now() < deadline) {
    await sleep(100)
    const evs = readEvents(evFile)
    if (evs.length && firstEventWallMs === null) firstEventWallMs = Date.now() - spawnT0
    for (const e of evs) {
      if (e.type === 'boot-phase' && !seenPhases.some((p) => p.phase === e.phase)) {
        seenPhases.push({ phase: e.phase, elapsedMs: e.elapsedMs, wallMs: e.t - spawnT0 })
        log(`round-${n} 相位 ${e.phase} @${e.elapsedMs}ms（墙钟 ${e.t - spawnT0}ms）`)
      }
      if (e.type === 'taskbar-ready' && marks.taskbarReadyWallMs === null) marks.taskbarReadyWallMs = e.t - spawnT0
      if (e.type === 'boot-phase' && e.phase === 'panel-visible') marks.panelVisibleWallMs = e.t - spawnT0
    }
    if (marks.windowPanelMs === null && findWindowBy((w) => w.title === 'AGENT DECK' && w.pid !== process.pid)) {
      marks.windowPanelMs = Date.now() - spawnT0
    }
    if (marks.windowStripMs === null && findWindowBy((w) => w.title === 'DECK-TASKBAR')) {
      marks.windowStripMs = Date.now() - spawnT0
    }
    if (seenPhases.some((p) => p.phase === 'panel-visible') && marks.taskbarReadyWallMs !== null) break
  }
  const round = {
    round: n,
    pid: child.pid,
    spawnT0,
    firstEventWallMs,
    ...marks,
    phases: seenPhases,
    allPhases: Object.fromEntries(seenPhases.map((p) => [p.phase, p.elapsedMs])),
    cmdToPanelVisibleWallMs: marks.panelVisibleWallMs,
    cmdToTaskbarReadyWallMs: marks.taskbarReadyWallMs,
    eventsFile: evFile,
    within60s: marks.panelVisibleWallMs !== null && marks.panelVisibleWallMs <= 60_000,
  }
  results.rounds.push(round)
  log(`round-${n} 完成：cmd→panel-visible=${round.cmdToPanelVisibleWallMs}ms cmd→窗=${marks.windowPanelMs}ms ` +
    `cmd→条带=${marks.windowStripMs}ms cmd→taskbar-ready=${marks.taskbarReadyWallMs}ms ≤60s=${round.within60s}`)
  return child
}

async function quitPanel(child, tag) {
  log(`${tag} 面板优雅退场（--panel-quit）`)
  const quitter = spawn(electronExe, [appDir, '--panel-quit'], { cwd: appDir, stdio: 'ignore', detached: true })
  quitter.unref()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && (await panelAlive(child.pid))) await sleep(400)
  const gone = !(await panelAlive(child.pid))
  if (!gone) {
    results.notes.push(`${tag}: 面板 20s 未退场，taskkill 兜底（如实记录）`)
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(2000)
  }
  log(`${tag} 面板退场确认 gone=${gone}（兜底=${!gone}）`)
  return gone
}

// —— 线3：点击测量（#483 P29 同法）——
function normExe(s) { return String(s || '').split('/').join('\\').toLowerCase() }

async function measureClick(targetExe, evFile, seq) {
  const rec = { seq, target: targetExe, startedAt: new Date().toISOString() }
  const stripTarget = await waitCdpTarget('taskbar.html', 10000)
  // 条带窗物理矩形 + 缩放（电池 toPhys 同法：rect.left + cssX × scale）
  const stripWin = findWindowBy((w) => w.title === 'DECK-TASKBAR')
  if (!stripWin) throw new Error('DECK-TASKBAR 窗未找到')
  const rect = win32.rectOf(stripWin.hwnd)
  const stripInfo = await cdpEval(stripTarget, `JSON.stringify({ w: document.documentElement.clientWidth, sw: screen.width, dpr: devicePixelRatio })`)
  const si = JSON.parse(stripInfo)
  const scale = (rect.right - rect.left) / si.sw
  rec.strip = { rect, screenW: si.sw, dpr: si.dpr, scale }
  // 目标条目矩形：优先 CDP DOM（现势），缺席回退 taskbar-geometry 存证帧（磁带）
  let apps = await cdpEval(stripTarget, `JSON.stringify([...document.querySelectorAll('.tb-app')].map((n) => { const r = n.getBoundingClientRect(); return { exe: n.dataset.exe, x: r.x, y: r.y, w: r.width, h: r.height } }))`)
  let appList = JSON.parse(apps)
  if (!appList.length) {
    const geom = readEvents(evFile).filter((e) => e.type === 'taskbar-geometry' && Array.isArray(e.apps)).pop()
    if (geom) appList = geom.apps.map((a) => ({ exe: a.id || a.exe, x: a.x, y: a.y, w: a.w, h: a.h }))
    rec.geometrySource = 'tape'
  } else rec.geometrySource = 'dom'
  rec.visibleApps = appList.map((a) => a.exe)
  const hit = appList.find((a) => normExe(a.exe) === normExe(targetExe))
  if (!hit) {
    rec.error = 'target-not-visible'
    return rec
  }
  const px = Math.round(rect.left + (hit.x + hit.w / 2) * scale)
  const py = Math.round(rect.top + (hit.y + hit.h / 2) * scale)
  rec.clickPoint = { px, py }
  // 基线窗口集（点击前）：首窗出场按「新 hwnd + exe 归一匹配」判——不设标题新性条件
  // （同名标题会误拒第二扇同名窗），新 hwnd 本身已排除既有窗
  const before = new Set(visibleWindows().filter((w) => w.exe !== '').map((w) => `${w.hwnd}`))
  // 热区开门驻留 + 真点击（#483 P29：驻留 ≥150ms；此处 200ms）
  win32.SetCursorPos(px, py)
  await sleep(200)
  const clickT0 = Date.now()
  win32.clickPhys(px, py, 'left')
  rec.clickT0 = clickT0
  // launching 态 DOM 轮询（≤1s 视觉反馈线）
  const exeLit = JSON.stringify(targetExe)
  for (let i = 0; i < 75 && rec.latLaunchingMs === undefined; i++) {
    try {
      const d = await cdpEval(stripTarget, `(() => { const norm = (s) => (s||'').split('/').join('\\\\').toLowerCase(); const el = [...document.querySelectorAll('.tb-app.launching')].find((n) => norm(n.dataset.exe) === norm(${exeLit})); return JSON.stringify({ on: !!el }); })()`)
      if (JSON.parse(d).on) rec.latLaunchingMs = Date.now() - clickT0
    } catch { /* CDP 瞬断重试 */ }
    if (rec.latLaunchingMs === undefined) await sleep(40)
  }
  // issuedMs 事件戳（#483 口径：taskbar-app-result）
  const deadlineR = Date.now() + 8000
  while (Date.now() < deadlineR && rec.issuedMs === undefined) {
    const ev = readEvents(evFile).find((e) => e.type === 'taskbar-app-result' && normExe(e.exe) === normExe(targetExe) && e.t >= clickT0)
    if (ev) { rec.issuedMs = ev.issuedMs; rec.action = ev.action; rec.ok = ev.ok; rec.resultAt = ev.t - clickT0 }
    else await sleep(50)
  }
  // 落定对账帧（launchExe 收下 ok）
  const deadlineS = Date.now() + 10000
  while (Date.now() < deadlineS && rec.settleAtMs === undefined) {
    const ev = readEvents(evFile).find((e) => e.type === 'taskbar-app-launch-result' && normExe(e.exe) === normExe(targetExe) && e.ok === true && e.t >= clickT0)
    if (ev) rec.settleAtMs = ev.t - clickT0
    else await sleep(50)
  }
  // 首窗出场（新可见顶层窗、exe 归一匹配——按 hwnd 新性判）
  const imgName = path.basename(targetExe).replace(/\.exe$/i, '').toLowerCase()
  const wDeadline = Date.now() + 20000
  while (Date.now() < wDeadline && rec.winAppearMs === undefined) {
    const fresh = visibleWindows().find((w) => w.exe === imgName && !before.has(`${w.hwnd}`))
    if (fresh) { rec.winAppearMs = Date.now() - clickT0; rec.window = { title: fresh.title, cls: fresh.cls, pid: fresh.pid, hwnd: fresh.hwnd } }
    else await sleep(60)
  }
  rec.verdict = {
    launching1s: rec.latLaunchingMs !== undefined && rec.latLaunchingMs <= 1000,
    issued1s: rec.issuedMs !== undefined && rec.issuedMs <= 1000,
    windowIn3s: rec.winAppearMs !== undefined && rec.winAppearMs <= 3000,
  }
  results.clicks.push(rec)
  log(`点击#${seq} ${imgName}: launching=${rec.latLaunchingMs ?? '>3s'}ms issued=${rec.issuedMs ?? '?'}ms ` +
    `settle=${rec.settleAtMs ?? '?'}ms 首窗=${rec.winAppearMs ?? '未出'}ms 判定=${JSON.stringify(rec.verdict)}`)
  return rec
}

async function closeWindow(hwnd, imgName, tag, pid) {
  if (!hwnd && !pid) return { closed: false, forced: false }
  if (hwnd) win32.PostMessageW(hwnd, 0x0010, 0, 0) // WM_CLOSE
  const deadline = Date.now() + 5000
  const goneCheck = () => {
    if (hwnd && !visibleWindows().some((w) => w.hwnd === hwnd)) return true
    if (!hwnd && pid && !visibleWindows().some((w) => w.pid === pid)) return true
    return false
  }
  while (Date.now() < deadline) {
    if (goneCheck()) return { closed: true, forced: false }
    await sleep(200)
  }
  if (imgName === 'notepad') { // 只允许对本轮自己开的 notepad 按 pid 兜底收杀；explorer 进程绝不动
    if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    await sleep(1500)
    const gone = goneCheck()
    if (!gone) results.notes.push(`${tag}: notepad pid=${pid} 强杀后仍未消失`)
    return { closed: gone, forced: true }
  }
  results.notes.push(`${tag}: WM_CLOSE 后 5s 未消失，未强杀（explorer 进程保护）`)
  return { closed: false, forced: false }
}

// —— Win+D shell 态探针（#475 移交项触发条件判定：show desktop 是否恢复）——
async function windProbe(evFile, victimHwnd, victimImg) {
  log(`Win+D 探针：牺牲窗 ${victimImg} hwnd=${victimHwnd}`)
  const rec = { at: new Date().toISOString(), victim: { hwnd: victimHwnd, img: victimImg } }
  const probeT0 = Date.now()
  win32.send([win32.keyInput(0x5b, win32.KEYDOWN), win32.keyInput(0x44, win32.KEYDOWN)])
  await sleep(80)
  win32.send([win32.keyInput(0x44, win32.KEYUP), win32.keyInput(0x5b, win32.KEYUP)])
  const dDeadline = Date.now() + 2500
  while (Date.now() < dDeadline && rec.minimized === undefined) {
    const w = visibleWindows().find((w) => w.hwnd === victimHwnd)
    if (!w) { rec.minimized = 'gone' }
    else {
      const iconic = win32.IsIconic(BigInt(victimHwnd)) || win32.IsIconic(victimHwnd)
      if (iconic) rec.minimized = true
    }
    if (rec.minimized === undefined) await sleep(60)
  }
  if (rec.minimized === undefined) rec.minimized = false
  rec.minimizedAfterMs = Date.now() - probeT0
  await sleep(1500)
  const panelW = visibleWindows().find((w) => w.title === 'AGENT DECK')
  rec.panelStateAfter = panelW ? (win32.IsIconic(panelW.hwnd) ? 'minimized' : 'visible') : 'absent'
  rec.coverEvents = readEvents(evFile).filter((e) => String(e.type || '').startsWith('cover-') && e.t >= probeT0)
  // 第二次 Win+D（还原拍）
  const restoreT0 = Date.now()
  win32.send([win32.keyInput(0x5b, win32.KEYDOWN), win32.keyInput(0x44, win32.KEYDOWN)])
  await sleep(80)
  win32.send([win32.keyInput(0x44, win32.KEYUP), win32.keyInput(0x5b, win32.KEYUP)])
  await sleep(2000)
  const victimAfter = visibleWindows().find((w) => w.hwnd === victimHwnd)
  rec.victimRestored = victimAfter ? !win32.IsIconic(victimHwnd) : 'gone'
  rec.restoreAfterMs = Date.now() - restoreT0
  rec.shellShowDesktopWorks = rec.minimized === true
  results.windProbe = rec
  log(`Win+D 探针：minimized=${rec.minimized}(${rec.minimizedAfterMs}ms) panel=${rec.panelStateAfter} ` +
    `还原=${rec.victimRestored} cover事件=${rec.coverEvents.length} → shell恢复=${rec.shellShowDesktopWorks}`)
  return rec
}

// —— 线1：空闲 CPU 长测（入仓工具 + 背景负载标注）——
async function cpuLong(child) {
  envProbe('cpu-pre')
  // 游标停驻条带中性空点（340,24 DIP，P29 中性点同款——不悬停任何条目）
  const stripWin = findWindowBy((w) => w.title === 'DECK-TASKBAR')
  if (stripWin) {
    const rect = win32.rectOf(stripWin.hwnd)
    const stripTarget = await waitCdpTarget('taskbar.html', 8000).catch(() => null)
    let scale = (rect.right - rect.left) / 1920
    if (stripTarget) {
      try {
        const si = JSON.parse(await cdpEval(stripTarget, `JSON.stringify({ sw: screen.width })`))
        scale = (rect.right - rect.left) / si.sw
      } catch { /* 回退 1920 假设 */ }
    }
    win32.SetCursorPos(Math.round(rect.left + 340 * scale), Math.round(rect.top + 24 * scale))
  }
  const loadOut = path.join(outDir, 'machine-load.jsonl')
  const loadForSec = Math.ceil((cpuMs + 30000 + 120000) / 1000)
  const loadProc = spawn(process.execPath, [
    path.join(thisDir, 'machine-load-sample.mjs'),
    '--out', loadOut, '--for-sec', String(loadForSec), '--interval-sec', '10',
  ], { stdio: 'inherit' })
  await sleep(1500)
  const sampleScript = path.join(appDir, 'scripts', 'panel-cpu-sample.mjs')
  log(`空闲 CPU 长测开始：settle 30s + ${cpuMs / 1000}s 采样（root=${child.pid}）`)
  const r = spawnSync(process.execPath, [
    sampleScript, '--pid', String(child.pid), '--duration-ms', String(cpuMs),
    '--settle-ms', '30000', '--label', 't484-idle-long', '--out', path.join(outDir, 'cpu-long.json'),
  ], { encoding: 'utf8', timeout: cpuMs + 30000 + 180000 })
  console.log((r.stdout || '').trim())
  if (r.status !== 0) console.error((r.stderr || '').trim())
  let sample = null
  try { sample = JSON.parse(fs.readFileSync(path.join(outDir, 'cpu-long.json'), 'utf8')) } catch { }
  try { process.kill(loadProc.pid, 9) } catch { }
  results.cpuLong = { sample, stdoutTail: (r.stdout || '').split('\n').slice(-3).join(' | ') }
  envProbe('cpu-post')
  log(`空闲 CPU 长测完成：${sample ? sample.percentOfMachine + '%' : '采样失败'} tree=${sample ? sample.treeAtStart.length : '?'} churn=${sample ? sample.churnedPids.length : '?'}`)
  return sample
}

// —— taskbar-layout.json 临时钉入 notepad（备份 → 改 → 还原 → 核对）——
function pinNotepad() {
  const layoutFile = path.join(process.env.APPDATA, 'agent-deck-panel', 'taskbar-layout.json')
  if (!fs.existsSync(layoutFile)) { results.notes.push('taskbar-layout.json 缺席（生产面板从未运行过？）——未钉入 notepad'); return null }
  const originalSha = sha256(layoutFile)
  const backup = path.join(outDir, 'taskbar-layout.backup.json')
  fs.copyFileSync(layoutFile, backup)
  const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'))
  const already = (layout.pinned || []).some((p) => normExe(p.exe) === normExe('C:\\Windows\\notepad.exe'))
  if (already) {
    results.layoutPin = { modified: false, originalSha, backup, note: 'notepad 已在钉入表（无需改动）' }
    return { layoutFile, modified: false }
  }
  layout.pinned.push({ exe: 'C:\\Windows\\notepad.exe', label: 'notepad', iconKey: 'c:\\windows\\notepad.exe|0' })
  fs.writeFileSync(layoutFile, JSON.stringify(layout, null, 1) + '\n')
  const modifiedSha = sha256(layoutFile)
  results.layoutPin = { modified: true, originalSha, modifiedSha, backup, layoutFile }
  log(`taskbar-layout.json 已钉入 notepad（原 sha=${originalSha.slice(0, 12)} 新 sha=${modifiedSha.slice(0, 12)}）`)
  return { layoutFile, modified: true }
}

function restoreLayout(pin) {
  if (!pin || !pin.modified) return
  fs.copyFileSync(pin.backup, pin.layoutFile)
  const sha = sha256(pin.layoutFile)
  results.layoutPin.restoredSha = sha
  results.layoutPin.restoreVerified = sha === pin.originalSha
  log(`taskbar-layout.json 已还原：sha 核对${results.layoutPin.restoreVerified ? '一致' : '不一致（异常！）'}`)
}

async function main() {
  envProbe('pre')
  // 用户窗保护基线：点击轮开始前就在场的 notepad / 文件资源管理器窗不归本轮管（电池纪律：
  // 不碰用户窗）——清理与残留核对一律只对「本轮新出现的 hwnd」负责
  const userBaseline = new Set(
    visibleWindows()
      .filter((w) => w.exe === 'notepad' || (w.exe === 'explorer' && w.cls === 'CabinetWClass'))
      .map((w) => w.hwnd),
  )
  results.userBaselineWindows = [...userBaseline]
  const pin = pinNotepad()

  // 线2 round-1：冷启动
  const c1 = await bootRound(1)
  await sleep(5000) // 等条带/桌面组件稳定

  // 线3：点击测量（explorer ×2、notepad ×1 保留窗给 Win+D 探针）
  const mine = [] // 本轮自己开出的窗（hwnd+pid+img），清理只针对它们
  let notepadWindow = null
  try {
    const clickAppList = ['C:\\Windows\\explorer.exe', 'C:\\Windows\\explorer.exe', 'C:\\Windows\\notepad.exe']
    for (let i = 0; i < clickAppList.length; i++) {
      const targetExe = clickAppList[i]
      const imgName = path.basename(targetExe).replace(/\.exe$/i, '').toLowerCase()
      // explorer 第二击前先收掉第一击的窗（保证「新窗出场」判据唯一）
      if (i === 1) {
        for (const m of mine.filter((m) => m.img === 'explorer')) {
          await closeWindow(m.hwnd, m.img, 'explorer-r1-clean', m.pid)
        }
        await sleep(1500)
      }
      const rec = await measureClick(targetExe, results.rounds[0].eventsFile, i + 1)
      if (rec.window && !userBaseline.has(rec.window.hwnd)) {
        mine.push({ hwnd: rec.window.hwnd, pid: rec.window.pid, img: imgName, title: rec.window.title })
        if (imgName === 'notepad') notepadWindow = rec.window
      }
      // explorer 击后即收（不保留）；notepad 保留给 Win+D 探针
      if (imgName === 'explorer') {
        for (const m of mine.filter((m) => m.img === 'explorer' && !m.closed)) {
          const r = await closeWindow(m.hwnd, m.img, `click-${i + 1}`, m.pid)
          m.closed = r.closed
        }
      }
      await sleep(1500)
    }
  } catch (e) {
    results.notes.push(`点击测量中断：${String(e.message || e)}`)
  }

  // Win+D 探针（#475 移交触发条件判定）——牺牲窗 = 本轮 notepad（若在）或补开一扇
  try {
    let victim = notepadWindow && visibleWindows().some((w) => w.hwnd === notepadWindow.hwnd)
      ? notepadWindow : null
    if (!victim) {
      const np = spawn('C:\\Windows\\notepad.exe', [], { stdio: 'ignore', detached: true })
      np.unref()
      const d = Date.now() + 8000
      while (Date.now() < d && !victim) {
        const w = visibleWindows().find((w) => w.exe === 'notepad' && !userBaseline.has(w.hwnd))
        if (w) victim = { title: w.title, cls: w.cls, pid: w.pid, hwnd: w.hwnd }
        await sleep(200)
      }
      if (victim) mine.push({ hwnd: victim.hwnd, pid: victim.pid, img: 'notepad', title: victim.title })
    }
    if (victim) {
      await windProbe(results.rounds[0].eventsFile, victim.hwnd, 'notepad')
    } else {
      results.notes.push('Win+D 探针无牺牲窗（notepad 未出窗）——shell 态未判，移交项维持待补测')
    }
  } catch (e) {
    results.notes.push(`Win+D 探针中断：${String(e.message || e)}`)
  }
  // 清理核对：本轮自开窗必须清零（用户基线窗不动、不记账）
  await sleep(1500)
  const cleanLog = []
  for (const m of mine) {
    const still = visibleWindows().some((w) => w.hwnd === m.hwnd)
    if (still && !m.closed) {
      const r = await closeWindow(m.hwnd, m.img, `final-clean-${m.img}`, m.pid)
      cleanLog.push({ ...m, closed: r.closed, forced: r.forced })
    } else cleanLog.push({ ...m, closed: !still })
  }
  results.clickCleanup = cleanLog
  const residue = cleanLog.filter((c) => !c.closed)
  if (residue.length) results.notes.push(`本轮自开窗残留：${JSON.stringify(residue)}`)
  log(`点击清理核对：${residue.length === 0 ? '本轮窗清零 ✓（用户基线窗不在清理面）' : '残留 ' + residue.length}`)

  await quitPanel(c1, 'round-1')
  await sleep(5000)

  // 线2 round-2：第二次冷启动
  const c2 = await bootRound(2)
  await quitPanel(c2, 'round-2')
  await sleep(5000)

  // 线2 round-3：第三次冷启动 + 同实例承载线1 CPU 长测
  const c3 = await bootRound(3)
  await sleep(3000)
  if (!skipCpu) await cpuLong(c3)
  await quitPanel(c3, 'round-3')

  restoreLayout(pin)
  envProbe('post')

  // 生产面板恢复（主检出 --panel 链）
  log('恢复生产面板（主检出 electron --panel）')
  const prod = spawn(path.join(mainCheckoutApp, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [mainCheckoutApp, '--panel'], { cwd: mainCheckoutApp, stdio: 'ignore', detached: true })
  prod.unref()
  const rDeadline = Date.now() + 40000
  let restored = null
  while (Date.now() < rDeadline && !restored) {
    restored = findWindowBy((w) => w.title === 'AGENT DECK') || null
    if (!restored) await sleep(500)
  }
  await sleep(3000)
  const prodStrip = findWindowBy((w) => w.title === 'DECK-TASKBAR')
  results.restore = {
    panelWindow: !!restored,
    stripWindow: !!prodStrip,
    nativeTaskbarVisible: win32.nativeTaskbarVisible(),
    at: new Date().toISOString(),
    pid: prod.pid,
  }
  log(`生产面板恢复：窗=${results.restore.panelWindow} 条带=${results.restore.stripWindow} 原生栏可见=${results.restore.nativeTaskbarVisible}`)

  results.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(results, null, 2) + '\n')
  log(`编排完成，summary 已写 ${path.join(outDir, 'summary.json')}`)
}

main().catch(async (err) => {
  results.notes.push(`编排异常终止：${String(err && err.stack || err)}`)
  try { fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(results, null, 2) + '\n') } catch { }
  console.error(err)
  process.exit(1)
})
