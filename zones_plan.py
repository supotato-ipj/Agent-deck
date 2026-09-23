"""编排核心第一版：归类 + 应用区栏位（纯函数）。

不碰 Win32、文件系统、注册表。输入是任何带 name/kind/index 属性的桌面项
记录（实机为 desktop_icons.DesktopItem），输出是每项的 Placement：
归到哪一区、占第几个栏位、目标坐标。文档区的具体落位由 04 补齐，
本票只给出 doc 分类、pos 留空。
"""
from dataclasses import dataclass
from pathlib import Path

import zones_geometry as geo

# 回收站的显示名随系统 UI 语言变化；本机实测为英文
RECYCLE_NAMES = {"Recycle Bin", "回收站"}
APP_KINDS = {"shortcut", "url", "special"}
DOC_KINDS = {"file", "folder"}

# 文档组固定组序：位置可预测是"分区"能靠肌肉记忆使用的前提
GROUP_ORDER = ("folders", "office", "pdf", "image", "archive", "other")
OFFICE_EXTS = {".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf", ".csv"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tif", ".tiff"}
ARCHIVE_EXTS = {".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz"}


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


def doc_group(item):
    if item.kind == "folder":
        return "folders"
    ext = Path(item.name).suffix.lower()
    if ext in OFFICE_EXTS:
        return "office"
    if ext == ".pdf":
        return "pdf"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in ARCHIVE_EXTS:
        return "archive"
    return "other"


def _doc_placements(doc_items):
    """文档区落位：固定组序、每组一列、组间空一列、组内新在上、满 8 行折右侧相邻列。"""
    groups = {g: [] for g in GROUP_ORDER}
    for item in doc_items:
        groups[doc_group(item)].append(item)
    for members in groups.values():
        members.sort(key=lambda i: (-(i.mtime if i.mtime is not None else 0.0), i.name))

    placements = {}
    col = 0
    for group in GROUP_ORDER:
        members = groups[group]
        if not members:
            continue
        for offset, item in enumerate(members):
            c = col + offset // geo.DOC_MAX_ROWS
            r = offset % geo.DOC_MAX_ROWS
            pos = geo.doc_cell(c, r)
            # 越过避让线就不再落位：宁可留空也不压右栏
            placements[item.index] = Placement(item.name, "doc", None, pos if pos[0] < geo.AVOID_X else None)
        col += -(-len(members) // geo.DOC_MAX_ROWS) + 1
    return placements


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

    placements.update(_doc_placements([i for i in items if classify(i) == "doc"]))

    for item in items:
        if item.index in placements:
            continue
        zone = classify(item)
        if zone == "recycle":
            placements[item.index] = Placement(item.name, zone, None, geo.RECYCLE_POS)
        else:
            placements[item.index] = Placement(item.name, zone, None, None)

    return [placements[i.index] for i in items]
