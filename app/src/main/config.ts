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
    },
    warnings,
    created: false,
  }
}
