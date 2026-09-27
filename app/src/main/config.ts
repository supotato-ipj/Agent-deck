import fs from 'node:fs'
import path from 'node:path'

/** 面板几何（DIP 逻辑像素）：随 config.json 分发，缺省取主显示器全屏 */
export interface PanelGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface AppConfig {
  panel: PanelGeometry
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

function writeConfig(file: string, config: AppConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}

/**
 * 加载 config.json：缺失时以默认值落盘（首运行即有可编辑的生产值副本）；
 * 字段级校验，非法字段回退默认并告警，不静默吞掉用户笔误；解析失败不覆写用户文件。
 */
export function loadConfig(file: string, fallback: AppConfig): LoadConfigResult {
  if (!fs.existsSync(file)) {
    writeConfig(file, fallback)
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
    config: { panel: mergePanel(root.panel, fallback.panel, warnings) },
    warnings,
    created: false,
  }
}
