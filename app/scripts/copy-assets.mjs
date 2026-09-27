import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dest = path.join(root, 'dist', 'renderer')
mkdirSync(dest, { recursive: true })
copyFileSync(path.join(root, 'src', 'renderer', 'index.html'), path.join(dest, 'index.html'))
console.log('[copy-assets] dist/renderer/index.html')
