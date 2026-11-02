/**
 * 对话窗的 preload 接线（工单364 真机轮 C11 抓到的根因）。
 *
 * 病灶：对话窗模块的编译产物在 dist/main/conversation/，preload 在 dist/preload/——
 * **两级**上溯。此前写 '../preload/index.js'（一级）⇒ 解析到 dist/main/preload/index.js
 * （不存在）⇒ Electron 跳过 preload ⇒ 窗内 window.deck 未定义 ⇒ 对话窗与内核**完全不通**：
 * 点发送毫无反应、变化推送也到不了窗。spec #361 的用户现场「故障发生在发起 ACP 请求之前」
 * 说的正是这一段（此前直调 conversation/prompt 的验收全绿，把这条真机面整个盖住了）。
 *
 * 同款病灶在任务栏弹窗上已修过（taskbar/popup.ts：'红轮实证：三级向上出了 dist 落
 * appRoot/preload，ENOENT → window.deck 未定义'）——本测试把那类错位钉死，不让它再来。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP_ROOT = path.resolve(__dirname, '../..')

/** 编译产物布局（tsconfig.json：rootDir=src、outDir=dist ⇒ src/main/x.ts → dist/main/x.js） */
const COMPILED_MODULE_DIR = path.join('dist', 'main', 'conversation')
const COMPILED_PRELOAD = path.join('dist', 'preload', 'index.js')
/** 相对路径一律写成正斜杠（源码里的字面量形态；Windows 上 path.join 给的是反斜杠） */
const toPosix = (p: string): string => p.split(path.sep).join('/')

describe('对话窗 preload 接线（工单364）', () => {
  it('从对话窗模块的编译目录到 preload 是两级上溯（dist/main/conversation → dist/preload）', () => {
    const rel = toPosix(path.relative(COMPILED_MODULE_DIR, COMPILED_PRELOAD))
    expect(rel).toBe('../../preload/index.js')
  })

  it('对话窗源码里用的就是那一条相对路径（错一级 ⇒ 窗内 window.deck 未定义 ⇒ 窗与内核不通）', () => {
    const src = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'conversation', 'window.ts'), 'utf8')
    const rel = toPosix(path.relative(COMPILED_MODULE_DIR, COMPILED_PRELOAD))
    expect(src).toContain("path.join(__dirname, '" + rel + "')")
    // 反例锚点：一级上溯落到 dist/main/preload/index.js（那儿没有文件）
    expect(src).not.toContain("path.join(__dirname, '../preload/index.js')")
  })

  it('按源码那行解析出来的 preload 路径，与编译产物里 preload 的实际位置同一个文件', () => {
    const rel = toPosix(path.relative(COMPILED_MODULE_DIR, COMPILED_PRELOAD))
    const resolved = path.resolve(APP_ROOT, COMPILED_MODULE_DIR, rel)
    expect(resolved).toBe(path.resolve(APP_ROOT, COMPILED_PRELOAD))
    // 构建在场时核文件确实在（未构建则跳过这一句——接线由上面两条钉住，不要求先构建）
    if (fs.existsSync(path.join(APP_ROOT, 'dist'))) {
      expect(fs.existsSync(resolved)).toBe(true)
    }
  })
})
