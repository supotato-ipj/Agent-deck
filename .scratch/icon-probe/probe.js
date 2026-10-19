// 图标探针（问题1 事实查证）：对真实桌面条目跑 Electron app.getFileIcon，
// 三档尺寸对比，结果与 PNG 落盘 —— 判断「应用区图标全空白」出在提取层还是渲染层。
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const OUT_DIR = __dirname

function listVisible(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .filter((f) => {
        try { return !fs.statSync(f).isDirectory() } catch { return false }
      })
  } catch { return [] }
}

app.whenReady().then(async () => {
  const desktop = app.getPath('desktop')
  const common = path.join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop')
  const files = [...listVisible(desktop), ...listVisible(common)].slice(0, 20)
  const report = { electron: process.versions.electron, desktop, common, items: [] }
  let saved = 0
  for (const f of files) {
    const item = { file: f, results: {} }
    for (const size of ['small', 'normal', 'large']) {
      try {
        const img = await app.getFileIcon(f, { size })
        const rec = {
          isEmpty: img.isEmpty(),
          dim: `${img.getSize().width}x${img.getSize().height}`,
          dataUrlLen: img.toDataURL().length,
        }
        if (!img.isEmpty() && size === 'large' && saved < 10) {
          fs.writeFileSync(path.join(OUT_DIR, `icon-${String(saved).padStart(2, '0')}-${path.basename(f).replace(/[^\w.-]/g, '_')}.png`), img.toPNG())
          saved++
        }
        item.results[size] = rec
      } catch (err) {
        item.results[size] = { error: String((err && err.message) || err) }
      }
    }
    report.items.push(item)
  }
  fs.writeFileSync(path.join(OUT_DIR, 'probe-result.json'), JSON.stringify(report, null, 1))
  console.log(`probe done: ${report.items.length} items, ${saved} png saved`)
  app.exit(0)
}).catch((err) => { console.error('probe failed:', err); app.exit(1) })
