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
import { CF_HDROP, DROPEFFECT_MOVE, clipboardFfi, retryClipboardBusy } from './clipboard-files'
import type { ClipboardEffect } from './clipboard-files'
import { panelLabels } from '../lag-sentinel'
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

/** 条目存在性真源（工单06 图标源决策；工单28 起兼作重命名的重名冲突校验——文件与
 * 目录都算存在：.lnk 目标可以是文件夹（目录图标由 getFileIcon 承担），改名落到既有
 * 名字（含目录）会被 fs.rename 静默覆写，须显式挡下。频次映射的 lnk stem 回退守卫
 * 仍用 fsFileExists（只认文件），两者语义不同勿混用。 */
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

/** 回收站删除真源（工单27）：shell.trashItem——删除=送回收站（误删可找回，真桌面同款）。
 * '' 即成功，否则错误串（shellOpen 同语）。主进程 API：数据面子进程经协议代理调用
 * （ProxyShortcutResolver 同法），本函数只在主进程侧执行。 */
export function electronTrashItem(filePath: string): Promise<string> {
  return require('electron')
    .shell.trashItem(filePath)
    .then(
      () => '',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
}

/** 剪贴板文件读取结果（工单30 粘贴）：CF_HDROP 路径清单 + Preferred DropEffect 语义。
 * null = 剪贴板没有文件（空/纯文本），调用方按「不可粘贴」处理。effect 复用写向已导出的
 * ClipboardEffect（评审结构项：不再自拼内联联合）。 */
export interface ClipboardFiles {
  paths: string[]
  effect: ClipboardEffect
}

/** 双 NUL 结尾路径表的定界扫描（宽/ANSI 共用骨架，评审结构项：两分支仅步长与解码不同）：
 * wide=2 字节步进 UTF-16（现代剪贴板源恒如此）、否则 1 字节 ANSI 兜底（GBK 名会乱码，
 * 旧源才走此路）。空串 = 列表终止符；缓冲截断归已得名单（防御，坏形态不出假名单）。 */
function scanHDropPathList(body: Buffer, wide: boolean): string[] {
  const step = wide ? 2 : 1
  const terminatedAt = (at: number): boolean => (wide ? body[at] === 0 && body[at + 1] === 0 : body[at] === 0)
  const paths: string[] = []
  let pos = 0
  for (;;) {
    let end = pos
    while (end + step <= body.length && !terminatedAt(end)) end += step
    if (end + step > body.length) break // 缓冲截断：防御
    if (end === pos) break // 空串 = 列表终止符（双 NUL）
    paths.push(body.subarray(pos, end).toString(wide ? 'utf16le' : 'utf8'))
    pos = end + step
  }
  return paths
}

/** DROPFILES 缓冲解析（CF_HDROP，工单30 真机修复后导出离线锁定）：头 20 字节
 * （pFiles 偏移/pt/fNC/fWide——fWide 落 16 偏移，clipboard-files.spec 真机差分实证），
 * 其后是双 NUL 结尾的路径串序列。坏形态（短缓冲/坏偏移/截断）归空名单，不炸不出假名单。 */
export function parseHDropBuffer(buf: Buffer): string[] {
  if (buf.length < 24) return []
  const offset = buf.readUInt32LE(0)
  if (offset <= 0 || offset >= buf.length) return []
  // fWide 是 Win32 BOOL：非零即真（PS Set-Clipboard -Path 真机实锤写 0xFFFFFFFF，
  // 按 ===1 判会把宽表误走 ANSI 分支，解析成逐字符假名单）
  const wide = buf.readUInt32LE(16) !== 0
  return scanHDropPathList(buf.subarray(offset), wide)
}

/** Preferred DropEffect 语义归约：move=2 判 move，其余（copy=1/缺格式/短缓冲）归 copy */
export function dropEffectOf(buf: Buffer | null | undefined): ClipboardEffect {
  return buf && buf.length >= 4 && buf.readUInt32LE(0) === DROPEFFECT_MOVE ? 'move' : 'copy'
}

/** 单次读取尝试（koffi 惰性绑定用 clipboard-files 的读写共用单一出处，进程内缓存一份）：
 * user32 开合剪贴板 + kernel32 GlobalLock 取字节。CF_HDROP 与 Preferred
 * DropEffect（RegisterClipboardFormat）两格式一次开合取齐。busy = 剪贴板被他人占用
 * （OpenClipboard 落败，值得小退避重试）；empty = 剪贴板无文件（重试无意义）。 */
type ReadAttempt = { kind: 'files'; files: ClipboardFiles } | { kind: 'busy' } | { kind: 'empty' }

function koffiClipboardFilesReadOnce(): ReadAttempt {
  const ffi = clipboardFfi()
  if (!ffi.isAvailable(CF_HDROP)) return { kind: 'empty' }
  if (!ffi.open(0)) return { kind: 'busy' } // 剪贴板被他人占用（读剪贴板类工具常驻轮询）
  try {
    const readBytes = (format: number): Buffer | null => {
      const h = ffi.get(format)
      if (!h) return null
      const size = ffi.sizeOf(h)
      const ptr = size > 0 ? ffi.lock(h) : 0
      if (!ptr) return null
      try {
        return ffi.decodeBytes(ptr, size)
      } finally {
        ffi.unlock(h)
      }
    }
    const drop = readBytes(CF_HDROP)
    if (!drop) return { kind: 'empty' }
    const paths = parseHDropBuffer(drop)
    if (!paths.length) return { kind: 'empty' }
    const effect = ffi.registerFormat('Preferred DropEffect')
    return { kind: 'files', files: { paths, effect: dropEffectOf(effect > 0 ? readBytes(effect) : undefined) } }
  } finally {
    ffi.close()
  }
}

/** 文件剪贴板读真源（工单30 粘贴读向，真机修复版）：koffi 直调 user32——对齐写向
 * （koffiClipboardFilesWrite）的唯一 native 路线。Electron 路线已删：真机探针实证
 * Electron 44.4.3 的 clipboard 只剩 clear/has/read/readText/write/write 六面，
 * readBuffer（按名读原始格式）与 writeBuffer 同批移除，旧「readBuffer 优先、FFI 兜底」
 * 的环境守卫（!clipboard?.readBuffer 即返回 null）在真实主进程恒短路——剪贴板有文件
 * 也 0ms 返 null，即电池 P5.16-a/Ctrl+V 的快败根因。
 * 剪贴板被占（busy）时按读写共用骨架小退避重试（读剪贴板类工具常驻轮询，电池的
 * PS 核验段正属此类）；真无文件立即返回。null = 剪贴板没有文件/环境缺席（koffi 装载
 * 失败等异常折入不可贴，调用方永远拿到结果不挂起）。 */
export async function koffiClipboardFilesRead(): Promise<ClipboardFiles | null> {
  const result = await retryClipboardBusy(async (): Promise<ReadAttempt> => {
    try {
      // 滞后哨兵（工单117）：OpenClipboard 系是跨进程互斥面（审计 B7，被占时退避重试）
      return panelLabels.run('clipboard-read', () => koffiClipboardFilesReadOnce())
    } catch {
      return { kind: 'empty' } // koffi/剪贴板缺席属环境异常：按不可贴处理
    }
  }, (r) => r.kind === 'busy')
  return result.kind === 'files' ? result.files : null
}

/** 递归复制真源（工单30 粘贴 copy 语义；文件与目录同款，fs.cp 递归）。'' 即成功，否则
 * 错误串（open 同语）。force=false + errorOnExist 兜底防覆写——目标名由服务层
 * duplicateName 求空位，此处绝不允许静默覆盖（AC「多份不互相覆盖」的最后一道闸）。 */
export function fsCopyEntry(srcPath: string, dstPath: string): Promise<string> {
  return fs.promises.cp(srcPath, dstPath, { recursive: true, force: false, errorOnExist: true }).then(
    () => '',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
}

/** 删除条目真源（工单30 move 跨卷回退的删源半步；文件与目录树同款，fs.rm）。'' 即成功。 */
export function fsRemoveEntry(srcPath: string): Promise<string> {
  return fs.promises.rm(srcPath, { recursive: true }).then(
    () => '',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
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

/** 重命名真源（工单28）：fs.promises.rename——纯 Node API，数据面子进程可直接执行
 * （shell.trashItem 那样的主进程代理在此不需要）。'' 即成功，否则错误串（open 同语）。 */
export function fsRename(oldPath: string, newPath: string): Promise<string> {
  return fs.promises.rename(oldPath, newPath).then(
    () => '',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
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
