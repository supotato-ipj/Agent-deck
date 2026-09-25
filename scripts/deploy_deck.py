"""把 deck/（AGENT DECK 壁纸源）部署到 WE 的 myprojects/qoder-deck。

字体二进制不入库（Decima Mono 为商业字体，仅本地自用）；目标目录缺字体时
从工坊 TERMINAL 02 的 fonts/ 取回副本。幂等：重复执行结果相同。
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "deck"
TARGET = Path(r"D:\SteamLibrary\steamapps\common\wallpaper_engine\projects\myprojects\qoder-deck")
WORKSHOP_FONTS = Path(r"D:\SteamLibrary\steamapps\workshop\content\431960\3639973107\fonts")
FONT_NAMES = ("DecimaMonoCyr.ttf", "VT323-Regular.ttf")


def main() -> int:
    if not TARGET.parent.is_dir():
        print(f"myprojects 不存在: {TARGET.parent}")
        return 1

    files = [p for p in SRC.rglob("*") if p.is_file()]
    if not files:
        print("deck/ 为空，无源文件可部署")
        return 1
    for src in files:
        dst = TARGET / src.relative_to(SRC)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"已部署: {src.relative_to(SRC)}")

    fonts_dir = TARGET / "fonts"
    fonts_dir.mkdir(exist_ok=True)
    for name in FONT_NAMES:
        dst = fonts_dir / name
        if dst.is_file():
            continue
        src = WORKSHOP_FONTS / name
        if src.is_file():
            shutil.copy2(src, dst)
            print(f"已取回字体: {name}")
        else:
            print(f"字体缺失且工坊无副本: {name}")

    print(f"完成，源文件 {len(files)} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
