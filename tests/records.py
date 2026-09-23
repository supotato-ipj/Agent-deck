"""测试共用的桌面项记录类型，避免各测试文件各自克隆。"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Rec:
    name: str
    kind: str
    index: int
    mtime: float | None = 0.0
    x: int = 0
    y: int = 0
    target: str | None = None
