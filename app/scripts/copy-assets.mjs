import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rendererDest = path.join(root, 'dist', 'renderer')
mkdirSync(rendererDest, { recursive: true })
copyFileSync(path.join(root, 'src', 'renderer', 'index.html'), path.join(rendererDest, 'index.html'))
console.log('[copy-assets] dist/renderer/index.html')
// 还原守护（icon-restore-watch.cjs）是独立运行的纯 JS 脚本（ELECTRON_RUN_AS_NODE），
// 不经 tsc，随构建复制到 dist/main 与编译产物同目录（index.js 以 __dirname 相对引用）。
const mainDest = path.join(root, 'dist', 'main')
mkdirSync(mainDest, { recursive: true })
copyFileSync(path.join(root, 'src', 'main', 'icon-restore-watch.cjs'), path.join(mainDest, 'icon-restore-watch.cjs'))
console.log('[copy-assets] dist/main/icon-restore-watch.cjs')
