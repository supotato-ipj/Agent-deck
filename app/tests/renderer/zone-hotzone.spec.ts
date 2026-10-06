/**
 * 分区热区几何测试（工单89，纯函数直测）：容器矩形外扩、窗内裁剪、空分区不占热区、
 * 点包含判定。端到端行为（环带起笔、穿透让渡）归验收电池。
 */
import { describe, expect, it } from 'vitest'
import { zoneHotzoneContains, zoneHotzoneRect } from '../../src/renderer/zone-hotzone'
import type { ZoneBox } from '../../src/renderer/zone-hotzone'

const WIN: ZoneBox = { x: 0, y: 0, w: 1920, h: 1080 }
const DOCK: ZoneBox = { x: 400, y: 986, w: 400, h: 94 }
const DOC: ZoneBox = { x: 408, y: 48, w: 300, h: 500 }

describe('zoneHotzoneRect 外扩与裁剪', () => {
  it('四周外扩 PAD', () => {
    expect(zoneHotzoneRect(DOC, WIN, true)).toEqual({
      x: DOC.x - 24, y: DOC.y - 24, w: DOC.w + 48, h: DOC.h + 48,
    })
  })

  it('越界部分裁进窗内：贴屏底的 dock 下沿外扩归零，其余三边照扩', () => {
    expect(zoneHotzoneRect(DOCK, WIN, true)).toEqual({
      x: DOCK.x - 24, y: DOCK.y - 24, w: DOCK.w + 48, h: 1080 - (DOCK.y - 24),
    })
  })

  it('空分区不占热区（不产生点击死区，穿透照旧）', () => {
    expect(zoneHotzoneRect(DOC, WIN, false)).toBeNull()
  })

  it('容器完全在窗外 → 裁剪退化返回 null', () => {
    const off: ZoneBox = { x: -500, y: -500, w: 100, h: 100 }
    expect(zoneHotzoneRect(off, WIN, true)).toBeNull()
  })
})

describe('zoneHotzoneContains', () => {
  const rect = zoneHotzoneRect(DOC, WIN, true)!

  it('环带上的点（容器外、外扩带内）在内', () => {
    expect(zoneHotzoneContains(rect, DOC.x - 10, DOC.y - 10)).toBe(true)
  })

  it('左/上沿闭、右/下沿开', () => {
    expect(zoneHotzoneContains(rect, rect.x, rect.y)).toBe(true)
    expect(zoneHotzoneContains(rect, rect.x + rect.w, rect.y)).toBe(false)
    expect(zoneHotzoneContains(rect, rect.x, rect.y + rect.h)).toBe(false)
  })

  it('带外点不在；null 矩形（空分区）永不含点', () => {
    expect(zoneHotzoneContains(rect, DOC.x - 25, DOC.y)).toBe(false)
    expect(zoneHotzoneContains(null, 0, 0)).toBe(false)
  })
})
