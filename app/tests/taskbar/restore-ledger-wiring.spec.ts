// 还原账全路径接线守卫（工单261，spec #258）：守卫（index.ts 默认分支，路径②）与
// guard-dead 还原守护（icon-restore-watch.cjs，路径③）是 Electron 效果层，离线不可
// 执行——接线要点以源码级守卫钉住（retract-orchestration.spec「控制器接线」同款
// 手法）：真机行为由 50-taskbar-carry A2/A3/A4 覆盖。
//
// 守卫断言的**顺序即行为**：appbar 账复原必须先于可见性复原（restoreNativeTaskbarIfHidden /
// forceShowNativeTaskbar 的 IsWindowVisible 判据会被置位态翻开 的 WS_VISIBLE 位污染
// ——spike 附记「窗口显示位」≠「视觉在场」，51 电池 P9 头注同源）；先卸置位，
// 可见性复原才做真工作并落 taskbar-restored 存证。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')

describe('还原账接线（工单261）：守卫 before-quit/panel-exit（路径②）', () => {
  const src = read('src/main/index.ts')

  it('restoreCarry 先复原 appbar 落盘账，再走图标与原生任务栏可见性兜底（顺序即行为）', () => {
    const def = src.slice(src.indexOf('const restoreCarry'))
    const iAppbar = def.indexOf('restoreAppBarStateFromLedger')
    const iCarry = def.indexOf('carry.restore')
    const iNative = def.indexOf('restoreNativeTaskbarIfHidden')
    expect(iAppbar).toBeGreaterThanOrEqual(0)
    expect(iCarry).toBeGreaterThanOrEqual(0)
    expect(iNative).toBeGreaterThanOrEqual(0)
    expect(iAppbar).toBeLessThan(iCarry)
    expect(iAppbar).toBeLessThan(iNative)
    // 账复原是异步退避（有限次有界）：守卫退场必须等它走完再 app.exit（否则定时器随进程蒸发）
    expect(def.slice(0, def.indexOf('}')).match(/await restoreAppBarStateFromLedger/)).not.toBeNull()
  })

  it('before-quit 挂 appbar 账复原（outer-quit 径）', () => {
    const at = src.indexOf("restoreCarry('outer-quit')")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(src.slice(Math.max(0, at - 200), at)).toContain('before-quit')
  })
})

describe('还原账接线（工单261）：guard-dead 还原守护（路径③）与自救通道', () => {
  const watch = read('src/main/icon-restore-watch.cjs')
  const index = read('src/main/index.ts')

  it('守护从落盘账读复原目标：require appbar-ledger，且 appbar 复原先于图标/可见性兜底', () => {
    expect(watch).toContain("require('./taskbar/appbar-ledger.js')")
    // 锚 call site（require 行也含同名标识符，不能当顺序证据）
    const iAppbar = watch.indexOf('restoreAppBarStateFromLedger(log')
    const iIcons = watch.indexOf('restoreIfHidden(null')
    const iNative = watch.indexOf('restoreNativeTaskbarIfHidden(log')
    expect(iAppbar).toBeGreaterThanOrEqual(0)
    expect(iAppbar).toBeLessThan(iIcons)
    expect(iAppbar).toBeLessThan(iNative)
    // 守护退场前等账复原走完（退避有界；无 app.exit 竞速蒸发现场）
    expect(watch).toMatch(/await restoreAppBarStateFromLedger/)
  })

  it('守护 reason=guard-dead（50 电池 A4 按 reason 分径断言）', () => {
    const iAppbar = watch.indexOf('restoreAppBarStateFromLedger(log')
    expect(iAppbar).toBeGreaterThanOrEqual(0)
    expect(watch.slice(iAppbar, iAppbar + 120)).toContain("'guard-dead'")
  })

  it('--icon-restore 自救通道同样消费落盘账（电池清场兜底与用户自救，工单50 起同通道扩展先例）', () => {
    const branch = index.slice(index.indexOf('RESTORE_MODE'))
    const iAppbar = branch.indexOf('restoreAppBarStateFromLedger')
    expect(iAppbar).toBeGreaterThanOrEqual(0)
    const iForceIcons = branch.indexOf('forceShowIcons(log')
    const iForceNative = branch.indexOf('forceShowNativeTaskbar(log')
    // appbar 复原先于 forceShowNativeTaskbar（可见性判据不被置位态污染），后于图标翻转
    expect(iAppbar).toBeGreaterThan(iForceIcons)
    expect(iAppbar).toBeLessThan(iForceNative)
  })
})
