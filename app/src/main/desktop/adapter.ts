// 桌面承载适配层：纯逻辑（scan.ts/icons.ts）与真实世界之间的边缘。
// 真源一律延迟加载（沿用 hardware systemHardwareSources 先例）：契约测试注入假源时
// 不触碰 koffi/Electron。Electron 在纯 Node 下 require 返回路径字符串而非 API，
// 相应调用会 TypeError——均被调用方 try/catch 或注入源替代，不会走到。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopDirEntry, DesktopRoots } from './scan'

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

/** 图标提取真源：Electron app.getFileIcon（SHGetFileInfo 封装，lnk 自动解析目标图标）。
 * 失败以 rejection 上抛——IconCache 按尝试上限退避。 */
export function electronIconExtractor(filePath: string): Promise<string | null> {
  const { app } = require('electron')
  return app.getFileIcon(filePath, { size: 'large' }).then(
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
