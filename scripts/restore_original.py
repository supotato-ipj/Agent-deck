"""恢复 TERMINAL 02 壁纸到原始状态（镜像 backup/original -> Workshop 目录）。"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKUP = ROOT / "backup" / "original"
TARGET = Path(r"D:\Steam\steamapps\workshop\content\431960\3639973107")


def main() -> int:
    if not BACKUP.is_dir():
        print(f"备份不存在: {BACKUP}")
        return 1
    if not TARGET.parent.is_dir():
        print(f"Workshop 目录不存在: {TARGET.parent}")
        return 1

    print(f"将镜像恢复:\n  {BACKUP}\n  -> {TARGET}")
    answer = input("确认恢复原始状态? 壁纸目录中现有文件将被覆盖/删除 [y/N] ")
    if answer.strip().lower() != "y":
        print("已取消")
        return 0

    if TARGET.exists():
        shutil.rmtree(TARGET)
    shutil.copytree(BACKUP, TARGET)
    print("恢复完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
