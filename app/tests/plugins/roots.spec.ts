import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { Context } from 'cordis'
import { productionPluginRoots } from '../../src/main/plugins/roots'
import { PluginHostService } from '../../src/main/plugins/service'

describe('生产插件包根', () => {
  it('用户根为空时也扫描到第一方组卡', async () => {
    const appRoot = path.resolve(__dirname, '../..')
    const ctx = new Context()
    ctx.plugin(PluginHostService, {
      roots: productionPluginRoots({
        appRoot,
        rendererRoot: path.join(appRoot, 'src/renderer'),
        userRoot: path.join(appRoot, 'test-empty-user-plugins'),
      }),
      watch: false,
    })
    await ctx.start()
    try {
      expect(ctx.plugins.info().find((plugin) => plugin.id === 'doc-group-cards'))
        .toMatchObject({ status: 'ok', capabilities: ['desktop'] })
    } finally {
      await ctx.stop()
    }
  })
})
