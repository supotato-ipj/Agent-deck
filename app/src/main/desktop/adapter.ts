// 桌面承载适配层：纯逻辑（scan.ts/icons.ts）与真实世界之间的边缘。
// 真源一律延迟加载（沿用 hardware systemHardwareSources 先例）：契约测试注入假源时
// 不触碰 koffi/Electron。Electron 在纯 Node 下 require 返回路径字符串而非 API，
// 相应调用会 TypeError——均被调用方 try/catch 或注入源替代，不会走到。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopDirEntry, DesktopRoots } from './scan'
import { shortcutIconSource } from './icons'
import { extractIconDataUrl } from './icon-ffi'
import { watchDesktopRoots } from './watch'

const FILE_ATTRIBUTE_HIDDEN = 0x2
const FILE_ATTRIBUTE_SYSTEM = 0x4
const INVALID_FILE_ATTRIBUTES = 0xffffffff

let getAttributes: ((p: string) => number) | null = null

/** 文件属性读取（koffi 延迟绑定；读不到按可见处理，不因属性缺失丢条目） */
function fileAttributes(p: string): number {
  if (!getAttributes) {
    const koffi = require('koffi')
    // GetFileAttributesW 在 kernel32（不是 user32）
    const kernel32 = koffi.load('kernel32.dll')
    const GetFileAttributesW = kernel32.func('uint32 __stdcall GetFileAttributesW(const char16_t *lpFileName)')
    getAttributes = (file) => GetFileAttributesW(file)
  }
  return getAttributes(p)
}

/** 读一个桌面目录：readdir + stat(mtime) + 属性（hidden/system 标记，纯逻辑侧滤除） */
export function defaultListDir(dir: string): DesktopDirEntry[] {
  const out: DesktopDirEntry[] = []
  for (const de of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, de.name)
    let isDirectory: boolean
    let mtimeMs: number
    try {
      const st = fs.statSync(full)
      isDirectory = st.isDirectory()
      mtimeMs = st.mtimeMs
    } catch {
      continue // 竞态消失的条目：跳过，下一拍自然收敛
    }
    const attrs = fileAttributes(full)
    const isHidden = attrs !== INVALID_FILE_ATTRIBUTES && (attrs & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) !== 0
    out.push({ name: de.name, isDirectory, isHidden, mtimeMs })
  }
  return out
}

/** 桌面根：面板模式经 app.getPath 解析（含 OneDrive 重定向），公共桌面走 PUBLIC 环境变量 */
export function defaultDesktopRoots(): DesktopRoots {
  let user: string | undefined
  try {
    user = require('electron').app.getPath('desktop')
  } catch { /* 非 Electron 环境（离线测试未注入根时）走 homedir 猜测 */ }
  const publicRoot = process.env.PUBLIC ?? path.join(os.homedir(), '..', 'Public')
  return {
    user: user ?? path.join(os.homedir(), 'Desktop'),
    common: path.join(publicRoot, 'Desktop'),
  }
}

/** 条目存在性真源（工单06）：文件与目录都算存在——图标源决策用的就是它，
 * .lnk 目标可以是文件夹（目录图标由 getFileIcon 承担）。频次映射的 lnk stem
 * 回退守卫仍用 fsFileExists（只认文件），两者语义不同勿混用。 */
export function fsEntryExists(entryPath: string): boolean {
  try {
    fs.statSync(entryPath)
    return true
  } catch {
    return false
  }
}

function fsIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 图标提取真源：文件本体 FFI 直取优先（工单06），目录与回落走 Electron app.getFileIcon。
 * 失败以 rejection 上抛——IconCache 按尝试上限退避。
 * .lnk 绕行（工单01；上游 electron#15809/#18292：getFileIcon 对一切 lnk 返回字节级相同
 * 的通用图标）：先经 shell.readShortcutLink 解析图标源，按决策（图标定位优先随其索引、
 * 回落目标 0 号；存在性认目录）对本体提取；解析失败或源不可用回落对 lnk 本体提取
 * （即死链的既定观感）。
 * 巨型 exe 兜底（工单06）：getFileIcon（SHGetFileInfo 路径）对 ~235MB 级 exe 确定性
 * 返回通用应用图标（新路径副本仍复现，非图标缓存），故文件本体先走 SHDefExtractIconW
 * 直取图标资源（icon-ffi.ts），失败或目录形态再走 getFileIcon——目录图标、非 PE 文件、
 * 文档类不受影响。决策纯函数在 icons.ts。 */
export function electronIconExtractor(filePath: string): Promise<string | null> {
  const { app, shell } = require('electron')
  let source = filePath
  let iconIndex = 0
  if (path.extname(filePath).toLowerCase() === '.lnk') {
    try {
      const details = shell.readShortcutLink(filePath)
      const picked = shortcutIconSource(details.icon, details.target, fsEntryExists, details.iconIndex ?? 0)
      if (picked) {
        source = picked.source
        iconIndex = picked.iconIndex
      }
    } catch { /* lnk 解析失败：回落对本体提取 */ }
  }
  if (!fsIsDirectory(source)) {
    const direct = extractIconDataUrl(source, iconIndex, 48)
    if (direct) return Promise.resolve(direct)
  }
  return app.getFileIcon(source, { size: 'large' }).then(
    (img: { isEmpty(): boolean; toDataURL(): string }) => (img.isEmpty() ? null : img.toDataURL()),
    (err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err))
    },
  )
}

/** 启动真源：shell.openPath（ShellExecute 语义，lnk 解析目标后启动）；'' 即成功 */
export function shellOpen(filePath: string): Promise<string> {
  const { shell } = require('electron')
  return shell.openPath(filePath)
}

/** 资源管理器定位真源（工单24，搜索 reveal 同款机制）：explorer /select,<path>。
 * 不带 windowsHide——它经 STARTUPINFO 传 SW_HIDE，会把 explorer 的文件夹窗口一起藏掉
 * （电池实测：reveal ok=true 但 CabinetWClass 永不出现）；GUI 应用无控制台可闪。
 * fire-and-forget：定位失败静默（explorer 缺席属环境异常，不打断面板）。 */
export function explorerReveal(path: string): void {
  try {
    spawn('explorer', ['/select,', path], { stdio: 'ignore' })
  } catch {
    // 静默：同上
  }
}

/** 文本剪贴板写真源（工单24 复制路径）：主进程 clipboard.writeText——面板永不激活
 * （focusable:false），渲染层 navigator.clipboard 会因文档无焦点拒绝，主进程无此要求。 */
export function electronClipboardWrite(text: string): void {
  try {
    require('electron').clipboard.writeText(text)
  } catch {
    // 剪贴板缺席属环境异常，静默（离线纯 Node 下的 require 只拿到路径串）
  }
}

/** lnk 目标解析真源：shell.readShortcutLink（同步）；非 lnk/解析失败返回 null */
export function electronShortcutTarget(lnkPath: string): string | null {
  try {
    const { shell } = require('electron')
    return shell.readShortcutLink(lnkPath).target ?? null
  } catch {
    return null
  }
}

/** 路径存在性真源（频次映射的 lnk stem 回退守卫用；盘上却解不出目标的 lnk 不回退） */
export function fsFileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/** 摆位存储真源：读（缺失返回 null）；写为原子替换（tmp + rename），坏写不碰原文件 */
export function readStoreText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function writeStoreText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/** 桌面目录监听真源：fs.watch 化的看门狗（纯逻辑与 settle 语义在 watch.ts） */
export function defaultWatchDesktopRoots(roots: DesktopRoots, onChange: () => void): () => void {
  return watchDesktopRoots(roots, onChange)
}
