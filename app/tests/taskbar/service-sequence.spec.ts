// 应用组统一序列的服务级接线测试（工单189）：会话运行序（仅内存）在服务层的维持与
// 过渡——refresh/recompose 连拍回存、解除手钉的原地转运行（promoteRunToFront 插回
// 首位）。纯函数规则本体在 tests/taskbar/apps-plan.spec.ts（planAppsSequence 全覆盖），
// 这里只锁「服务把 prev 序喂进去、把新序存回来」的接线面（fake 窗口源手动驱动采集轮，
// 无 Electron/FFI——taskbar-inject-warning.spec.ts 的裸内核先例）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { TaskbarService, type TaskbarServiceOptions } from '../../src/main/services/taskbar'
import type { TaskbarWindowInfo } from '../../src/main/taskbar/windows'

const P = 'C:\\apps\\P.exe'
const X = 'C:\\apps\\X.exe'
const A = 'C:\\apps\\A.exe'
const B = 'C:\\apps\\B.exe'

const winOf = (exe: string, hwnd: number): TaskbarWindowInfo => ({ exe, title: `窗${hwnd}`, hwnd, pid: hwnd })

/** 最小假 panelData：满足 TaskbarService 的必需依赖（taskbar-inject-warning.spec.ts 先例） */
class FakePanelData extends Service {
  constructor(ctx: Context) { super(ctx, 'panelData') }
  desktop() { return { items: [] } }
}

/** 裸内核单服务：窗口源可变（手动逐拍改枚举快照），栏布局存储从给定 JSON 起步 */
async function makeService(initialStore: string, windows: TaskbarWindowInfo[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t189-'))
  const ctx = new Context()
  ctx.plugin(FakePanelData)
  const opts: TaskbarServiceOptions = {
    enabled: true,
    storeFile: path.join(dir, 'taskbar-layout.json'),
    legacyLayoutFile: path.join(dir, 'layout.json'),
    deps: {
      listWindows: () => windows,
      readStoreText: () => initialStore,
      writeStoreText: () => {},
      recommendations: () => [],
      desktopItems: () => [],
      launchExe: async () => '',
      focusExeWindow: () => true,
    },
  }
  ctx.plugin(TaskbarService, opts)
  await ctx.start()
  const svc = (ctx as unknown as { taskbar: TaskbarService }).taskbar
  return { svc, cleanup: () => { void ctx.stop(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

const ids = (svc: TaskbarService) => svc.state().apps.map((e) => e.exe)

describe('TaskbarService 会话运行序接线（工单189）', () => {
  it('refresh 连拍：窗口枚举序（z 序快照）翻转，apps 位次纹丝不动', async () => {
    const windows = [winOf(A, 1), winOf(B, 2)]
    const { svc, cleanup } = await makeService('{"version":1,"pinned":[],"recommended":[],"excluded":[]}', windows)
    try {
      svc.refresh()
      expect(ids(svc)).toEqual([A, B])
      windows.reverse() // 用户切焦点：z 序翻转
      svc.refresh()
      expect(ids(svc)).toEqual([A, B])
    } finally {
      cleanup()
    }
  })

  it('新面孔追加最右：后启动应用 z 序居首也排末位；全关消失、复启回最右', async () => {
    const windows = [winOf(A, 1)]
    const { svc, cleanup } = await makeService('{"version":1,"pinned":[],"recommended":[],"excluded":[]}', windows)
    try {
      svc.refresh()
      windows.unshift(winOf(B, 2)) // B 启动且置顶
      svc.refresh()
      expect(ids(svc)).toEqual([A, B])
      windows.length = 0 // B 全关
      windows.push(winOf(A, 1))
      svc.refresh()
      expect(ids(svc)).toEqual([A])
      windows.unshift(winOf(B, 3)) // B 复启（z 序居首）
      svc.refresh()
      expect(ids(svc)).toEqual([A, B])
    } finally {
      cleanup()
    }
  })

  it('解除在运行的已钉应用原地转运行：紧随手钉段（原位次），不按新面孔跳最右', async () => {
    // z 序 A 在前：旧实现（按首见序落位）解除后 X 会按新面孔跳最右——本测据此判别新旧行为
    const windows = [winOf(A, 2), winOf(X, 1)]
    const store = JSON.stringify({ version: 1, pinned: [{ exe: P, label: 'P', iconKey: null }, { exe: X, label: 'X', iconKey: null }], recommended: [], excluded: [] })
    const { svc, cleanup } = await makeService(store, windows)
    try {
      svc.refresh()
      expect(ids(svc)).toEqual([P, X, A])
      svc.setAppPinned(X, false) // X 运行中解除手钉 → 原地转运行（位次 2 不动）
      expect(ids(svc)).toEqual([P, X, A])
      expect(svc.state().apps.map((e) => [e.pinned, e.running])).toEqual([[true, false], [false, true], [false, true]])
    } finally {
      cleanup()
    }
  })

  it('解除未运行的已钉应用：直接消失（按推荐管线回池），不残留条目', async () => {
    const windows = [winOf(A, 1)]
    const store = JSON.stringify({ version: 1, pinned: [{ exe: P, label: 'P', iconKey: null }], recommended: [], excluded: [] })
    const { svc, cleanup } = await makeService(store, windows)
    try {
      svc.refresh()
      expect(ids(svc)).toEqual([P, A])
      svc.setAppPinned(P, false)
      expect(ids(svc)).toEqual([A])
    } finally {
      cleanup()
    }
  })

  it('已手钉应用开新窗并入钉图标：不新增条目、运行态叠加', async () => {
    const windows = [winOf(X, 1)]
    const store = JSON.stringify({ version: 1, pinned: [{ exe: X, label: 'X', iconKey: null }], recommended: [], excluded: [] })
    const { svc, cleanup } = await makeService(store, windows)
    try {
      svc.refresh()
      expect(ids(svc)).toEqual([X])
      windows.push(winOf(X, 9)) // 同 exe 第二窗
      svc.refresh()
      expect(ids(svc)).toEqual([X])
      expect(svc.state().apps[0]).toMatchObject({ pinned: true, running: true })
    } finally {
      cleanup()
    }
  })
})
