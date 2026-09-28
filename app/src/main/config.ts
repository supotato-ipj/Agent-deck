import fs from 'node:fs'
import path from 'node:path'
import type { DesktopLayout, WeatherLocation } from '../shared/contract'
import { BASE_PORT } from './search/engine'

/** 面板几何（DIP 逻辑像素）：随 config.json 分发，缺省取主显示器全屏 */
export interface PanelGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** 天气卡取数坐标（Open-Meteo）：渲染层纯前端直连，坐标随快照下发；类型即契约面的 WeatherLocation */
export type WeatherConfig = WeatherLocation

export interface AppConfig {
  panel: PanelGeometry
  weather: WeatherConfig
  desktop: DesktopLayout
  /** 搜索（工单07）：Listary 本地 API 端口（host 恒 127.0.0.1 不进配置——只发往本机） */
  search: SearchConfig
  /** 外观（工单08）：模块底色透明度全局滑杆值 */
  appearance: AppearanceConfig
  /** 工具→exe 映射（工单09）：会话行直达的进程发现与启动依据；换机/改安装位置只调此段 */
  tools: ToolsConfig
  /** 插件目录（工单10）：桌面组件的安装位；空串 = 缺省 userData/plugins */
  plugins: PluginsConfig
}

/**
 * 插件目录（config.json plugins 段）：桌面组件的安装位。
 * 缺省空串——真正的落点由主进程解析为 `userData/plugins`（userData 依赖 Electron，
 * config.ts 是纯模块不得引它，故缺省值在此只表达「用默认」）。
 */
export interface PluginsConfig {
  /** 插件根目录绝对路径；空串 = userData/plugins */
  dir: string
}

/**
 * 单工具的可执行入口（config.json tools.<tool> 段）。
 * 渲染层只发工具名、绝不发明路径（任意路径执行防线同 desktop/launch）：
 * 启动目标与进程名都收口于此，配置缺失即静默降级。
 */
export interface ToolTarget {
  /** 启动目标 exe 绝对路径（支持 `%VAR%` 环境变量展开）；空串 = 不可启动，仅可聚焦已运行实例 */
  launch: string
  /** 进程镜像名（小写 basename、不含 .exe）：窗口发现按它匹配运行中的工具实例。
   *  启动器与实际进程不同名时两者都列（如 Qoder 的 Launcher 与 Qoder CN）。 */
  processes: string[]
}

export type ToolsConfig = Record<string, ToolTarget>

/**
 * 进程镜像名归一的**唯一实现**：`basename → 小写 → 去 .exe`。
 * 既是 config.tools.processes 的入库口径，也是 focus/plan 的匹配口径——两份实现必然漂移，
 * 故只此一处（focus/plan 从此处 import，不复刻）。
 */
export function normalizeProcessName(raw: string): string {
  return raw.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '')
}

/** Listary 本地 API 端口（验收可指假端口复现引擎离线） */
export interface SearchConfig {
  port: number
}

/** 卡片底色透明度（工单08 全局滑杆）：0..1，rgba alpha 语义；0 = 全透（文字仍实色） */
export interface AppearanceConfig {
  cardOpacity: number
}

export interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

/** 默认几何 = 显示器全屏（面板铺满屏幕，与旧壁纸形态一致的生产值） */
export function defaultPanelGeometry(display: RectLike): PanelGeometry {
  return { x: display.x, y: display.y, width: display.width, height: display.height }
}

export interface LoadConfigResult {
  config: AppConfig
  warnings: string[]
  /** 首次运行时已按默认值落盘 */
  created: boolean
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function mergePanel(raw: unknown, fallback: PanelGeometry, warnings: string[]): PanelGeometry {
  const out = { ...fallback }
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('config.panel 不是对象，已整体回退默认几何')
    return out
  }
  const panel = raw as Record<string, unknown>
  for (const key of ['x', 'y'] as const) {
    const v = panel[key]
    if (v === undefined) continue
    if (isFiniteNumber(v)) out[key] = v
    else warnings.push(`config.panel.${key} 不是有限数字，已回退默认值 ${fallback[key]}`)
  }
  for (const key of ['width', 'height'] as const) {
    const v = panel[key]
    if (v === undefined) continue
    if (isFiniteNumber(v) && v > 0) out[key] = v
    else warnings.push(`config.panel.${key} 必须为正数，已回退默认值 ${fallback[key]}`)
  }
  return out
}

/** 默认天气坐标：北京（先例 patched 壁纸内固定坐标的平移；用户可在 config.json 改） */
export function defaultWeather(): WeatherConfig {
  return { latitude: 39.9042, longitude: 116.4074 }
}

/** 默认桌面承载几何：renderer/index.html 工单05 的生产值固化（DIP） */
export function defaultDesktopLayout(): DesktopLayout {
  return { docZone: { left: 408, top: 48, maxWidth: 640 }, docMaxRows: 8, dockMaxWidth: 1240 }
}

/** 默认搜索端口：Listary 7 本地 HTTP API 的生产值（BASE_PORT 单一来源） */
export function defaultSearchConfig(): SearchConfig {
  return { port: BASE_PORT }
}

/** 默认外观：信息卡底色 rgba(0,0,0,0.55) 的 alpha（renderer 生产值固化） */
export function defaultAppearance(): AppearanceConfig {
  return { cardOpacity: 0.55 }
}

/** 默认插件目录：空串 = 由主进程解析为 userData/plugins（见 PluginsConfig 注释） */
export function defaultPlugins(): PluginsConfig {
  return { dir: '' }
}

function mergePlugins(raw: unknown, fallback: PluginsConfig, warnings: string[]): PluginsConfig {
  const out = { ...fallback }
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push('config.plugins 不是对象，已整体回退默认插件目录')
    return out
  }
  const dir = (raw as Record<string, unknown>).dir
  if (dir === undefined) return out
  if (typeof dir === 'string') out.dir = dir.trim()
  else warnings.push('config.plugins.dir 不是字符串，已回退默认插件目录')
  return out
}

/**
 * 默认工具映射（工单09）：本机五工具的当前生产值。
 * 用 `%VAR%` 占位本机强相关段（LOCALAPPDATA / ProgramFiles / USERPROFILE），
 * 换机或改安装位置只改 config.json 的 tools 段，不是代码返工（spec「配置」决策）。
 * 装在 D 盘等非常规位置的工具（kimi code）按当前生产值直写，用户可自行改。
 *
 * processes 收录启动器与实际进程两种镜像名：Electron 应用常有
 * 「启动器进程 + 若干渲染/GPU 子进程」并存，只认主 exe 名会漏。
 */
export function defaultTools(): ToolsConfig {
  return {
    qoder: {
      launch: '%LOCALAPPDATA%\\Qoder CN\\Qoder CN Launcher\\Qoder CN Launcher.exe',
      processes: ['qoder cn launcher', 'qoder cn'],
    },
    kimicode: {
      launch: 'D:\\programs\\Kimi Code\\Kimi Code.exe',
      processes: ['kimi code'],
    },
    kimiwork: {
      launch: '%LOCALAPPDATA%\\Programs\\kimi-desktop\\Kimi.exe',
      processes: ['kimi'],
    },
    zcode: {
      launch: '%ProgramFiles%\\ZCode\\ZCode.exe',
      processes: ['zcode'],
    },
    hermes: {
      launch: '%LOCALAPPDATA%\\hermes\\hermes-agent\\apps\\desktop\\release\\win-unpacked\\Hermes.exe',
      processes: ['hermes'],
    },
  }
}

function mergeTools(raw: unknown, fallback: ToolsConfig, warnings: string[]): ToolsConfig {
  const out: ToolsConfig = {}
  for (const [tool, def] of Object.entries(fallback)) out[tool] = { launch: def.launch, processes: [...def.processes] }
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push('config.tools 不是对象，已整体回退默认工具映射')
    return out
  }
  for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      warnings.push(`config.tools.${tool} 不是对象，已回退该工具默认映射`)
      continue
    }
    const target = value as Record<string, unknown>
    const base = out[tool] ?? { launch: '', processes: [] as string[] }
    const launch = target.launch
    if (launch !== undefined) {
      if (typeof launch === 'string') {
        base.launch = launch
      } else {
        warnings.push(`config.tools.${tool}.launch 不是字符串，已保留默认值`)
      }
    }
    const processes = target.processes
    if (processes !== undefined) {
      if (Array.isArray(processes) && processes.every((p) => typeof p === 'string')) {
        // 归一复用唯一实现（与 focus/plan 的匹配口径同源：用户写 'ZCode.EXE' 也认）
        base.processes = [...new Set((processes as string[]).map(normalizeProcessName).filter((p) => p !== ''))]
      } else {
        warnings.push(`config.tools.${tool}.processes 不是字符串数组，已保留默认值`)
      }
    }
    out[tool] = base
  }
  return out
}

function mergeWeather(raw: unknown, fallback: WeatherConfig, warnings: string[]): WeatherConfig {
  const out = { ...fallback }
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('config.weather 不是对象，已整体回退默认坐标')
    return out
  }
  const weather = raw as Record<string, unknown>
  for (const key of ['latitude', 'longitude'] as const) {
    const v = weather[key]
    if (v === undefined) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else warnings.push(`config.weather.${key} 不是有限数字，已回退默认值 ${fallback[key]}`)
  }
  return out
}

function mergeDesktop(raw: unknown, fallback: DesktopLayout, warnings: string[]): DesktopLayout {
  const out = { docZone: { ...fallback.docZone }, docMaxRows: fallback.docMaxRows, dockMaxWidth: fallback.dockMaxWidth }
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push('config.desktop 不是对象，已整体回退默认桌面几何')
    return out
  }
  const desktop = raw as Record<string, unknown>
  const zone = desktop.docZone
  if (zone !== undefined) {
    if (typeof zone !== 'object' || zone === null) {
      warnings.push('config.desktop.docZone 不是对象，已回退默认文档区几何')
    } else {
      const z = zone as Record<string, unknown>
      for (const key of ['left', 'top'] as const) {
        const v = z[key]
        if (v === undefined) continue
        if (isFiniteNumber(v)) out.docZone[key] = v
        else warnings.push(`config.desktop.docZone.${key} 不是有限数字，已回退默认值 ${fallback.docZone[key]}`)
      }
      for (const key of ['maxWidth'] as const) {
        const v = z[key]
        if (v === undefined) continue
        if (isFiniteNumber(v) && v > 0) out.docZone[key] = v
        else warnings.push(`config.desktop.docZone.${key} 必须为正数，已回退默认值 ${fallback.docZone[key]}`)
      }
    }
  }
  const rows = desktop.docMaxRows
  if (rows !== undefined) {
    if (Number.isInteger(rows) && (rows as number) >= 1 && (rows as number) <= 32) out.docMaxRows = rows as number
    else warnings.push(`config.desktop.docMaxRows 须为 1..32 整数，已回退默认值 ${fallback.docMaxRows}`)
  }
  const dockW = desktop.dockMaxWidth
  if (dockW !== undefined) {
    if (isFiniteNumber(dockW) && dockW > 0) out.dockMaxWidth = dockW
    else warnings.push(`config.desktop.dockMaxWidth 必须为正数，已回退默认值 ${fallback.dockMaxWidth}`)
  }
  return out
}

function mergeSearch(raw: unknown, fallback: SearchConfig, warnings: string[]): SearchConfig {
  const out = { ...fallback }
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push('config.search 不是对象，已整体回退默认端口')
    return out
  }
  const search = raw as Record<string, unknown>
  const port = search.port
  if (port === undefined) return out
  if (Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535) out.port = port as number
  else warnings.push(`config.search.port 须为 1..65535 整数，已回退默认值 ${fallback.port}`)
  return out
}

function mergeAppearance(raw: unknown, fallback: AppearanceConfig, warnings: string[]): AppearanceConfig {
  const out = { ...fallback }
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warnings.push('config.appearance 不是对象，已整体回退默认透明度')
    return out
  }
  const appearance = raw as Record<string, unknown>
  const opacity = appearance.cardOpacity
  if (opacity === undefined) return out
  if (isFiniteNumber(opacity) && (opacity as number) >= 0 && (opacity as number) <= 1) out.cardOpacity = opacity
  else warnings.push(`config.appearance.cardOpacity 须为 0..1 数字，已回退默认值 ${fallback.cardOpacity}`)
  return out
}

/** 整份回写 config.json（首运行落盘与工单08 设置滑杆的持久化通道）。
 * tmp+rename 原子写（writeStoreText 先例）：config 收口屏幕几何/端口/透明度，
 * 坏写不碰原文件——半截 JSON 会让下次启动整体回退默认。 */
export function saveConfig(file: string, config: AppConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 加载 config.json：缺失时以默认值落盘（首运行即有可编辑的生产值副本）；
 * 字段级校验，非法字段回退默认并告警，不静默吞掉用户笔误；解析失败不覆写用户文件。
 */
export function loadConfig(file: string, fallback: AppConfig): LoadConfigResult {
  if (!fs.existsSync(file)) {
    saveConfig(file, fallback)
    return { config: fallback, warnings: [], created: true }
  }
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {
      config: fallback,
      warnings: ['config.json 不是合法 JSON，已整体回退默认几何（原文件未改动）'],
      created: false,
    }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { config: fallback, warnings: ['config.json 顶层不是对象，已整体回退默认几何'], created: false }
  }
  const root = raw as Record<string, unknown>
  return {
    config: {
      panel: mergePanel(root.panel, fallback.panel, warnings),
      weather: mergeWeather(root.weather, fallback.weather, warnings),
      desktop: mergeDesktop(root.desktop, fallback.desktop, warnings),
      search: mergeSearch(root.search, fallback.search, warnings),
      appearance: mergeAppearance(root.appearance, fallback.appearance, warnings),
      tools: mergeTools(root.tools, fallback.tools, warnings),
      plugins: mergePlugins(root.plugins, fallback.plugins, warnings),
    },
    warnings,
    created: false,
  }
}
