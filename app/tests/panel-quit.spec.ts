// 工单431：--panel-quit 退出语义的纯逻辑单测——argv 分辨（同族旗标不误伤）、
// 退出实例分支计划（两径都即刻退、绝不拉 UI）、持锁面板侧 second-instance 分发
//（quit/唤回两径互斥）、退出请求闩（单向门、幂等）。接线面（拿锁时刻注册、确认框
// 旁路）在 index.ts / conversation/window.ts，由真机取证轮覆盖（ADR-0030）。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchSecondInstance,
  hasPanelQuitFlag,
  isPanelQuitRequested,
  PANEL_QUIT_FLAG,
  planQuitInstance,
  requestPanelQuit,
  resetPanelQuitGateForTest,
} from '../src/main/panel-quit'

describe('工单431：--panel-quit argv 分辨', () => {
  it('带 --panel-quit 命中（与 exe/应用目录参数共存）', () => {
    expect(hasPanelQuitFlag(['electron.exe', 'D:\\app', '--panel-quit'])).toBe(true)
    expect(hasPanelQuitFlag([PANEL_QUIT_FLAG])).toBe(true)
  })

  it('同族启动旗标不误伤：--panel / --panel-accept / --tray-spike / --icon-restore 均不命中', () => {
    // 关键契约：--panel-quit 绝不能被当成 --panel（否则退出实例会走面板分支）。
    expect(hasPanelQuitFlag(['electron.exe', 'D:\\app', '--panel'])).toBe(false)
    expect(hasPanelQuitFlag(['--panel-accept'])).toBe(false)
    expect(hasPanelQuitFlag(['--tray-spike'])).toBe(false)
    expect(hasPanelQuitFlag(['--icon-restore'])).toBe(false)
  })

  it('更长前缀不命中（精确串匹配，不认 --panel-quit-x）', () => {
    expect(hasPanelQuitFlag(['--panel-quit-x'])).toBe(false)
    expect(hasPanelQuitFlag([])).toBe(false)
  })
})

describe('工单431：退出实例分支计划', () => {
  it('拿锁成功 → no-panel：还锁即退、不拉守卫不拉面板', () => {
    expect(planQuitInstance(true)).toEqual({ outcome: 'no-panel' })
  })

  it('拿锁失败 → forwarded：argv 已被转发给持锁面板，本实例即刻退', () => {
    expect(planQuitInstance(false)).toEqual({ outcome: 'forwarded' })
  })
})

describe('工单431：持锁面板 second-instance 分发', () => {
  it('带 --panel-quit → 只走 quitRequest，不唤回面板', () => {
    const quitRequest = vi.fn()
    const showPanel = vi.fn()
    dispatchSecondInstance(['electron.exe', 'D:\\app', '--panel-quit'], { quitRequest, showPanel })
    expect(quitRequest).toHaveBeenCalledTimes(1)
    expect(showPanel).not.toHaveBeenCalled()
  })

  it('无旗标 → 只唤回面板（既有二次拉起口径不变）', () => {
    const quitRequest = vi.fn()
    const showPanel = vi.fn()
    dispatchSecondInstance(['electron.exe', 'D:\\app'], { quitRequest, showPanel })
    expect(showPanel).toHaveBeenCalledTimes(1)
    expect(quitRequest).not.toHaveBeenCalled()
  })
})

describe('工单431：退出请求闩（进程级单向门）', () => {
  beforeEach(() => {
    resetPanelQuitGateForTest()
  })

  it('初始未置位', () => {
    expect(isPanelQuitRequested()).toBe(false)
  })

  it('首次置位返回 true（调用方只此一次记 quit-request 事件）', () => {
    expect(requestPanelQuit()).toBe(true)
    expect(isPanelQuitRequested()).toBe(true)
  })

  it('重复转发幂等：二次置位返回 false，闩不复位', () => {
    requestPanelQuit()
    expect(requestPanelQuit()).toBe(false)
    expect(isPanelQuitRequested()).toBe(true)
  })
})
