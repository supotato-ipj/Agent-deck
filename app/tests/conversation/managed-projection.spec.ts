// 管理型只读投影测试（工单333，ADR-0009 单点分派 / ADR-0025 契约目录 / 票面 AC3-AC4）：
// 四工具封闭集（快照/插件清单/用户根源码/契约目录），全部只读；投影外方法一律
// unknown_tool（不静默放行、不返回空成功）；plugin_source 路径包含校验与体积上限。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MANAGED_TOOLS,
  createNodeProjectionSource,
  dispatchManagedTool,
} from '../../src/main/conversation/managed-projection'
import { PLUGIN_CONTRACT_CATALOG, projectCatalog } from '../../src/main/plugins/catalog'

function makeUserRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-proj-'))
  fs.mkdirSync(path.join(root, 'my-clock'), { recursive: true })
  fs.writeFileSync(path.join(root, 'my-clock', 'manifest.json'), JSON.stringify({ id: 'my-clock', name: 'My Clock' }), 'utf8')
  fs.writeFileSync(path.join(root, 'my-clock', 'index.js'), '// plugin source\nexport default {}', 'utf8')
  fs.mkdirSync(path.join(root, 'my-clock', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'my-clock', 'lib', 'util.js'), 'export const one = 1', 'utf8')
  return root
}

function makeSource(userRoot: string) {
  return createNodeProjectionSource({
    userRoot,
    panelSnapshot: () => ({ clock: { text: '12:00' }, plugins: [{ id: 'clock' }] }),
    pluginsList: () => ({ kernel: [{ id: 'clock', name: 'Clock' }], dropped: [{ id: 'my-clock', name: 'My Clock', status: 'active' }] }),
  })
}

describe('管理型只读投影（工单333）', () => {
  it('工具封闭集：恰四个只读工具 + 恰一个确定性安装写工具（工单334）；写面有且仅有 submit', () => {
    // 工单334 演化：封闭集 4→5——plugin_install_submit 是 MCP 侧唯一写操作（确定性管理操作，
    // ADR-0019）；只读四工具描述仍不得含写类动作，其余投影外工具一律 unknown_tool（下方用例）
    expect(MANAGED_TOOLS.map((t) => t.name).sort()).toEqual(
      ['panel_snapshot', 'plugin_contract_catalog', 'plugin_install_submit', 'plugin_source', 'plugins_list'].sort(),
    )
    for (const t of MANAGED_TOOLS) {
      if (t.name === 'plugin_install_submit') continue
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.inputSchema).toBeTruthy()
      expect(JSON.stringify(t)).not.toMatch(/set|write|install|uninstall|enable|disable|quit|launch/i)
    }
    expect(MANAGED_TOOLS.filter((t) => t.name === 'plugin_install_submit')).toHaveLength(1)
  })

  it('panel_snapshot：经注入的单点快照源原样返回（JSON 可序列化）', async () => {
    const source = makeSource(makeUserRoot())
    const out = await dispatchManagedTool('panel_snapshot', {}, source)
    expect(out.ok).toBe(true)
    if (out.ok) expect((out.payload as { clock: { text: string } }).clock.text).toBe('12:00')
  })

  it('plugins_list：内核清单与投放清单两路都在（#331 双档位）', async () => {
    const source = makeSource(makeUserRoot())
    const out = await dispatchManagedTool('plugins_list', {}, source)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const list = out.payload as { kernel: unknown[]; dropped: unknown[] }
      expect(list.kernel).toHaveLength(1)
      expect(list.dropped).toHaveLength(1)
    }
  })

  it('plugin_contract_catalog：projectCatalog agent 受众全段投影（与 catalog 单一正典同源）', async () => {
    const source = makeSource(makeUserRoot())
    const out = await dispatchManagedTool('plugin_contract_catalog', {}, source)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.payload).toEqual(projectCatalog(PLUGIN_CONTRACT_CATALOG, 'agent'))
      const data = (out.payload as { data: Record<string, unknown> }).data
      expect(Object.keys(data).sort()).toEqual(['baselineHostApi', 'errors', 'identity', 'manifest', 'permissions', 'resourceLimits'].sort())
    }
  })

  it('plugin_source：目录列出 + 文件读取；内容真实可读', async () => {
    const root = makeUserRoot()
    const source = makeSource(root)
    const listing = await dispatchManagedTool('plugin_source', { pluginId: 'my-clock' }, source)
    expect(listing.ok).toBe(true)
    if (listing.ok) {
      const entries = (listing.payload as { entries: { name: string; type: string }[] }).entries
      expect(entries.map((e) => e.name).sort()).toEqual(['index.js', 'lib', 'manifest.json'].sort())
    }
    const file = await dispatchManagedTool('plugin_source', { pluginId: 'my-clock', path: 'index.js' }, source)
    expect(file.ok).toBe(true)
    if (file.ok) {
      expect((file.payload as { content: string }).content).toContain('export default {}')
    }
    const nested = await dispatchManagedTool('plugin_source', { pluginId: 'my-clock', path: 'lib/util.js' }, source)
    expect(nested.ok).toBe(true)
    if (nested.ok) expect((nested.payload as { content: string }).content).toBe('export const one = 1')
  })

  it('plugin_source：路径逃逸一律拒绝（绝对路径/.. 上跳/越出插件目录），不读用户根外任何文件', async () => {
    const root = makeUserRoot()
    fs.writeFileSync(path.join(root, 'secret.txt'), 'root secret', 'utf8')
    const source = makeSource(root)
    for (const bad of [
      { pluginId: 'my-clock', path: '../secret.txt' },
      { pluginId: 'my-clock', path: 'a/../../secret.txt' },
      { pluginId: 'my-clock', path: path.join(root, 'secret.txt') },
      { pluginId: 'my-clock', path: 'C:\\Windows\\win.ini' },
      { pluginId: '..', path: 'secret.txt' },
      { pluginId: 'my-clock/../../', path: 'secret.txt' },
    ]) {
      const out = await dispatchManagedTool('plugin_source', bad, source)
      expect(out.ok, JSON.stringify(bad)).toBe(false)
      if (!out.ok) expect(out.reason).toBe('source_error')
    }
  })

  it('plugin_source：不存在的插件/文件 → source_error 明确报错（不返回空成功）', async () => {
    const source = makeSource(makeUserRoot())
    const noPlugin = await dispatchManagedTool('plugin_source', { pluginId: 'ghost' }, source)
    expect(noPlugin.ok).toBe(false)
    if (!noPlugin.ok) expect(noPlugin.reason).toBe('source_error')
    const noFile = await dispatchManagedTool('plugin_source', { pluginId: 'my-clock', path: 'ghost.js' }, source)
    expect(noFile.ok).toBe(false)
    if (!noFile.ok) expect(noFile.reason).toBe('source_error')
  })

  it('plugin_source：超上限文件拒绝读取（PACKAGE_RESOURCE_LIMITS.maxFileBytes 口径）', async () => {
    const root = makeUserRoot()
    fs.writeFileSync(path.join(root, 'my-clock', 'big.js'), 'x'.repeat(2 * 1024 * 1024 + 1), 'utf8')
    const source = makeSource(root)
    const out = await dispatchManagedTool('plugin_source', { pluginId: 'my-clock', path: 'big.js' }, source)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toMatch(/上限|limit/i)
  })

  it('投影外方法一律 unknown_tool：写类名、目录外 JSON-RPC 名都不静默放行', async () => {
    const source = makeSource(makeUserRoot())
    for (const name of [
      'settings_set_card_enabled',
      'app_quit',
      'plugins_install',
      'plugins_uninstall',
      'taskbar_set_enabled',
      'desktop_move',
      'plugin_config_set',
      'now',
      'panel_write',
      '',
      'panel/snapshot',
    ]) {
      const out = await dispatchManagedTool(name, {}, source)
      expect(out.ok, name).toBe(false)
      if (!out.ok) {
        expect(out.reason).toBe('unknown_tool')
        expect(out.message).toMatch(/未知工具/)
      }
    }
  })

  it('入参形状错 → invalid_args（不静默当空参成功）', async () => {
    const source = makeSource(makeUserRoot())
    const out = await dispatchManagedTool('plugin_source', { path: 'index.js' }, source)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('invalid_args')
    const out2 = await dispatchManagedTool('plugin_source', { pluginId: 42 }, source)
    expect(out2.ok).toBe(false)
    if (!out2.ok) expect(out2.reason).toBe('invalid_args')
  })
})
