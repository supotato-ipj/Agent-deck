// 构建清场（工单05）：dist 一律由构建再生，先删后建，杜绝孤儿产物。
// 已实证的孤儿类（tsc 与 copy-assets 均只增不删）：退役卡片的 dist/renderer/cards/<id>/
// 残留后，插件宿主运行时扫盘发现 manifest 即照常装载（manifest 即契约）——src 里已删除
// 的卡片继续出现在面板上。清整个 dist：main/preload/renderer 全部产物可再生
// （非 tsc 产物由 copy-assets 回填），不做精细判别。
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
rmSync(path.join(root, 'dist'), { recursive: true, force: true })
console.log('[clean-dist] dist/')
