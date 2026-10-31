import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_SCHEME, resolvePackageAssetUrl, PACKAGE_SHELL_PATH } from '../../src/main/plugins/assets'

/**
 * 投放包资产寻址（工单331）：`deck-pkg://<id>/<path>` → 包根磁盘文件 + MIME 的纯解析。
 * 每包 session 各自注册协议处理器（隔离来自独立 partition + 独立 origin 双保险），
 * 本解析是处理器的寻址核心——寻址安全（穿越/NUL/反斜杠）在这里收口。
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-pkg-assets-'))
}

function rootWith(entry: Record<string, string>): string {
  const root = tmpDir()
  for (const [rel, content] of Object.entries(entry)) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

describe('投放包资产寻址（deck-pkg:// 解析，工单331）', () => {
  it('包根内文件命中：entry 与相对资产都能取', () => {
    const root = rootWith({ 'card.js': 'export default {}', 'assets/a.svg': '<svg/>' })
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/card.js`, root))
      .toEqual({ file: path.join(root, 'card.js'), mime: 'text/javascript' })
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/assets/a.svg`, root))
      .toEqual({ file: path.join(root, 'assets/a.svg'), mime: 'image/svg+xml' })
  })

  it('协议不符 / 主机与包根无冲突约束（每包 session 只见自己）→ 路径仍以包根为准', () => {
    const root = rootWith({ 'card.js': 'export default {}' })
    expect(resolvePackageAssetUrl('deck-plugin://app/index.html', root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://other-id/card.js`, root)).not.toBeNull()
  })

  it('寻址安全：穿越 / NUL / 反斜杠 / 目录 / 不存在 / 白名单外一律 null', () => {
    const root = rootWith({ 'card.js': 'export default {}', 'secret.txt': 'x', 'sub/inner.js': 'export {}' })
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/../secret.txt`, root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/%2e%2e/secret.txt`, root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/a\\b.js`, root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/secret.txt`, root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/missing.js`, root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/sub`, root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/secret.txt%00.js`, root)).toBeNull()
  })

  it('宿主壳路径返回 null（由处理器特判内联投喂，不走包根寻址）', () => {
    const root = rootWith({ 'card.js': 'export default {}' })
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/${PACKAGE_SHELL_PATH}`, root)).toBeNull()
    expect(resolvePackageAssetUrl(`${PACKAGE_SCHEME}://widget-a/${PACKAGE_SHELL_PATH}?entry=%2Fcard.js`, root)).toBeNull()
  })
})
