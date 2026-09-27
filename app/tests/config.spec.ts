import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultDesktopLayout, defaultPanelGeometry, defaultSearchConfig, defaultWeather, loadConfig } from '../src/main/config'

const FALLBACK = { panel: { x: 0, y: 0, width: 1560, height: 1040 }, weather: defaultWeather(), desktop: defaultDesktopLayout(), search: defaultSearchConfig() }

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-config-')), 'config.json')
}

describe('config 模型', () => {
  it('defaultPanelGeometry 取显示器全屏', () => {
    expect(defaultPanelGeometry({ x: 0, y: 0, width: 3120, height: 2080 }))
      .toEqual({ x: 0, y: 0, width: 3120, height: 2080 })
  })

  it('文件缺失时写出默认几何并返回 created', () => {
    const file = tmpFile()
    const r = loadConfig(file, FALLBACK)
    expect(r.created).toBe(true)
    expect(r.config).toEqual(FALLBACK)
    expect(r.warnings).toHaveLength(0)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(FALLBACK)
  })

  it('合法文件整体生效', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: { x: 100, y: 50, width: 800, height: 600 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.created).toBe(false)
    expect(r.config.panel).toEqual({ x: 100, y: 50, width: 800, height: 600 })
    expect(r.warnings).toHaveLength(0)
  })

  it('部分字段缺失与默认合并', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: { x: 20 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.panel).toEqual({ x: 20, y: 0, width: 1560, height: 1040 })
  })

  it('非法字段回退默认并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: { x: 'left', width: -5 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.panel).toEqual({ x: 0, y: 0, width: 1560, height: 1040 })
    expect(r.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it('非 JSON 文件整体回退且不覆写用户文件', () => {
    const file = tmpFile()
    fs.writeFileSync(file, '{ 坏掉的')
    const r = loadConfig(file, FALLBACK)
    expect(r.config).toEqual(FALLBACK)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ 坏掉的')
  })

  it('weather 坐标缺失回退默认、非法回退并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: FALLBACK.panel, weather: { latitude: 31.2, longitude: 'east' } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.weather).toEqual({ latitude: 31.2, longitude: defaultWeather().longitude })
    expect(r.warnings.some((w) => w.includes('config.weather.longitude'))).toBe(true)
  })

  it('weather 整体非对象回退默认', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: FALLBACK.panel, weather: 42 }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.weather).toEqual(defaultWeather())
    expect(r.warnings.some((w) => w.includes('config.weather'))).toBe(true)
  })
})

describe('config 模型（工单06 桌面承载几何）', () => {
  it('defaultDesktopLayout 给文档区几何与折行数（renderer 生产值固化）', () => {
    expect(defaultDesktopLayout()).toEqual({
      docZone: { left: 408, top: 48, maxWidth: 640 },
      docMaxRows: 8,
      dockMaxWidth: 1240,
    })
  })

  it('desktop 段缺失回退默认（老 config.json 兼容）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: FALLBACK.panel }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.desktop).toEqual(defaultDesktopLayout())
    expect(r.warnings).toHaveLength(0)
  })

  it('desktop 合法值整体生效', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({
      desktop: { docZone: { left: 500, top: 60, maxWidth: 700 }, docMaxRows: 6, dockMaxWidth: 1000 },
    }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.desktop).toEqual({ docZone: { left: 500, top: 60, maxWidth: 700 }, docMaxRows: 6, dockMaxWidth: 1000 })
    expect(r.warnings).toHaveLength(0)
  })

  it('desktop 非法字段回退默认并告警（docMaxRows 越界/宽度非正/坐标非数）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({
      desktop: { docZone: { left: 'x', maxWidth: -3 }, docMaxRows: 0, dockMaxWidth: 'wide' },
    }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.desktop).toEqual(defaultDesktopLayout())
    expect(r.warnings.length).toBeGreaterThanOrEqual(4)
  })

  it('desktop 整体非对象回退默认', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ desktop: [] }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.desktop).toEqual(defaultDesktopLayout())
    expect(r.warnings.some((w) => w.includes('config.desktop'))).toBe(true)
  })
})

describe('config 模型（工单07 搜索）', () => {
  it('defaultSearchConfig 用 Listary 生产端口', () => {
    expect(defaultSearchConfig()).toEqual({ port: 38431 })
  })

  it('search 段缺失回退默认（老 config.json 兼容）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: FALLBACK.panel }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431 })
    expect(r.warnings).toHaveLength(0)
  })

  it('search.port 合法值生效（验收指假端口复现引擎离线）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { port: 39999 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 39999 })
    expect(r.warnings).toHaveLength(0)
  })

  it('search.port 非法（越界/非整数/非数）回退默认并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { port: 0 } }))
    let r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431 })
    expect(r.warnings.some((w) => w.includes('config.search.port'))).toBe(true)

    fs.writeFileSync(file, JSON.stringify({ search: { port: 1.5 } }))
    r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431 })

    fs.writeFileSync(file, JSON.stringify({ search: { port: 'abc' } }))
    r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431 })
  })

  it('search 整体非对象回退默认', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: 42 }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431 })
    expect(r.warnings.some((w) => w.includes('config.search'))).toBe(true)
  })
})
