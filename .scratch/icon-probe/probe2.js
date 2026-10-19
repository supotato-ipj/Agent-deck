// 探针2（判别 .lnk 图标解析失败环节）：目标 exe / .ico 直取 vs .lnk 副本 vs 新造 .lnk
// 测试件由 make-fixtures.ps1 预先造好（%TEMP%\iconprobe2）
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')

const OUT_DIR = __dirname
const tmp = path.join(os.tmpdir(), 'iconprobe2')

async function main() {
  const cases = [
    ['kimi-target-exe', 'C:\\Users\\An W\\AppData\\Local\\Programs\\kimi-desktop\\Kimi.exe'],
    ['wechat-target-exe', 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'],
    ['qoder-ico-file', 'C:\\Users\\An W\\AppData\\Roaming\\com.qodercn.app.stable\\application-icons\\085bc5beb88e5f4c8445c735578f2a41393eac205cb979d76df98b600ebbdd4b.ico'],
    ['notepad-exe', 'C:\\Windows\\notepad.exe'],
    ['kimi-lnk-original', 'C:\\Users\\An W\\Desktop\\Kimi.lnk'],
    ['kimi-lnk-tmpcopy', path.join(tmp, 'Kimi-copy.lnk')],
    ['wechat-lnk-tmpcopy', path.join(tmp, 'WeChat-copy.lnk')],
    ['fresh-notepad-lnk', path.join(tmp, 'fresh-notepad.lnk')],
    ['plain-txt', path.join(OUT_DIR, 'probe-result.json')],
  ]
  const out = []
  for (const [label, file] of cases) {
    for (const size of ['normal', 'large']) {
      try {
        const img = await app.getFileIcon(file, { size })
        const png = img.toPNG()
        out.push({
          label, size, file,
          exists: fs.existsSync(file),
          isEmpty: img.isEmpty(),
          dim: `${img.getSize().width}x${img.getSize().height}`,
          md5: crypto.createHash('md5').update(png).digest('hex').slice(0, 10),
          pngBytes: png.length,
        })
      } catch (err) {
        out.push({ label, size, file, error: String((err && err.message) || err) })
      }
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'probe2-result.json'), JSON.stringify({ tmp, out }, null, 1))
  for (const r of out) {
    console.log(r.error ? `${r.label}/${r.size}: ERR ${r.error}` : `${r.label}/${r.size}: ${r.md5} ${r.dim} ${r.pngBytes}B exists=${r.exists}`)
  }
  app.exit(0)
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
