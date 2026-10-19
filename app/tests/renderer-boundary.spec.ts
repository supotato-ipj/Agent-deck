// 渲染层模块边界（回归防护，#55 真机事故的固化）：渲染层是浏览器 ESM——模块图里任何
// 一条解析不了的 import，整个 taskbar.js 静默不执行（真机：taskbar-ready 存证 10s 未到，
// 电池报「存证缺失右组矩形」，主进程侧一切正常，根因是 taskbar-view 拉了一条
// 无扩展名的主进程模块 import）。tsc 的 node 解析在编译期看不出问题，故在此按浏览器
// 口径静态扫描 src/renderer 下的 import。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const RENDERER_DIR = path.resolve(__dirname, '../src/renderer')

/** import 语句：type-only 的 `import type {...} from 'x'` 与值 import 分开取 */
const IMPORT_RE = /^\s*import\s+(type\s+)?\{[\s\S]*?\}\s*from\s+'([^']+)'/gm

function rendererFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...rendererFiles(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

interface ImportFact { file: string; spec: string; typeOnly: boolean }

function importsOf(file: string): ImportFact[] {
  const text = readFileSync(file, 'utf8')
  const out: ImportFact[] = []
  for (const m of text.matchAll(IMPORT_RE)) {
    out.push({ file: path.relative(RENDERER_DIR, file), spec: m[2], typeOnly: Boolean(m[1]) })
  }
  return out
}

const all = rendererFiles(RENDERER_DIR).flatMap(importsOf)

describe('渲染层模块边界', () => {
  it('扫描到渲染层 import（守卫自身不空转）', () => {
    expect(all.length).toBeGreaterThan(0)
  })

  it('渲染层不 import 主进程模块（跨进程边界 + 浏览器 ESM 解析双重禁）', () => {
    const bad = all.filter((i) => !i.typeOnly && i.spec.startsWith('../main/'))
    expect(bad.map((i) => `${i.file} → ${i.spec}`)).toEqual([])
  })

  it('渲染层值 import 的相对路径带 .js 后缀（浏览器 ESM 逐字解析）', () => {
    const bad = all.filter((i) => !i.typeOnly && i.spec.startsWith('.') && !i.spec.endsWith('.js'))
    expect(bad.map((i) => `${i.file} → ${i.spec}`)).toEqual([])
  })

  it('渲染层相对 import 的目标文件确实存在（去掉 .js 后缀即同名 .ts）', () => {
    const bad: string[] = []
    for (const i of all) {
      if (!i.spec.startsWith('.')) continue
      const abs = path.resolve(path.dirname(path.join(RENDERER_DIR, i.file)), i.spec.replace(/\.js$/, ''))
      if (!readdirSync(path.dirname(abs)).includes(`${path.basename(abs)}.ts`)) bad.push(`${i.file} → ${i.spec}`)
    }
    expect(bad).toEqual([])
  })
})
