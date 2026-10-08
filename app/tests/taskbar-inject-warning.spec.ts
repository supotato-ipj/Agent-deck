// 工单132 第二阶段：TaskbarService 可选 inject 告警抑制的单测。根因链——生产装配
// （panel-kernel + DataplaneService）不在主进程注册 desktop 服务，推荐位每拍解析
// lnk 的默认兜底读 ctx.desktop，cordis 对「访问了未声明属性」逐次落带全栈的 [W] 告警
// （~1.2KB × 每拍每条目 ≈ 6KB/s 刷 stdout）；验收控制器把面板 stdout 接成不排空的
// 管道时 64KB ~11s 写满、主线程同步写永久阻塞（#107 全系停摆真机根因，工单132
// 第一阶段 minidump + 排空对照实证）。本测锁定抑制行为：desktop 缺席时推荐管线
// 跑通且零 internal/warning——回归即刷屏复发（真机形态：面板 ~15s 终末冻结）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { TaskbarService, type TaskbarServiceOptions } from '../src/main/services/taskbar'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t132-'))
}

/** 最小假 panelData：只为满足 TaskbarService 的必需依赖让其启动（desktop 仍缺席） */
class FakePanelData extends Service {
  constructor(ctx: Context) { super(ctx, 'panelData') }
  desktop() { return { items: [] } }
}

describe('TaskbarService 可选 inject（工单132：desktop 缺席不告警）', () => {
  it('desktop 服务缺席时，推荐位刷新零 internal/warning（lnk 解析走 Electron 兜底口）', async () => {
    const dir = tmpDir()
    const warnings: Error[] = []
    // 裸内核：假 panelData + TaskbarService——desktop 服务缺席，复刻生产主进程
    // 「DataplaneService 代数据、desktop 服务不在场」的 DI 形态。
    const ctx = new Context()
    // global：告警从插件作用域发出，根作用域监听器不带 global 会被作用域过滤掉
    ctx.on('internal/warning', (err) => warnings.push(err), { global: true } as never)
    ctx.plugin(FakePanelData)
    const opts: TaskbarServiceOptions = {
      storeFile: path.join(dir, 'taskbar-layout.json'),
      legacyLayoutFile: path.join(dir, 'layout.json'),
      deps: {
        // 不给 resolveShortcutTarget：强制走默认兜底（ctx.desktop 读 → Electron 兜底），
        // 这就是告警的出处。desktopItems/recommendations 喂一条 shortcut 推荐项驱动解析。
        recommendations: () => [{ name: 'Probe.lnk', display: '探针', path: 'C:\\Users\\u\\Desktop\\Probe.lnk', score: 1 }],
        desktopItems: () => [{
          name: 'Probe.lnk', path: 'C:\\Users\\u\\Desktop\\Probe.lnk',
          kind: 'shortcut' as const, display: '探针', iconKey: 'k',
        }],
        readStoreText: () => '{"version":1,"pinned":[],"recommended":[]}',
        writeStoreText: () => {},
      },
    }
    ctx.plugin(TaskbarService, opts)
    await ctx.start()
    try {
      // 快照驱动（生产形态：dataplane/snapshot → refreshRecommendations；裸内核无兄弟
      // 插件发射该事件，直呼同一入口——走的是同一 visibleRecommendations → resolveItemExe 链）
      ;(ctx as unknown as { taskbar: { refreshRecommendations(): void } }).taskbar.refreshRecommendations()
      const desktopWarns = warnings.filter((w) => w.message.includes('desktop is not registered'))
      expect(desktopWarns).toHaveLength(0)
      // 告警全量为零（不止 desktop 一项——可选声明不该引入任何新告警面）
      expect(warnings).toHaveLength(0)
    } finally {
      await ctx.stop()
    }
  })
})
