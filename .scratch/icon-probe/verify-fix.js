// 工单01 修法实证探针（离线，单脚本）：对现场造的四条夹具 lnk 跑构建产物里的
// electronIconExtractor，验证图标源决策链在本机真实成立——
//   A target=notepad（无图标定位）→ notepad 图标（目标回落分支）
//   B target=charmap（无图标定位）→ charmap 图标；A≠B 即「不同快捷方式图标互不相等」成立
//   C target=notepad，IconLocation=charmap → charmap 图标；C=B 即「图标定位优先」成立
//   D target=缺失（死链）→ 通用图标（非空且≠A），死链回落观感成立
// 运行：cd app && npx electron ../.scratch/icon-probe/verify-fix.js
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

// 构建产物（npm run build 后存在）：绝对路径 require，使 'electron' 沿 app/node_modules 解析
const ADAPTER = 'D:/test-folder/wallpaperengine-research--gdf-01/app/dist/main/desktop/adapter.js'
const OUT = path.join(__dirname, 'verify-fix-result.json')

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-verify-fix-'))
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const missing = path.join(tmp, 'no-such-dir', 'nope.exe')
  // 夹具：ASCII-only 临时 ps1 走 -File（make-fixtures.ps1 同法，COM 不过内联 -Command）
  const ps1 = path.join(tmp, 'mk.ps1')
  fs.writeFileSync(ps1, [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($args[0])',
    '$s.TargetPath = $args[1]',
    'if ($args[2]) { $s.IconLocation = $args[2] }',
    '$s.Save()',
    "Write-Output ('exists=' + (Test-Path -LiteralPath $args[0]))",
  ].join('\n'), 'utf8')
  const mk = (name, target, icon) => {
    const p = path.join(tmp, name)
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, p, target, icon || ''], { encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0 || !fs.existsSync(p)) throw new Error(`夹具 ${name} 造失败: ${r.stderr || r.stdout}`)
    return p
  }
  const cases = {
    A_notepad: mk('A.lnk', path.join(sysRoot, 'notepad.exe')),
    B_charmap: mk('B.lnk', path.join(sysRoot, 'System32', 'charmap.exe')),
    C_iconloc: mk('C.lnk', path.join(sysRoot, 'notepad.exe'), path.join(sysRoot, 'System32', 'charmap.exe')),
    D_deadlink: mk('D.lnk', missing),
  }
  const { electronIconExtractor } = require(ADAPTER)
  const out = { electron: process.versions.electron, cases: {} }
  for (const [label, file] of Object.entries(cases)) {
    const t0 = Date.now()
    const dataUrl = await electronIconExtractor(file)
    out.cases[label] = {
      file,
      null: dataUrl === null,
      len: dataUrl ? dataUrl.length : 0,
      md5: dataUrl ? crypto.createHash('md5').update(dataUrl).digest('hex').slice(0, 10) : null,
      ms: Date.now() - t0,
    }
  }
  const c = out.cases
  out.assertions = {
    'A≠B（不同快捷方式图标互不相等——修法核心）': c.A_notepad.md5 !== c.B_charmap.md5,
    'C=B（声明的图标定位优先于目标）': c.C_iconloc.md5 === c.B_charmap.md5,
    'A、B、C 均非空（真图标而非 null）': [c.A_notepad, c.B_charmap, c.C_iconloc].every((x) => !x.null),
    'D 非空（死链回落通用图标）且≠A': !c.D_deadlink.null && c.D_deadlink.md5 !== c.A_notepad.md5,
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out.assertions, null, 1))
  console.log(JSON.stringify(out.cases, null, 1))
  app.exit(Object.values(out.assertions).every(Boolean) ? 0 : 1)
}).catch((e) => { console.error('verify failed:', e); app.exit(1) })
