import path from 'node:path'
import type { PluginRootDescriptor } from './service'

/**
 * 生产插件包根（工单331 档位化，ADR-0019/0025）：信任档由包根决定，不由 manifest 自报。
 * 内置卡根与第一方包根 = kernel（受信内部桥，既有渲染层装载路径）；用户插件根 = dropped
 * （投放档，独立执行上下文路径）。
 */
export function productionPluginRoots(paths: { appRoot: string; rendererRoot: string; userRoot: string }): PluginRootDescriptor[] {
  return [
    { dir: path.join(paths.rendererRoot, 'cards'), tier: 'kernel' },
    { dir: path.join(paths.appRoot, 'plugins'), tier: 'kernel' },
    { dir: paths.userRoot, tier: 'dropped' },
  ]
}
