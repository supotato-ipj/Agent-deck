import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTaskbarDomStub, type TaskbarDomStub } from './taskbar-dom-stub'
import type { TaskbarState } from '../../src/shared/contract'

const STATE: TaskbarState = {
  enabled: true,
  hiddenButtons: [],
  recommendations: [{
    name: 'Alpha.lnk',
    display: 'Alpha',
    path: 'C:\\Desktop\\Alpha.lnk',
    iconKey: 'C:\\Desktop\\Alpha.lnk|0',
    exe: 'C:\\Apps\\Alpha.exe',
  }],
  excluded: [],
  metrics: [],
  apps: [],
  tray: [],
  trayOverflowLimit: 5,
  maximizeRetract: true,
}

describe('任务栏图标降级（工单302/321）', () => {
  let stub: TaskbarDomStub | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stub?.cleanup()
    stub = null
    vi.useRealTimers()
  })

  it('desktop/icon 返回空结果时显示首字母，不留空白图片', async () => {
    stub = installTaskbarDomStub({ state: STATE })
    vi.resetModules()
    await import('../../src/renderer/taskbar')
    await stub.whenReady()
    await Promise.resolve()

    const rec = stub.element('pill-recs').querySelector('.tb-rec')
    expect(rec).not.toBeNull()
    expect(rec!.querySelector('.tb-rec-letter')?.textContent).toBe('A')
    expect(rec!.querySelector('img')).toBeNull()
  })

  it('应用组 desktop/icon 返回空结果时同样显示首字母', async () => {
    stub = installTaskbarDomStub({
      state: {
        ...STATE,
        apps: [{
          exe: 'C:\\Apps\\Beta.exe',
          label: 'Beta',
          pinned: false,
          running: true,
          title: 'Beta 窗口',
          iconKey: 'C:\\Apps\\Beta.exe|0',
        }],
      },
    })
    vi.resetModules()
    await import('../../src/renderer/taskbar')
    await stub.whenReady()
    await Promise.resolve()

    const app = stub.element('pill-apps').querySelector('.tb-app')
    expect(app).not.toBeNull()
    expect(app!.querySelector('.tb-app-letter')?.textContent).toBe('B')
    expect(app!.querySelector('img')).toBeNull()
  })
})
