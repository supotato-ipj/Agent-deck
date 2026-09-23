"""把 patched/ 中的定制文件重放到 Workshop 壁纸目录（创意工坊更新覆盖后一键恢复改造）。

patched/ 内的相对路径与壁纸目录一一对应，例如 patched/index.html -> <壁纸目录>/index.html。
幂等：重复执行结果相同。
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATCHED = ROOT / "patched"
TARGET = Path(r"D:\Steam\steamapps\workshop\content\431960\3639973107")


def main() -> int:
    if not TARGET.is_dir():
        print(f"壁纸目录不存在: {TARGET}")
        return 1

    files = [p for p in PATCHED.rglob("*") if p.is_file()]
    if not files:
        print("patched/ 为空，无可重放的定制文件")
        return 0

    for src in files:
        rel = src.relative_to(PATCHED)
        dst = TARGET / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"已应用: {rel}")

    print(f"完成，共 {len(files)} 个文件")
    return 0


if __name__ == "__main__":
    sys.exit(main())
