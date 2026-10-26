import path from 'node:path'

export function productionPluginRoots(paths: { appRoot: string; rendererRoot: string; userRoot: string }): string[] {
  return [
    path.join(paths.rendererRoot, 'cards'),
    path.join(paths.appRoot, 'plugins'),
    paths.userRoot,
  ]
}
