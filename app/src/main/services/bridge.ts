import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { AgentTilingState, BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, DesktopLayout, DesktopZone, PanelSnapshot, SessionPreviewState, SettingsState, TaskbarButtonId, TaskbarDragDrop, TaskbarMetric, TaskbarSystemAction, TaskbarTrayButton, TaskbarTrayOverflowLimit, WeatherLocation, WindowPreviewState } from '../../shared/contract'
import { defaultDesktopLayout, defaultWeather } from '../config'
import type { SearchService } from './search'
import type { SettingsService } from './settings'

/** 桥接层错误（未知方法等契约违规） */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * 内核对渲染层的唯一桥接（spec「内核契约」缝）：invoke 请求/响应 + 事件订阅推送。
 * 数据段（时钟/会话/硬件/桌面）与桌面承载动作经 panelData 端口取——
 * 进程内内核直连采集服务，生产装配转发数据面子进程。后续工单只扩展
 * BridgeMethods / BridgeEvents 映射与本服务的 dispatch，不另开通道。
 */
export class BridgeService extends Service {
  // 桌面工作区（工单375）可选注入：未装配时投影回退禁用态，桥接层不得静默不装载
  static inject: Inject = {
    clock: { required: true }, panelData: { required: true }, search: { required: true },
    settings: { required: true }, focus: { required: true }, plugins: { required: true },
    taskbar: { required: true }, pluginConfig: { required: true }, conversation: { required: true },
    desktopWorkspace: { required: false },
    agentFocus: { required: false },
    windowPreview: { required: false },
    // 会话预览（工单381）可选注入：缺装配 = 投影如实回退空态（气泡页显空态，不编造会话）
    sessionPreview: { required: false },
  }

  private readonly weather: WeatherLocation
  private readonly layout: DesktopLayout
  private readonly quitApp: () => void

  private readonly memoryProbe: (() => { totalWorkingSetMB: number; processes: Array<{ pid: number; type: string; workingSetMB: number }> }) | null

  constructor(ctx: Context, options: { weather?: WeatherLocation; layout?: DesktopLayout; quit?: () => void; memoryProbe?: () => { totalWorkingSetMB: number; processes: Array<{ pid: number; type: string; workingSetMB: number }> } } = {}) {
    super(ctx, 'bridge')
    this.weather = options.weather ?? defaultWeather()
    this.layout = options.layout ?? defaultDesktopLayout()
    // 资源预算读数（工单341）：内存探针由生产装配注入（Electron app.getAppMetrics）；
    // 离线装配缺省 = 如实不可用（零读数，不编造）
    this.memoryProbe = options.memoryProbe ?? null
    // quit 依赖（工单83）：主进程 app.quit 由生产装配注入；离线装配未注入时如实拒绝
    this.quitApp = options.quit ?? (() => { throw new BridgeError('app/quit 未装配 quit 依赖（生产装配缺注入）') })
    // 数据面快照到达即推送（生产装配：utilityProcess 每拍一发；进程内装配无此事件，
    // 契约测试经 tick 手动驱动）
    ctx.on('dataplane/snapshot', () => this.push())
  }

  snapshot(): PanelSnapshot {
    return {
      clock: this.ctx.panelData.clock(),
      sessions: this.ctx.panelData.sessions(),
      hardware: this.ctx.panelData.hardware(),
      weather: this.weather,
      desktop: this.ctx.panelData.desktop(),
      layout: this.layout,
      settings: this.ctx.settings.state(),
      plugins: this.ctx.plugins.info(),
      // 投放包清单投影（工单343）：渲染层摆位账本据此为在场包算视图矩形并下行
      dropped: this.ctx.plugins.droppedInfo(),
    }
  }

  async invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']> {
    switch (method) {
      case 'panel/snapshot':
        return this.snapshot() as BridgeMethods[M]['response']
      case 'desktop/icon': {
        const { key } = payload as { key: string }
        return { dataUrl: await this.ctx.panelData.icon(key) } as BridgeMethods[M]['response']
      }
      case 'desktop/launch': {
        const { path } = payload as { path: string }
        return await this.ctx.panelData.launch(path) as BridgeMethods[M]['response']
      }
      case 'desktop/reveal': {
        const { path } = payload as { path: string }
        return await this.ctx.panelData.reveal(String(path)) as BridgeMethods[M]['response']
      }
      case 'desktop/copy-path': {
        const { path } = payload as { path: string }
        return await this.ctx.panelData.copyPath(String(path)) as BridgeMethods[M]['response']
      }
      case 'desktop/copy-paths': {
        const { paths } = payload as { paths: string[] }
        return await this.ctx.panelData.copyPaths((Array.isArray(paths) ? paths : []).map(String)) as BridgeMethods[M]['response']
      }
      case 'desktop/clipboard-copy': {
        const { paths } = payload as { paths: string[] }
        return await this.ctx.panelData.clipboardCopy((Array.isArray(paths) ? paths : []).map(String)) as BridgeMethods[M]['response']
      }
      case 'desktop/clipboard-cut': {
        const { paths } = payload as { paths: string[] }
        return await this.ctx.panelData.clipboardCut((Array.isArray(paths) ? paths : []).map(String)) as BridgeMethods[M]['response']
      }
      case 'desktop/trash': {
        const { paths } = payload as { paths: string[] }
        return await this.ctx.panelData.trash((Array.isArray(paths) ? paths : []).map(String)) as BridgeMethods[M]['response']
      }
      case 'desktop/rename': {
        const { name, to } = payload as { name: string; to: string }
        return await this.ctx.panelData.rename(String(name), String(to ?? '')) as BridgeMethods[M]['response']
      }
      case 'desktop/paste':
        return await this.ctx.panelData.paste() as BridgeMethods[M]['response']
      case 'desktop/clipboard-state':
        return await this.ctx.panelData.clipboardState() as BridgeMethods[M]['response']
      case 'desktop/move': {
        const { name, zone, beforeName } = payload as { name: string; zone: DesktopZone; beforeName: string | null }
        return await this.ctx.panelData.move(name, zone, beforeName) as BridgeMethods[M]['response']
      }
      case 'desktop/move-batch': {
        const { names, zone, beforeName } = payload as { names: string[]; zone: DesktopZone; beforeName: string | null }
        return await this.ctx.panelData.moveBatch(names, zone, beforeName) as BridgeMethods[M]['response']
      }
      case 'desktop/reset-layout':
        return await this.ctx.panelData.resetLayout() as BridgeMethods[M]['response']
      case 'desktop/set-card-slot': {
        const { id, col, row } = payload as { id: string; col: number; row: number }
        return await this.ctx.panelData.setCardSlot(String(id ?? ''), Number(col), Number(row)) as BridgeMethods[M]['response']
      }
      // 投放包视图摆位下行（工单343）：渲染层账本算好的包矩形表，形状护栏/执行都在
      // plugins→package-host（declared/live 双表 + 热区命中集同步）
      case 'desktop/set-package-bounds': {
        const { packages } = (payload ?? {}) as { packages?: unknown }
        return { ok: this.ctx.plugins.setDroppedPackageBounds(packages) } as BridgeMethods[M]['response']
      }
      case 'search/activate':
        return { state: this.ctx.search.activate() } as BridgeMethods[M]['response']
      case 'search/query': {
        const { query } = payload as { query: string }
        return { accepted: this.ctx.search.setQuery(String(query ?? '')) } as BridgeMethods[M]['response']
      }
      case 'search/deactivate':
        return { state: this.ctx.search.deactivate() } as BridgeMethods[M]['response']
      case 'search/action': {
        const { path, reveal } = payload as { path: string; reveal: boolean }
        return await this.ctx.search.action(String(path), Boolean(reveal)) as BridgeMethods[M]['response']
      }
      case 'settings/set-card-opacity': {
        const { opacity } = payload as { opacity: number }
        return this.ctx.settings.setCardOpacity(opacity) as BridgeMethods[M]['response']
      }
      case 'settings/set-card-enabled': {
        const { id, enabled } = payload as { id: string; enabled: boolean }
        return this.ctx.settings.setCardEnabled(id, enabled) as BridgeMethods[M]['response']
      }
      case 'session/focus': {
        const { tool } = payload as { tool: string }
        return await this.ctx.focus.focusTool(String(tool ?? '')) as BridgeMethods[M]['response']
      }
      case 'taskbar/get-state':
        // 推荐位即时刷新（工单54）：渲染层 boot/重连拉态即最新名单（1Hz 快照驱动之外的对齐点）
        this.ctx.taskbar.refreshRecommendations()
        return this.ctx.taskbar.state() as BridgeMethods[M]['response']
      case 'taskbar/set-enabled': {
        const { enabled } = payload as { enabled: boolean }
        return this.ctx.taskbar.setEnabled(enabled) as BridgeMethods[M]['response']
      }
      case 'taskbar/system-action': {
        const { action } = payload as { action: TaskbarSystemAction }
        return this.ctx.taskbar.systemAction(action) as BridgeMethods[M]['response']
      }
      case 'taskbar/set-button-hidden': {
        const { id, hidden } = payload as { id: TaskbarButtonId; hidden: boolean }
        return this.ctx.taskbar.setButtonHidden(id, hidden) as BridgeMethods[M]['response']
      }
      case 'taskbar/drag-drop': {
        const drop = payload as TaskbarDragDrop
        return this.ctx.taskbar.dragDrop(drop) as BridgeMethods[M]['response']
      }
      case 'taskbar/app-click': {
        const { exe } = payload as { exe: string }
        return await this.ctx.taskbar.appClick(String(exe ?? '')) as BridgeMethods[M]['response']
      }
      case 'taskbar/activate-window': {
        const { hwnd } = payload as { hwnd: number }
        return this.ctx.taskbar.activateWindowByHwnd(Number(hwnd)) as BridgeMethods[M]['response']
      }
      case 'taskbar/app-windows': {
        const { exe } = payload as { exe: string }
        return this.ctx.taskbar.appWindows(String(exe ?? '')) as BridgeMethods[M]['response']
      }
      case 'taskbar/app-new-instance': {
        const { exe } = payload as { exe: string }
        return await this.ctx.taskbar.appNewInstance(String(exe ?? '')) as BridgeMethods[M]['response']
      }
      case 'taskbar/set-app-pinned': {
        const { exe, pinned } = payload as { exe: string; pinned: boolean }
        return this.ctx.taskbar.setAppPinned(String(exe ?? ''), pinned) as BridgeMethods[M]['response']
      }
      case 'taskbar/close-window': {
        const { exe } = payload as { exe: string }
        return this.ctx.taskbar.closeWindowFor(String(exe ?? '')) as BridgeMethods[M]['response']
      }
      case 'taskbar/reveal-app': {
        const { exe } = payload as { exe: string }
        return this.ctx.taskbar.revealApp(String(exe ?? '')) as BridgeMethods[M]['response']
      }
      case 'taskbar/activate-app': {
        const { exe } = payload as { exe: string }
        return await this.ctx.taskbar.activateApp(exe) as BridgeMethods[M]['response']
      }
      case 'taskbar/rec-click': {
        const { exe } = payload as { exe: string }
        return await this.ctx.taskbar.recClick(exe) as BridgeMethods[M]['response']
      }
      case 'taskbar/rec-pin': {
        const { exe } = payload as { exe: string }
        return this.ctx.taskbar.recPin(exe) as BridgeMethods[M]['response']
      }
      case 'taskbar/rec-remove': {
        const { exe } = payload as { exe: string }
        return this.ctx.taskbar.recRemove(exe) as BridgeMethods[M]['response']
      }
      case 'taskbar/rec-restore': {
        const { exe } = payload as { exe: string }
        return this.ctx.taskbar.recRestore(exe) as BridgeMethods[M]['response']
      }
      case 'taskbar/rec-reveal': {
        const { exe } = payload as { exe: string }
        return this.ctx.taskbar.recReveal(exe) as BridgeMethods[M]['response']
      }
      case 'taskbar/set-metrics': {
        const { metrics } = payload as { metrics: TaskbarMetric[] }
        return this.ctx.taskbar.setMetrics(metrics) as BridgeMethods[M]['response']
      }
      case 'taskbar/tray-click': {
        const { key, button } = payload as { key: string; button: TaskbarTrayButton }
        return this.ctx.taskbar.trayClick(String(key ?? ''), button) as BridgeMethods[M]['response']
      }
      case 'taskbar/set-tray-overflow-limit': {
        const { limit } = payload as { limit: TaskbarTrayOverflowLimit }
        return this.ctx.taskbar.setTrayOverflowLimit(limit) as BridgeMethods[M]['response']
      }
      case 'taskbar/set-tray-pinned': {
        const { id, name, pinned } = payload as { id: string; name: string; pinned: boolean }
        return this.ctx.taskbar.setTrayPinned(id, name, pinned) as BridgeMethods[M]['response']
      }
      case 'taskbar/set-maximize-retract': {
        const { enabled } = payload as { enabled: boolean }
        return this.ctx.taskbar.setMaximizeRetract(enabled) as BridgeMethods[M]['response']
      }
      case 'taskbar/tray-icon': {
        const { key } = payload as { key: string }
        return { icon: this.ctx.taskbar.trayIconOf(String(key ?? '')) } as BridgeMethods[M]['response']
      }
      // --- 桌面工作区（工单375）：共享状态投影与模式切换（spec #369 决策 2/4） ---
      case 'workspace/get-state': {
        const svc = this.ctx.desktopWorkspace
        return (svc ? svc.state() : {
          available: false, paired: false, current: 'unmanaged', switching: false, target: null, lastError: null,
        }) as BridgeMethods[M]['response']
      }
      case 'workspace/switch-to': {
        const { mode } = payload as { mode: 'normal' | 'agent' }
        if (mode !== 'normal' && mode !== 'agent') {
          throw new BridgeError(`workspace/switch-to.mode 须为 normal|agent，收到 ${String(mode)}`)
        }
        const svc = this.ctx.desktopWorkspace
        if (!svc) {
          const state = { available: false, paired: false, current: 'unmanaged' as const, switching: false, target: null, lastError: null }
          return { ok: false, state, error: '桌面工作区未装配' } as BridgeMethods[M]['response']
        }
        return await svc.switchTo(mode) as BridgeMethods[M]['response']
      }
      // --- 标题栏拖入（工单407，spec #403 决策「新增一个内部工作区拖入命令」）：请求
      // 只带源窗口句柄，主进程重核资格/源桌面/配对并迁移回读确认；缺装配按不可用拒绝。
      case 'workspace/drag-in': {
        const { hwnd } = payload as { hwnd: number }
        const h = Number(hwnd)
        if (!Number.isFinite(h) || h <= 0) {
          throw new BridgeError(`workspace/drag-in.hwnd 须为正数窗口句柄，收到 ${String(hwnd)}`)
        }
        const svc = this.ctx.agentDragIn
        if (!svc) return { ok: false, reason: 'unavailable' } as BridgeMethods[M]['response']
        return await svc.dragIn(h, 'command') as BridgeMethods[M]['response']
      }
      // --- Agent 平铺（工单376）：只读投影（缺装配回退空态——决策 26 控制面口径） ---
      case 'tiling/get-state': {
        const svc = this.ctx.agentTiling
        return (svc ? svc.state() : {
          available: false, current: 'unmanaged', count: 0, placed: 0, overflow: 0, anomalies: 0,
          anomalyDetail: { fixedSize: 0, denied: 0, refused: 0 }, floating: 0, prompting: 0, authorized: 0,
        }) as BridgeMethods[M]['response']
      }
      // --- 逐窗几何授权（工单378，决策 10/26）：只认可信内核 UI（授权提示窗）的用户手势。
      // 非 prompt 阶段 ok:false（不越级授权）；确认本身不写几何（决策 9）。
      case 'tiling/authorize': {
        const { hwnd, decision } = payload as { hwnd: number; decision: 'confirm' | 'cancel' }
        if (decision !== 'confirm' && decision !== 'cancel') {
          throw new BridgeError(`tiling/authorize.decision 须为 confirm|cancel，收到 ${String(decision)}`)
        }
        const svc = this.ctx.agentTiling
        if (!svc) {
          return { ok: false, state: {
            available: false, current: 'unmanaged' as const, count: 0, placed: 0, overflow: 0, anomalies: 0,
            anomalyDetail: { fixedSize: 0, denied: 0, refused: 0 }, floating: 0, prompting: 0, authorized: 0,
          } } as BridgeMethods[M]['response']
        }
        return (decision === 'confirm' ? svc.confirmHwnd(Number(hwnd)) : svc.cancelHwnd(Number(hwnd))) as BridgeMethods[M]['response']
      }
      // --- 恢复平铺（工单378，决策 11/26）：可信内核 UI（胶囊右侧恢复按钮）用户手势。
      // 工单379：聚焦态下恢复按钮 = 先退出聚焦（还原目标几何）再恢复默认平铺。
      case 'tiling/restore': {
        const svc = this.ctx.agentTiling
        const focus = this.ctx.agentFocus
        if (focus && focus.state().focused != null) {
          const r = await focus.exit()
          return { ok: r.ok, restored: r.restored, skipped: r.skipped, state: svc ? svc.state() : emptyTilingState() } as BridgeMethods[M]['response']
        }
        if (!svc) {
          return { ok: false, restored: 0, skipped: 0, state: emptyTilingState() } as BridgeMethods[M]['response']
        }
        return await svc.restoreTiling() as BridgeMethods[M]['response']
      }
      // --- 窗口预览与 Agent 聚焦（工单379，spec 决策 15/16）：胶囊主体/预览窗用户手势 ---
      case 'preview/get-state': {
        const svc = this.ctx.windowPreview
        return (svc ? svc.state() : emptyPreviewState()) as BridgeMethods[M]['response']
      }
      case 'preview/toggle': {
        const focus = this.ctx.agentFocus
        // 聚焦态再点胶囊 = 退出聚焦并恢复默认平铺（GLOSSARY「Agent 聚焦」）
        if (focus && focus.state().focused != null) {
          await focus.exit()
          return { ok: true, open: false } as BridgeMethods[M]['response']
        }
        const svc = this.ctx.windowPreview
        return (svc ? svc.toggle() : { ok: false, open: false }) as BridgeMethods[M]['response']
      }
      case 'preview/close': {
        const svc = this.ctx.windowPreview
        svc?.close('user')
        return { ok: Boolean(svc) } as BridgeMethods[M]['response']
      }
      case 'preview/select': {
        const { hwnd } = payload as { hwnd: number }
        const svc = this.ctx.windowPreview
        if (!svc) return { ok: false, focused: null } as BridgeMethods[M]['response']
        return svc.select(Number(hwnd)) as BridgeMethods[M]['response']
      }
      case 'preview/diag': {
        const svc = this.ctx.windowPreview
        return (svc ? svc.diag() : { open: false, live: 0, cached: 0 }) as BridgeMethods[M]['response']
      }
      case 'focus/get-state': {
        const svc = this.ctx.agentFocus
        return (svc ? svc.state() : { focused: null }) as BridgeMethods[M]['response']
      }
      case 'focus/exit': {
        const svc = this.ctx.agentFocus
        if (!svc) return { ok: false, restored: 0, skipped: 0, state: { focused: null } } as BridgeMethods[M]['response']
        const r = await svc.exit()
        return { ok: r.ok, restored: r.restored, skipped: r.skipped, state: r.state } as BridgeMethods[M]['response']
      }
      // --- Agent 会话预览（工单381，spec 决策 20-24）：只读投影 + 收起（无会话直达方法） ---
      case 'session-preview/get-state': {
        const svc = this.ctx.sessionPreview
        return (svc ? svc.state() : emptySessionPreviewState()) as BridgeMethods[M]['response']
      }
      case 'session-preview/close': {
        const svc = this.ctx.sessionPreview
        return { ok: Boolean(svc && svc.close('bridge')) } as BridgeMethods[M]['response']
      }
      case 'plugin-config/get': {
        const { id } = payload as { id: string }
        return this.ctx.pluginConfig.get(id) as BridgeMethods[M]['response']
      }
      case 'plugin-config/set': {
        const { id, patch } = payload as { id: string; patch: Record<string, unknown> }
        return this.ctx.pluginConfig.set(id, patch) as BridgeMethods[M]['response']
      }
      case 'app/quit':
        this.quitApp()
        return { ok: true } as BridgeMethods[M]['response']
      // --- 对话窗（工单332）：聊天型会话全链 ---
      case 'conversation/backend':
        return this.ctx.conversation.backendInfo() as BridgeMethods[M]['response']
      case 'conversation/show': {
        const { sessionId } = (payload ?? {}) as { sessionId?: string }
        return this.ctx.conversation.showSession(sessionId ?? undefined) as BridgeMethods[M]['response']
      }
      case 'conversation/create': {
        const { label, managed } = (payload ?? {}) as { label?: string; managed?: boolean }
        return await this.ctx.conversation.create(label ?? undefined, { managed: Boolean(managed) }) as BridgeMethods[M]['response']
      }
      case 'conversation/list':
        return { sessions: this.ctx.conversation.sessions() } as BridgeMethods[M]['response']
      case 'conversation/prompt': {
        const { sessionId, text } = payload as { sessionId: string; text: string }
        return await this.ctx.conversation.prompt(String(sessionId ?? ''), String(text ?? '')) as BridgeMethods[M]['response']
      }
      case 'conversation/cancel': {
        const { sessionId } = payload as { sessionId: string }
        return await this.ctx.conversation.cancel(String(sessionId ?? '')) as BridgeMethods[M]['response']
      }
      case 'conversation/permission': {
        const { sessionId, optionId } = payload as { sessionId: string; optionId: string }
        return await this.ctx.conversation.respondPermission(String(sessionId ?? ''), String(optionId ?? '')) as BridgeMethods[M]['response']
      }
      case 'conversation/end': {
        const { sessionId } = payload as { sessionId: string }
        return await this.ctx.conversation.end(String(sessionId ?? '')) as BridgeMethods[M]['response']
      }
      case 'conversation/resume': {
        const { sessionId } = payload as { sessionId: string }
        return await this.ctx.conversation.resume(String(sessionId ?? '')) as BridgeMethods[M]['response']
      }
      // 工单340（ADR-0026）：显式创建全新 DSH 数据目录手势（设置面入口；旧目录零触碰）
      case 'conversation/new-data-dir':
        return this.ctx.conversation.createFreshDataDir() as BridgeMethods[M]['response']
      // 工单334 安装管线（批准 UI 数据面与手势）：提案清单 / 批准 / 拒绝——真实用户手势
      // 经桥进来，落 PluginInstallManager（哈希绑定/转正/有界激活/审计都在状态机内）
      case 'install/list':
        return { proposals: this.ctx.plugins.installProposals() } as BridgeMethods[M]['response']
      case 'install/approve': {
        const { proposalId, grantPermissions } = payload as { proposalId?: unknown; grantPermissions?: unknown }
        if (typeof proposalId !== 'string' || !proposalId.trim()) {
          throw new BridgeError('install/approve 需要 proposalId（提案标识字符串）')
        }
        // 可选权限子集（工单337）：字符串数组校验后透传（非法形状 = 不授可选，仅必需集）
        const grantOpts = Array.isArray(grantPermissions) && grantPermissions.every((g) => typeof g === 'string' && g.trim())
          ? { grantPermissions: grantPermissions.map((g) => String(g)) }
          : undefined
        const mgr = this.ctx.plugins.installs
        const res = mgr
          ? await mgr.approve(String(proposalId), grantOpts)
          : { ok: false, code: 'not_found', message: '本面板未装配安装面' }
        return res as BridgeMethods[M]['response']
      }
      case 'install/reject': {
        const { proposalId } = payload as { proposalId?: unknown }
        if (typeof proposalId !== 'string' || !proposalId.trim()) {
          throw new BridgeError('install/reject 需要 proposalId（提案标识字符串）')
        }
        const mgr = this.ctx.plugins.installs
        const res = mgr
          ? await mgr.reject(String(proposalId))
          : { ok: false, code: 'not_found', message: '本面板未装配安装面' }
        return res as BridgeMethods[M]['response']
      }
      // 工单335 旧数据继承（独立用户手势，不与代码批准合并）：继承=重装包重新可读卸载
      // 残留私有配置；不继承=新配置起步（残留 detach，不永久删除）
      case 'install/inherit': {
        const { proposalId, inherit } = payload as { proposalId?: unknown; inherit?: unknown }
        if (typeof proposalId !== 'string' || !proposalId.trim()) {
          throw new BridgeError('install/inherit 需要 proposalId（提案标识字符串）')
        }
        if (typeof inherit !== 'boolean') {
          throw new BridgeError('install/inherit 需要 inherit（布尔：true=继承旧数据 false=新配置起步）')
        }
        const mgr = this.ctx.plugins.installs
        const res = mgr
          ? await mgr.decideInheritance(String(proposalId), inherit)
          : { ok: false, code: 'not_found', message: '本面板未装配安装面' }
        return res as BridgeMethods[M]['response']
      }
      // 工单346 卸载（可信 UI 真实用户手势）：actor 恒 'user' 入审计账；与 MCP
      // plugin_uninstall 同一条卸载管线（回收站/清授权/清凭证绑定），不另开旁路
      case 'install/uninstall': {
        const { packageId } = payload as { packageId?: unknown }
        if (typeof packageId !== 'string' || !packageId.trim()) {
          throw new BridgeError('install/uninstall 需要 packageId（包 id 字符串）')
        }
        const mgr = this.ctx.plugins.installs
        const res = mgr
          ? await mgr.uninstall({ packageId: String(packageId), actor: 'user' })
          : { ok: false, code: 'not_found', message: '本面板未装配安装面' }
        return res as BridgeMethods[M]['response']
      }
      // 工单346 插件数据清理：清单（只读，两类遗留全量）+ 送回收站（只删目标类、
      // 部分失败条目保留可重试、绝不降级永久删除）
      case 'install/cleanup-list': {
        const mgr = this.ctx.plugins.installs
        const res = mgr
          ? mgr.listCleanup()
          : { ok: false, message: '本面板未装配安装面' }
        return res as BridgeMethods[M]['response']
      }
      case 'install/cleanup': {
        const { entries } = payload as { entries?: unknown }
        if (!Array.isArray(entries) || entries.length === 0) {
          throw new BridgeError('install/cleanup 需要 entries（非空 {kind,ref} 条目数组）')
        }
        const mgr = this.ctx.plugins.installs
        const res = mgr
          ? await mgr.cleanup({ entries })
          : { ok: false, code: 'not_found', message: '本面板未装配安装面' }
        return res as BridgeMethods[M]['response']
      }
      // 工单336 授权账（可信 UI 数据面与撤销手势）：清单（含已撤销行）/撤销即停/
      // 媒体审计聚合投影（完整记录仅在审计文件，聚合不含媒体元数据）
      case 'install/grants': {
        const grants = this.ctx.plugins.authorizationGrants()
        const buckets = (this.ctx.media?.auditBuckets?.() ?? [])
        // 工单338：网络审计聚合投影随授权账一并下发（origin/方法/结果计数；无载荷）
        const networkBuckets = (this.ctx.network?.auditBuckets?.() ?? [])
        return { grants, buckets, networkBuckets } as BridgeMethods[M]['response']
      }
      case 'install/revoke': {
        const { packageId } = payload as { packageId?: unknown }
        if (typeof packageId !== 'string' || !packageId.trim()) {
          throw new BridgeError('install/revoke 需要 packageId（包 id 字符串）')
        }
        return this.ctx.plugins.revokeAuthorization(String(packageId)) as BridgeMethods[M]['response']
      }
      case 'media/audit': {
        const buckets = this.ctx.media?.auditBuckets?.() ?? []
        return { buckets } as BridgeMethods[M]['response']
      }
      // 工单341 资源预算读数（面板全进程工作集；C10 段 0/1/5/10 包实测用）
      case 'diag/memory': {
        return (this.memoryProbe ? this.memoryProbe() : { totalWorkingSetMB: 0, processes: [] }) as BridgeMethods[M]['response']
      }
      case 'network/audit': {
        const buckets = this.ctx.network?.auditBuckets?.() ?? []
        return { buckets } as BridgeMethods[M]['response']
      }
      // —— 工单339 命名凭证（可信 UI）：凭证库出口只有元数据；secret 单向写入 ——
      case 'credentials/list': {
        const credentials = this.ctx.credentials?.list?.() ?? []
        return { credentials } as BridgeMethods[M]['response']
      }
      case 'credentials/set': {
        const { name, secret, headerName, valuePrefix } = payload as { name?: unknown; secret?: unknown; headerName?: unknown; valuePrefix?: unknown }
        if (typeof name !== 'string' || typeof secret !== 'string') {
          throw new BridgeError('credentials/set 需要 name 与 secret（字符串）')
        }
        const svc = this.ctx.credentials
        if (!svc) return { ok: false, code: 'credential_store_unavailable', message: '凭证面未装配' } as BridgeMethods[M]['response']
        return svc.set(name, secret, {
          ...(typeof headerName === 'string' ? { headerName } : {}),
          ...(typeof valuePrefix === 'string' ? { valuePrefix } : {}),
        }) as BridgeMethods[M]['response']
      }
      case 'credentials/delete': {
        const { name } = payload as { name?: unknown }
        if (typeof name !== 'string' || !name) throw new BridgeError('credentials/delete 需要 name')
        const svc = this.ctx.credentials
        if (!svc) return { ok: false, code: 'credential_store_unavailable', message: '凭证面未装配' } as BridgeMethods[M]['response']
        return svc.remove(name) as BridgeMethods[M]['response']
      }
      case 'credentials/bind': {
        const { packageId, credentialName, origin } = payload as { packageId?: unknown; credentialName?: unknown; origin?: unknown }
        if (typeof packageId !== 'string' || typeof credentialName !== 'string' || typeof origin !== 'string') {
          throw new BridgeError('credentials/bind 需要 packageId/credentialName/origin（字符串）')
        }
        const svc = this.ctx.credentials
        if (!svc) return { ok: false, code: 'credential_store_unavailable', message: '凭证面未装配' } as BridgeMethods[M]['response']
        return svc.bind(packageId, credentialName, origin) as BridgeMethods[M]['response']
      }
      case 'credentials/unbind': {
        const { packageId, credentialName, origin } = payload as { packageId?: unknown; credentialName?: unknown; origin?: unknown }
        if (typeof packageId !== 'string' || typeof credentialName !== 'string' || typeof origin !== 'string') {
          throw new BridgeError('credentials/unbind 需要 packageId/credentialName/origin（字符串）')
        }
        const svc = this.ctx.credentials
        if (!svc) return { ok: false, code: 'credential_store_unavailable', message: '凭证面未装配' } as BridgeMethods[M]['response']
        return svc.unbind(packageId, credentialName, origin) as BridgeMethods[M]['response']
      }
      default:
        throw new BridgeError(`未知桥接方法: ${method}`)
    }
  }

  subscribe<K extends BridgeEventName>(event: K, listener: (payload: BridgeEvents[K]) => void): () => void {
    // K 为联合时 cordis 的逐事件监听签名无法解析（要求交集参数），此处按调用方契约收窄
    return this.ctx.on(event, listener as never) as unknown as () => void
  }

  /** 推送当前快照（生产由数据面快照到达驱动；契约测试手动驱动 tick） */
  tick(): void {
    this.ctx.panelData.refresh()
    this.push()
  }

  /** 推送当前快照（数据面宿主收到子进程快照后调用；与 tick 共用同一事件） */
  push(): void {
    this.ctx.emit('panel/changed', this.snapshot())
    // 工单55 任务栏右组 1Hz 数据帧：与 panel/changed 同源同拍，只裁时钟 + 硬件仪表两段
    this.ctx.emit('taskbar/status', { clock: this.ctx.panelData.clock(), hardware: this.ctx.panelData.hardware().gauges })
  }
}

/** 缺装配时的平铺空态（桥接层回退——不编造数据，与 tiling/get-state 同形） */
function emptyTilingState(): AgentTilingState {
  return {
    available: false, current: 'unmanaged', count: 0, placed: 0, overflow: 0, anomalies: 0,
    anomalyDetail: { fixedSize: 0, denied: 0, refused: 0 }, floating: 0, prompting: 0, authorized: 0,
    recovery: 'none', recoveryReason: null,
  }
}

/** 缺装配时的预览空态 */
function emptyPreviewState(): WindowPreviewState {
  return { available: false, current: 'unmanaged', open: false, items: [] }
}

/** 缺装配时的会话预览空态（不编造会话；generatedAt=0 表明从未生成投影） */
function emptySessionPreviewState(): SessionPreviewState {
  return { available: false, open: false, groups: [], generatedAt: 0 }
}
