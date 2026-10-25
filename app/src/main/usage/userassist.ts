// 冷启动先验取数（工单06）：读 HKCU UserAssist 计数（explorer 的应用启动记录）。
// 读法 = reg.exe export 导出注册表分支为 .reg 文本再纯解析——比 advapi32 枚举的
// 指针体操稳（ROT13 名字里的引号/反斜杠由 reg 导出的转义层兜住），失败静默返回空表
// （先验只是冷启动加权项，读不到不阻塞面板）。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseUserAssistEntry, rot13, type PriorEntry } from './score'

const USERASSIST_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist'

/** reg 导出文本里的一个值名去转义（"a\\"b" → a"b） */
function unescapeRegName(quoted: string): string {
  let out = ''
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i]
    if (c !== '\\' || i + 1 >= quoted.length) out += c
    else {
      const next = quoted[i + 1]
      if (next === '\\' || next === '"') {
        out += next
        i++
      } else {
        out += c
      }
    }
  }
  return out
}

/**
 * 纯解析 .reg 导出文本：只收以 \Count 结节的分支下 hex: 值；同路径多条取次数大者。
 * 文本为 UTF-16LE（reg export v5 格式）时由调用方先解码，这里收 string。
 */
export function parseUserAssistRegExport(text: string): Map<string, PriorEntry> {
  const prior = new Map<string, PriorEntry>()
  const lines = text.split(/\r?\n/)
  let inCount = false
  let i = 0
  while (i < lines.length) {
    let line = lines[i].trim()
    i++
    if (line.startsWith('[')) {
      inCount = /\\Count\]$/.test(line)
      continue
    }
    if (!inCount || !line.startsWith('"')) continue
    // 长 hex 值被 reg 导出折行（行尾反斜杠续行），先并回一行
    while (line.endsWith('\\') && i < lines.length) {
      line = line.slice(0, -1) + lines[i].trim()
      i++
    }
    const m = /^"(.*)"=hex:([0-9a-fA-F]{2}(?:,[0-9a-fA-F]{2})*)$/.exec(line)
    if (!m) continue
    const bytes = Uint8Array.from(m[2].split(',').map((h) => parseInt(h, 16)))
    const parsed = parseUserAssistEntry(unescapeRegName(m[1]), bytes)
    if (!parsed) continue
    const low = parsed.path.toLowerCase()
    if (!low.endsWith('.exe') && !low.endsWith('.lnk')) continue
    const existing = prior.get(low)
    if (!existing || parsed.count > existing.count) prior.set(low, { count: parsed.count, lastMs: parsed.lastMs })
  }
  return prior
}

/** 读系统现成启动记录为 {路径(小写): PriorEntry}；失败空表（先验可缺位）。
 * 异步（execFile 走线程池）——reg 导出一次性成本不得堵 boot 关键路径（05 教训：
 * dock 必须随窗口首绘就位；先验晚到几百 ms 只影响推荐序的初值，1Hz 重算自然收敛）。 */
export function readUserAssistPrior(): Promise<Map<string, PriorEntry>> {
  return new Promise((resolve) => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ua-')), 'userassist.reg')
    execFile('reg.exe', ['export', USERASSIST_KEY, tmp, '/y'], { timeout: 15000 }, (err) => {
      try {
        if (err || !fs.existsSync(tmp)) return resolve(new Map())
        resolve(parseUserAssistRegExport(fs.readFileSync(tmp, 'utf16le')))
      } catch {
        resolve(new Map())
      } finally {
        try {
          fs.unlinkSync(tmp)
          fs.rmdirSync(path.dirname(tmp))
        } catch {
          /* 尽力清理 */
        }
      }
    })
  })
}
