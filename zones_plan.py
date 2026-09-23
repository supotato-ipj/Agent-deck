"""编排核心第一版：归类 + 应用区栏位（纯函数）。

不碰 Win32、文件系统、注册表。输入是任何带 name/kind/index 属性的桌面项
记录（实机为 desktop_icons.DesktopItem），输出是每项的 Placement：
归到哪一区、占第几个栏位、目标坐标。文档区的具体落位由 04 补齐，
本票只给出 doc 分类、pos 留空。
"""
from dataclasses import dataclass

import zones_geometry as geo

# 回收站的显示名随系统 UI 语言变化；本机实测为英文
RECYCLE_NAMES = {"Recycle Bin", "回收站"}
APP_KINDS = {"shortcut", "url", "special"}
DOC_KINDS = {"file", "folder"}


@dataclass(frozen=True)
class Placement:
    name: str
    zone: str  # app | doc | recycle | untouched
    slot: int | None
    pos: tuple[int, int] | None


def classify(item):
    if item.kind == "system":
        return "untouched"
    if item.name in RECYCLE_NAMES:
        return "recycle"
    if item.kind in DOC_KINDS:
        return "doc"
    if item.kind in APP_KINDS:
        return "app"
    return "untouched"


def _dedupe(names):
    seen = []
    for name in names:
        if name not in seen:
            seen.append(name)
    return seen


def plan_layout(items, pinned=()):
    """算出编排计划。pinned 为手钉显示名的有序清单，优先占据最靠前的栏位。

    内部以 index 为键：用户桌面与公共桌面可能出现同名项，以 name 为键会互相覆盖。
    """
    present = {i.name for i in items}
    pinned_order = [n for n in _dedupe(pinned) if n in present]
    app_items = sorted((i for i in items if classify(i) == "app"), key=lambda i: i.index)
    ordered = sorted(
        app_items,
        key=lambda i: (pinned_order.index(i.name) if i.name in pinned_order else len(pinned_order) + i.index,),
    )

    placements = {}
    slot = 0
    for item in ordered:
        if slot < geo.APP_SLOTS:
            col, row = slot % geo.APP_COLS, slot // geo.APP_COLS
            placements[item.index] = Placement(item.name, "app", slot, geo.app_slot(col, row))
            slot += 1
        else:
            # 栏位已满：归类仍为 app 但不落位，由后续票决定如何呈现
            placements[item.index] = Placement(item.name, "app", None, None)

    for item in items:
        if item.index in placements:
            continue
        zone = classify(item)
        if zone == "recycle":
            placements[item.index] = Placement(item.name, zone, None, geo.RECYCLE_POS)
        else:
            placements[item.index] = Placement(item.name, zone, None, None)

    return [placements[i.index] for i in items]
