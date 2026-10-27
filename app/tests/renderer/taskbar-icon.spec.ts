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

describe('推荐组图标降级（工单302）', () => {
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
})
