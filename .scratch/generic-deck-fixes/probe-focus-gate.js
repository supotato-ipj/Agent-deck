// 实施闸门探针（工单02）：「不可激活窗口上点击后程序化聚焦能否稳定拿到键盘」。
// 生产链路复刻：panel 以 focusable:false 出生（永不激活）；ref 模拟用户工作窗持前台键盘；
// SendInput 点击 panel（断言点击不激活——永不顶起基线）→ setFocusable(true)+focus()（键盘模式开）
// → 断言前台=panel 且 SendInput 字符真落进输入框（DOM 取证）→ 立即 pinToBottom（键盘模式也钉底）
// → setFocusable(false)（键盘模式关）。重复 6 轮全过 = 闸门通过。
// 跑法（坑已踩，务必照做）：
//   cd app && ./node_modules/.bin/electron ../.scratch/generic-deck-fixes/probe-focus-gate.js
//   - koffi 用绝对路径指本 worktree 的 app/node_modules（.scratch 下相对 require 解析不到）
//   - uncaughtException 会弹阻塞式错误框挂死进程：落盘 + setTimeout 看门狗 + app.exit()
//   - 结果写 JSON 文件，不依赖 stdout
//   - 真鼠标点击不可靠（窗钉底后埋在真实窗口下）：点击前 WindowFromPoint 取证，被遮挡就
//     挪位重试，全被遮挡则跳过该轮点击——绝不对着别的窗口乱点。
const { app, BrowserWindow, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const koffi = require('D:/test-folder/wallpaperengine-research--gdf-02/app/node_modules/koffi')

const OUT = path.join(__dirname, 'probe-focus-gate-result.json')
const ROUNDS = 6
const result = { startedAt: new Date().toISOString(), rounds: [], pass: false, summary: '' }
const log = []
const say = (s) => { log.push(s); console.log(s) }
const dump = (code) => {
  result.log = log
  try { fs.writeFileSync(OUT, JSON.stringify(result, null, 2)) } catch { /* 尽力 */ }
  app.exit(code)
}
setTimeout(() => { say('WATCHDOG TIMEOUT'); dump(2) }, 90000)
process.on('uncaughtException', (e) => { say('UNCAUGHT ' + (e && e.stack || e)); result.fatal = String(e && e.stack || e); dump(3) })

const user32 = koffi.load('user32.dll')
koffi.struct('GATE_POINT', { x: 'long', y: 'long' })
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t, uint32)')
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()')
const WindowFromPoint = user32.func('uintptr_t __stdcall WindowFromPoint(GATE_POINT pt)')
const GetAncestor = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t, uint32)')
const KEYBDINPUT = koffi.struct('GATE_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
})
const MOUSEINPUT = koffi.struct('GATE_MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
})
const INPUTUNION = koffi.union('GATE_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT })
const INPUT = koffi.struct('GATE_INPUT', { type: 'uint32', u: INPUTUNION })
const SendInput = user32.func('int __stdcall SendInput(int, GATE_INPUT *, int)')
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int)')

const num = (v) => (typeof v === 'bigint' ? Number(v) : v)
const hwndOf = (win) => num(koffi.decode(win.getNativeWindowHandle(), 'uintptr_t'))
const HWND_BOTTOM = 1
const GW_HWNDNEXT = 2
const GA_ROOT = 2
const SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_NOOWNERZORDER = 0x0200
const KEYDOWN = 0x0000, KEYUP = 0x0002, KEYUNICODE = 0x0004

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fg = () => num(GetForegroundWindow())

function isAbove(a, b) {
  let h = a, guard = 0
  while (h && guard++ < 4096) {
    if (h === b) return true
    h = num(GetWindow(h, GW_HWNDNEXT))
  }
  return false
}
function pinBottom(hwnd) {
  return SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
}
function hitRoot(pt) {
  const h = num(WindowFromPoint(pt))
  return h ? num(GetAncestor(h, GA_ROOT)) || h : 0
}
/** KEYEVENTF_UNICODE 直注一个字符（探针场景只注 BMP 字符） */
function sendChar(ch) {
  const code = ch.codePointAt(0)
  const mk = (flags) => ({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: flags, time: 0, dwExtraInfo: 0 } } })
  SendInput(1, [mk(KEYUNICODE)], koffi.sizeof(INPUT))
  SendInput(1, [mk(KEYUNICODE | KEYUP)], koffi.sizeof(INPUT))
}
/** SendInput 物理点击（SendInput 绝对坐标为虚拟屏归一化 0..65535） */
function clickAt(px, py) {
  const vs = { x: GetSystemMetrics(76), y: GetSystemMetrics(77), w: GetSystemMetrics(78), h: GetSystemMetrics(79) }
  const nx = Math.min(65535, Math.max(0, Math.round((px - vs.x) * 65535 / (vs.w - 1))))
  const ny = Math.min(65535, Math.max(0, Math.round((py - vs.y) * 65535 / (vs.h - 1))))
  const mi = (dx, dy, flags) => ({ type: 0, u: { mi: { dx, dy, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } })
  const MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, ABSOLUTE = 0x8000
  SendInput(1, [mi(nx, ny, MOVE | ABSOLUTE)], koffi.sizeof(INPUT))
  SendInput(1, [mi(0, 0, LEFTDOWN)], koffi.sizeof(INPUT))
  SendInput(1, [mi(0, 0, LEFTUP)], koffi.sizeof(INPUT))
}

const PANEL_HTML = path.join(__dirname, 'probe-focus-gate-page.html')

async function main() {
  const f = screen.getPrimaryDisplay().scaleFactor
  const work = screen.getPrimaryDisplay().workArea

  const ref = new BrowserWindow({ x: work.x + 40, y: work.y + 40, width: 420, height: 260, show: false })
  ref.loadURL('data:text/html,<body style="background:#345;color:#fff">REF WORK WINDOW</body>')
  const panel = new BrowserWindow({
    x: work.x + 40, y: work.y + 340, width: 460, height: 220,
    show: false, frame: false, skipTaskbar: true, focusable: false,
  })
  panel.loadFile(PANEL_HTML)
  ref.once('ready-to-show', () => ref.show())
  panel.once('ready-to-show', () => panel.showInactive())
  await Promise.all([
    new Promise((r) => ref.webContents.once('did-finish-load', r)),
    new Promise((r) => panel.webContents.once('did-finish-load', r)),
  ])
  await sleep(500)

  const refH = hwndOf(ref)
  const panelH = hwndOf(panel)
  const inputPtDip = await panel.webContents.executeJavaScript(
    '(() => { const r = document.getElementById("q").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()')

  // 点击落点必须真落在 panel 上（WindowFromPoint 取证）；被用户窗遮挡就在工作区里挪位找空档
  const findPanelSpot = () => {
    const candidates = [[panel.getBounds().x + inputPtDip.x, panel.getBounds().y + inputPtDip.y]]
    const w = 460, h = 220
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        candidates.push([work.x + 60 + gx * Math.round((work.width - w - 120) / 4), work.y + 60 + gy * Math.round((work.height - h - 120) / 3)])
      }
    }
    for (const [dx, dy] of candidates) {
      const x = Math.round(dx * f), y = Math.round(dy * f)
      if (hitRoot({ x, y }) === panelH) return { x, y }
      // 挪窗到该候选位再取证（挪窗比换点稳：点固定打在输入框中心）
      SetWindowPos(panelH, 0, Math.round(dx), Math.round(dy), 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
      pinBottom(panelH)
      if (hitRoot({ x, y }) === panelH) return { x, y }
    }
    return null
  }

  const typed = []
  for (let i = 0; i < ROUNDS; i++) {
    const ch = 'abcdef'[i]
    const round = { i, ch, click: null, clickNoActivate: null, focusGot: null, charLanded: null, pinnedBelowWhileFocused: null, ok: false }
    try {
      // 1. ref 持前台键盘（用户正在别处打字）。进程首次拿前台权可能被拒——轮询等待；
      //    仍拿不到则如实记录并跳过点击（「点击不激活」断言前提不成立，聚焦链照测）。
      ref.focus()
      const refDeadline = Date.now() + 1500
      while (Date.now() < refDeadline && fg() !== refH) await sleep(80)
      round.refHadFg = fg() === refH

      // 2. SendInput 点击 panel（落点取证；被遮挡全挪不到就跳过点击——绝不错点用户窗）
      const spot = findPanelSpot()
      if (spot) {
        clickAt(spot.x, spot.y)
        await sleep(350)
        round.click = true
        // 3. 永不激活基线：点击 focusable:false 窗不夺前台（前提：ref 本就持前台）
        round.clickNoActivate = round.refHadFg ? fg() === refH : null
        round.fgAfterClick = fg() === refH ? 'ref' : fg() === panelH ? 'panel' : 'other'
      } else {
        round.click = false
        round.clickNoActivate = null
        round.clickSkipped = 'panel 落点全被遮挡（不点击，聚焦链照测）'
      }

      // 4. 键盘模式开：setFocusable(true) + focus()（生产实现同序）
      panel.setFocusable(true)
      panel.focus()
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && fg() !== panelH) await sleep(60)
      round.focusGot = fg() === panelH

      // 5. 字符取证：DOM 聚焦输入框 + SendInput 直注 + 读回值（真落到输入框才算拿到键盘）
      if (round.focusGot) {
        await panel.webContents.executeJavaScript('document.getElementById("q").focus()', true)
        await sleep(120)
        sendChar(ch)
        await sleep(400)
        const val = await panel.webContents.executeJavaScript('document.getElementById("q").value')
        typed.push(ch)
        round.charLanded = val === typed.join('')
        round.domValue = val
        // 6. 键盘模式也钉底：前台/激活态下立即 HWND_BOTTOM——仍持前台且落在 ref 之下
        pinBottom(panelH)
        await sleep(350)
        round.pinnedBelowWhileFocused = fg() === panelH && !isAbove(panelH, refH)
      }

      // 7. 键盘模式关：恢复不可聚焦 + 钉底（不还焦点，spec 拍板）
      panel.setFocusable(false)
      pinBottom(panelH)
      round.ok = round.clickNoActivate !== false && round.focusGot === true
        && round.charLanded === true && round.pinnedBelowWhileFocused === true    } catch (e) {
      round.error = String(e && e.stack || e)
      try { panel.setFocusable(false) } catch { /* 尽力复位 */ }
    }
    result.rounds.push(round)
    say(`[round ${i}] ${JSON.stringify(round)}`)
    await sleep(250)
  }

  const passRounds = result.rounds.filter((r) => r.ok).length
  const focusWins = result.rounds.filter((r) => r.focusGot).length
  const noAct = result.rounds.filter((r) => r.click === true && r.clickNoActivate).length
  const clicks = result.rounds.filter((r) => r.click === true).length
  result.pass = passRounds === ROUNDS
  result.summary = `focus 命中 ${focusWins}/${ROUNDS}，点击不激活 ${noAct}/${clicks}，整轮通过 ${passRounds}/${ROUNDS}`
    + (result.pass ? ' —— 闸门通过' : ' —— 闸门未过（如稳定拒绝，须带证据重议保底方案）')
  say(result.summary)
  ref.destroy()
  panel.destroy()
  dump(result.pass ? 0 : 1)
}

app.whenReady().then(main).catch((e) => { say('FAILED ' + (e && e.stack || e)); result.fatal = String(e && e.stack || e); dump(1) })
