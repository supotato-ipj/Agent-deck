"""把 deck/（AGENT DECK 经典版壁纸源）部署到 WE 的 myprojects/qoder-deck。

字体二进制不入库（Decima Mono 为商业字体，仅本地自用）；目标目录缺字体时
依次从仓库 wallpaper/fonts/、工坊 TERMINAL 02 的 fonts/ 取回副本。
幂等：重复执行结果相同。
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "deck"
FONT_NAMES = ("DecimaMonoCyr.ttf", "VT323-Regular.ttf")

# 不同机器的 Steam 库位置不同（SteamLibrary / Games / ...），逐个探测
_STEAM_ROOTS = (
    Path(r"D:\SteamLibrary"),
    Path(r"D:\Games"),
    Path(r"C:\Program Files (x86)\Steam"),
)


def _we_root() -> Path | None:
    for root in _STEAM_ROOTS:
        candidate = root / "steamapps" / "common" / "wallpaper_engine"
        if candidate.is_dir():
            return candidate
    return None


def main() -> int:
    we = _we_root()
    if we is None:
        print("未找到 wallpaper_engine 目录，探测过：" +
              "、".join(str(r) for r in _STEAM_ROOTS))
        return 1
    target = we / "projects" / "myprojects" / "qoder-deck"
    workshop_fonts = we / "steamapps" / "workshop" / "content" / "431960" / "3639973107" / "fonts"
    if not target.parent.is_dir():
        print(f"myprojects 不存在: {target.parent}")
        return 1

    files = [p for p in SRC.rglob("*") if p.is_file()]
    if not files:
        print("deck/ 为空，无源文件可部署")
        return 1
    for src in files:
        dst = target / src.relative_to(SRC)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"已部署: {src.relative_to(SRC)}")

    fonts_dir = target / "fonts"
    fonts_dir.mkdir(exist_ok=True)
    for name in FONT_NAMES:
        dst = fonts_dir / name
        if dst.is_file():
            continue
        for src in (ROOT / "wallpaper" / "fonts" / name, workshop_fonts / name):
            if src.is_file():
                shutil.copy2(src, dst)
                print(f"已取回字体: {name}（自 {src.parent}）")
                break
        else:
            print(f"字体缺失且无可用副本: {name}")

    print(f"完成，源文件 {len(files)} 个 -> {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
