import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rendererDest = path.join(root, 'dist', 'renderer')
mkdirSync(rendererDest, { recursive: true })
copyFileSync(path.join(root, 'src', 'renderer', 'index.html'), path.join(rendererDest, 'index.html'))
console.log('[copy-assets] dist/renderer/index.html')
// 任务栏条带页（工单49）：独立置顶窗的页面，与面板页同根同协议
copyFileSync(path.join(root, 'src', 'renderer', 'taskbar.html'), path.join(rendererDest, 'taskbar.html'))
console.log('[copy-assets] dist/renderer/taskbar.html')
// 托盘溢出菜单浮层页（工单162）：浮层窗的页面，与条带页同根同协议
copyFileSync(path.join(root, 'src', 'renderer', 'taskbar-overflow.html'), path.join(rendererDest, 'taskbar-overflow.html'))
console.log('[copy-assets] dist/renderer/taskbar-overflow.html')
// 任务栏弹窗菜单页（工单193）：通用竖排弹窗菜单通路的载页，与条带页同根同协议
copyFileSync(path.join(root, 'src', 'renderer', 'taskbar-menu.html'), path.join(rendererDest, 'taskbar-menu.html'))
console.log('[copy-assets] dist/renderer/taskbar-menu.html')
// 对话窗页（工单332）：内核 UI 的对话小窗，与面板页同根同协议
copyFileSync(path.join(root, 'src', 'renderer', 'conversation.html'), path.join(rendererDest, 'conversation.html'))
console.log('[copy-assets] dist/renderer/conversation.html')
// 内置桌面组件（工单10）：卡片入口由 tsc 编译就位，manifest 不经 tsc，逐个复制过去。
// 没有 manifest 的卡片目录对插件宿主不可见（manifest 即契约，缺契约不装载）。
const cardsSrc = path.join(root, 'src', 'renderer', 'cards')
for (const id of readdirSync(cardsSrc)) {
  const manifest = path.join(cardsSrc, id, 'plugin.json')
  if (!statSync(path.join(cardsSrc, id)).isDirectory() || !existsSync(manifest)) continue
  mkdirSync(path.join(rendererDest, 'cards', id), { recursive: true })
  copyFileSync(manifest, path.join(rendererDest, 'cards', id, 'plugin.json'))
  console.log(`[copy-assets] dist/renderer/cards/${id}/plugin.json`)
}
// 还原守护（icon-restore-watch.cjs）是独立运行的纯 JS 脚本（ELECTRON_RUN_AS_NODE），
// 不经 tsc，随构建复制到 dist/main 与编译产物同目录（index.js 以 __dirname 相对引用）。
const mainDest = path.join(root, 'dist', 'main')
mkdirSync(mainDest, { recursive: true })
copyFileSync(path.join(root, 'src', 'main', 'icon-restore-watch.cjs'), path.join(mainDest, 'icon-restore-watch.cjs'))
console.log('[copy-assets] dist/main/icon-restore-watch.cjs')
// 自启快捷方式的 COM 助手（工单11）：不经 tsc，随构建复制到 dist/main 与 autostart.js 同目录。
copyFileSync(path.join(root, 'src', 'main', 'autostart.ps1'), path.join(mainDest, 'autostart.ps1'))
console.log('[copy-assets] dist/main/autostart.ps1')
