import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_HOST, PLUGIN_SCHEME, mimeOf, resolveAssetUrl, type AssetRoot } from '../../src/main/plugins/assets'

/** 插件资产寻址（工单10 辅缝）：协议 URL → 磁盘文件 + MIME 的纯解析，隔离 Electron */

function tmpDir(prefix = 'deck-assets-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function roots(): { list: AssetRoot[]; appDir: string; pluginDir: string } {
  const appDir = tmpDir()
  const pluginDir = tmpDir()
  fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(appDir, 'main.js'), 'export {}')
  fs.writeFileSync(path.join(pluginDir, 'card.js'), 'export default {}')
  return { list: [{ host: APP_HOST, dir: appDir }, { host: 'clock', dir: pluginDir }], appDir, pluginDir }
}

describe('插件资产寻址（deck-plugin:// 解析）', () => {
  it('应用根与插件根各自命中', () => {
    const { list, appDir, pluginDir } = roots()
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://${APP_HOST}/index.html`, list)).toEqual({
      file: path.join(appDir, 'index.html'),
      mime: 'text/html',
    })
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://clock/card.js`, list)).toEqual({
      file: path.join(pluginDir, 'card.js'),
      mime: 'text/javascript',
    })
  })

  it('查询串（缓存代号 ?v=）不影响寻址', () => {
    const { list, pluginDir } = roots()
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://clock/card.js?v=3`, list)).toEqual({
      file: path.join(pluginDir, 'card.js'),
      mime: 'text/javascript',
    })
  })

  it('子目录资产可寻址', () => {
    const { list, pluginDir } = roots()
    fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(pluginDir, 'lib', 'util.js'), 'export {}')
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://clock/lib/util.js`, list)?.file)
      .toBe(path.join(pluginDir, 'lib', 'util.js'))
  })

  it.each([
    ['父目录穿越', `${PLUGIN_SCHEME}://${APP_HOST}/../secret.txt`],
    ['编码后的穿越', `${PLUGIN_SCHEME}://${APP_HOST}/%2e%2e/secret.txt`],
    ['深层穿越', `${PLUGIN_SCHEME}://${APP_HOST}/a/b/../../../secret.txt`],
    ['反斜杠', `${PLUGIN_SCHEME}://${APP_HOST}/..\\secret.txt`],
    ['根路径内的 NUL', `${PLUGIN_SCHEME}://${APP_HOST}/card%00.js`],
  ])('%s → 拒绝（不落到根外）', (_label, url) => {
    const { list } = roots()
    expect(resolveAssetUrl(url, list)).toBeNull()
  })

  it('未知主机 → 拒绝', () => {
    const { list } = roots()
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://nope/card.js`, list)).toBeNull()
  })

  it('非 deck-plugin 协议 → 拒绝', () => {
    const { list } = roots()
    expect(resolveAssetUrl(`https://example.com/card.js`, list)).toBeNull()
    expect(resolveAssetUrl(`file:///C:/card.js`, list)).toBeNull()
  })

  it('不存在的文件 → 拒绝', () => {
    const { list } = roots()
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://clock/missing.js`, list)).toBeNull()
  })

  it('目录 → 拒绝（协议只投文件）', () => {
    const { list, pluginDir } = roots()
    fs.mkdirSync(path.join(pluginDir, 'sub'), { recursive: true })
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://clock/sub`, list)).toBeNull()
  })

  it('根列表为空 → 一律拒绝', () => {
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://${APP_HOST}/index.html`, [])).toBeNull()
  })

  it('主机名逐字匹配（非特殊协议的主机名不做大小写归一，id 本身限小写）', () => {
    // WHATWG URL 只对特殊协议的主机名做小写归一；deck-plugin 是非特殊协议，主机名原样保留。
    // 这正是我们要的严格语义：id 的字符集限小写，主机名大小写不同即未登记 → 拒绝，不做猜测映射。
    const { list, pluginDir } = roots()
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://CLOCK/card.js`, list)).toBeNull()
    expect(resolveAssetUrl(`${PLUGIN_SCHEME}://clock/card.js`, list)?.file)
      .toBe(path.join(pluginDir, 'card.js'))
  })
})

describe('MIME 判定（ESM 必须是 text/javascript）', () => {
  it.each([
    ['a.js', 'text/javascript'],
    ['a.mjs', 'text/javascript'],
    ['a.css', 'text/css'],
    ['a.json', 'application/json'],
    ['a.html', 'text/html'],
    ['a.svg', 'image/svg+xml'],
    ['a.png', 'image/png'],
    ['a.woff2', 'font/woff2'],
  ])('%s → %s', (file, mime) => {
    expect(mimeOf(file)).toBe(mime)
  })

  it.each(['a.txt', 'a.exe', 'a.dll', 'a.js.map', 'a', 'a.php', 'a.xhtml'])('%s → 不投递（白名单外）', (file) => {
    expect(mimeOf(file)).toBeNull()
  })

  it('扩展名大小写不敏感', () => {
    expect(mimeOf('a.JS')).toBe('text/javascript')
  })
})
