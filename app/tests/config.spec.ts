import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultAppearance, defaultAutostart, defaultDesktopLayout, defaultPanelGeometry, defaultPlugins, defaultSearchConfig, defaultTools, defaultWeather, loadConfig, saveConfig } from '../src/main/config'

const FALLBACK = { panel: { x: 0, y: 0, width: 1560, height: 1040 }, weather: defaultWeather(), desktop: defaultDesktopLayout(), search: defaultSearchConfig(), appearance: defaultAppearance(), tools: defaultTools(), plugins: defaultPlugins(), autostart: defaultAutostart() }

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
  it('defaultSearchConfig 用 Listary 生产端口；缺省引擎 auto、Everything 端口 80（工单14）', () => {
    expect(defaultSearchConfig()).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })
  })

  it('search 段缺失回退默认（老 config.json 兼容）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: FALLBACK.panel }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })
    expect(r.warnings).toHaveLength(0)
  })

  it('search.port 合法值生效（验收指假端口复现引擎离线）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { port: 39999 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 39999, engine: 'auto', everythingPort: 80 })
    expect(r.warnings).toHaveLength(0)
  })

  it('search.port 非法（越界/非整数/非数）回退默认并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { port: 0 } }))
    let r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })
    expect(r.warnings.some((w) => w.includes('config.search.port'))).toBe(true)

    fs.writeFileSync(file, JSON.stringify({ search: { port: 1.5 } }))
    r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })

    fs.writeFileSync(file, JSON.stringify({ search: { port: 'abc' } }))
    r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })
  })

  it('search 整体非对象回退默认', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: 42 }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })
    expect(r.warnings.some((w) => w.includes('config.search'))).toBe(true)
  })
})

describe('config 模型（工单13 搜索引擎选择）', () => {
  it('engine=everything/listary 显式锁定生效；缺 port 时引擎键独立生效（不互相吞）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { engine: 'everything', everythingPort: 8080 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'everything', everythingPort: 8080 })
    expect(r.warnings).toHaveLength(0)

    fs.writeFileSync(file, JSON.stringify({ search: { engine: 'listary' } }))
    const r2 = loadConfig(file, FALLBACK)
    expect(r2.config.search).toEqual({ port: 38431, engine: 'listary', everythingPort: 80 })
    expect(r2.warnings).toHaveLength(0)
  })

  it('engine=auto 生效（工单14 探测语义已接入，不再告警）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { engine: 'auto' } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })
    expect(r.warnings).toHaveLength(0)
  })

  it('engine 非法值告警回退默认（缺省 = auto）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { engine: 'google' } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.search).toEqual({ port: 38431, engine: 'auto', everythingPort: 80 })
    expect(r.warnings.some((w) => w.includes('config.search.engine'))).toBe(true)
  })

  it('everythingPort 非法（越界/非整数）回退默认并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ search: { everythingPort: 0 } }))
    let r = loadConfig(file, FALLBACK)
    expect(r.config.search.everythingPort).toBe(80)
    expect(r.warnings.some((w) => w.includes('config.search.everythingPort'))).toBe(true)

    fs.writeFileSync(file, JSON.stringify({ search: { everythingPort: 1.5 } }))
    r = loadConfig(file, FALLBACK)
    expect(r.config.search.everythingPort).toBe(80)
  })
})

describe('config 模型（工单08 设置浮层透明度）', () => {
  it('defaultAppearance 给模块底色透明度生产值 0.55（现 rgba(0,0,0,0.55) 固化）', () => {
    expect(defaultAppearance()).toEqual({ cardOpacity: 0.55 })
  })

  it('appearance 段缺失回退默认（老 config.json 兼容，不告警）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: FALLBACK.panel }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.appearance).toEqual({ cardOpacity: 0.55 })
    expect(r.warnings).toHaveLength(0)
  })

  it('appearance.cardOpacity 合法值（含 0 与 1 边界）整体生效', () => {
    const file = tmpFile()
    for (const cardOpacity of [0, 1, 0.25, 0.85]) {
      fs.writeFileSync(file, JSON.stringify({ appearance: { cardOpacity } }))
      const r = loadConfig(file, FALLBACK)
      expect(r.config.appearance).toEqual({ cardOpacity })
      expect(r.warnings).toHaveLength(0)
    }
  })

  it('appearance.cardOpacity 非法（越界/非数）回退默认并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ appearance: { cardOpacity: 1.5 } }))
    let r = loadConfig(file, FALLBACK)
    expect(r.config.appearance).toEqual({ cardOpacity: 0.55 })
    expect(r.warnings.some((w) => w.includes('config.appearance.cardOpacity'))).toBe(true)

    fs.writeFileSync(file, JSON.stringify({ appearance: { cardOpacity: 'dark' } }))
    r = loadConfig(file, FALLBACK)
    expect(r.config.appearance).toEqual({ cardOpacity: 0.55 })

    fs.writeFileSync(file, JSON.stringify({ appearance: { cardOpacity: -0.1 } }))
    r = loadConfig(file, FALLBACK)
    expect(r.config.appearance).toEqual({ cardOpacity: 0.55 })
  })

  it('appearance 整体非对象回退默认', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ appearance: 'opaque' }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.appearance).toEqual({ cardOpacity: 0.55 })
    expect(r.warnings.some((w) => w.includes('config.appearance'))).toBe(true)
  })

  it('saveConfig 整份回写（设置滑杆的持久化通道），读回一致', () => {
    const file = tmpFile()
    const config = { ...FALLBACK, appearance: { cardOpacity: 0.3 } }
    saveConfig(file, config)
    expect(loadConfig(file, FALLBACK).config).toEqual(config)
  })
})

describe('config.plugins 插件目录（工单10 桌面组件安装位）', () => {
  it('缺 plugins 段时用缺省（空串 = 主进程解析为 userData/plugins，老 config.json 静默兼容）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: { x: 1, y: 2, width: 3, height: 4 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.plugins).toEqual({ dir: '' })
    expect(r.warnings).toHaveLength(0)
  })

  it('可改安装位：plugins.dir 生效（插件目录即安装位，换位置只调配置）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ plugins: { dir: 'D:\\deck-plugins' } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.plugins.dir).toBe('D:\\deck-plugins')
    expect(r.warnings).toHaveLength(0)
  })

  it('plugins.dir 非字符串回退默认并告警（不静默吞笔误）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ plugins: { dir: 42 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.plugins.dir).toBe('')
    expect(r.warnings.join()).toMatch(/plugins\.dir/)
  })

  it('plugins 段整体非对象回退默认并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ plugins: 'D:\\deck-plugins' }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.plugins.dir).toBe('')
    expect(r.warnings.join()).toMatch(/config\.plugins/)
  })
})

describe('config.tools 工具→exe 映射（工单09）', () => {
  it('缺 tools 段时合并五工具默认值（老 config.json 静默兼容）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: { x: 1, y: 2, width: 3, height: 4 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.warnings).toHaveLength(0)
    expect(Object.keys(r.config.tools).sort()).toEqual(['hermes', 'kimicode', 'kimiwork', 'qoder', 'zcode'])
    expect(r.config.tools.zcode.processes).toEqual(['zcode'])
  })

  it('启动目标可改：换机/改安装位置只调 json 键', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ tools: { zcode: { launch: 'E:\\apps\\ZCode.exe', processes: ['zcode'] } } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.tools.zcode.launch).toBe('E:\\apps\\ZCode.exe')
    expect(r.warnings).toHaveLength(0)
  })

  it('processes 归一为小写（匹配口径与决策层同源）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ tools: { zcode: { processes: ['ZCode.EXE', 'Zcode'] } } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.tools.zcode.processes).toEqual(['zcode'])
    // 只给 processes 时 launch 保留默认
    expect(r.config.tools.zcode.launch).toBe(defaultTools().zcode.launch)
  })

  it('可新增自定义工具条目', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ tools: { mytool: { launch: 'D:\\my.exe', processes: ['mytool'] } } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.tools.mytool).toEqual({ launch: 'D:\\my.exe', processes: ['mytool'] })
  })

  it('非法字段回退默认并告警（不静默吞掉用户笔误）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ tools: { zcode: { launch: 42, processes: 'zcode' } } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.tools.zcode.launch).toBe(defaultTools().zcode.launch)
    expect(r.config.tools.zcode.processes).toEqual(['zcode'])
    expect(r.warnings.some((w) => w.includes('config.tools.zcode.launch'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('config.tools.zcode.processes'))).toBe(true)
  })

  it('tools 整体非对象回退默认', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ tools: ['zcode'] }))
    const r = loadConfig(file, FALLBACK)
    expect(Object.keys(r.config.tools).sort()).toEqual(['hermes', 'kimicode', 'kimiwork', 'qoder', 'zcode'])
    expect(r.warnings.some((w) => w.includes('config.tools'))).toBe(true)
  })
})

describe('config.autostart 自启开关（工单11）', () => {
  it('缺 autostart 段时默认开启（老 config.json 静默兼容）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: { x: 1, y: 2, width: 3, height: 4 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.autostart.enabled).toBe(true)
    expect(r.warnings).toHaveLength(0)
  })

  it('enabled=false 关自启（面板启动即删 Startup 快捷方式）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ autostart: { enabled: false } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.autostart.enabled).toBe(false)
    expect(r.warnings).toHaveLength(0)
  })

  it('非布尔值回退默认并告警（不静默吞掉用户笔误）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ autostart: { enabled: 'yes' } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.autostart.enabled).toBe(true)
    expect(r.warnings.some((w) => w.includes('config.autostart.enabled'))).toBe(true)
  })

  it('缺 appDir 段时为空串=未声明生产位置（开发运行不得接管自启项）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ panel: { x: 1, y: 2, width: 3, height: 4 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.autostart.appDir).toBe('')
    expect(r.warnings).toHaveLength(0)
  })

  it('appDir 可声明生产安装位置（换机/改位置只调这一项）', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ autostart: { appDir: '  D:\\local_works\\agent-deck\\app  ' } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.autostart.appDir).toBe('D:\\local_works\\agent-deck\\app')
    expect(r.warnings).toHaveLength(0)
  })

  it('appDir 非字符串回退默认并告警', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ autostart: { appDir: 42 } }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.autostart.appDir).toBe('')
    expect(r.warnings.some((w) => w.includes('config.autostart.appDir'))).toBe(true)
  })

  it('autostart 整体非对象回退默认', () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ autostart: [true] }))
    const r = loadConfig(file, FALLBACK)
    expect(r.config.autostart.enabled).toBe(true)
    expect(r.warnings.some((w) => w.includes('config.autostart'))).toBe(true)
  })
})
