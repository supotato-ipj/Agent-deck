"""桌面目录看门狗：新增/删除才触发增量编排，自动落位。

漂移纠正的精确语义（2026-09-24 钉死）：
- 应用区只动**新出现的项**；已存在的快捷方式无论被用户拖到哪、推荐分数怎么
  变，看门狗都不碰——分数重排留给手动全量编排（05）。
- 文档区豁免保护：每次触发都按最新计划级联落位，新文档归组、删除后收紧。
- 回收站不由看门狗移动。
触发只看两个桌面目录的**文件名集合**：内容修改、重命名之外的元数据变化都
不算事件。检测到变化后先 settle（等集合稳定）把事件风暴合并成一次编排。
"""
import logging
import os
import sys
import time
from pathlib import Path

import desktop_icons as di
import desktop_layout as dl
import usage_score
import zones_lock
import zones_orchestrate as zo
import zones_plan as zp

SETTLE_INTERVAL = 1.0
SETTLE_MAX_ROUNDS = 5
VIEW_CATCHUP_ROUNDS = 15  # 新增图标进 ListView 的延迟实测可达十秒级

log = logging.getLogger("zones-watcher")


def _configure_logging():
    if log.handlers:
        return
    root = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "qoder-deck"
    try:
        root.mkdir(parents=True, exist_ok=True)
        log.setLevel(logging.INFO)
        log.addHandler(logging.FileHandler(root / "watcher.log", encoding="utf-8"))
    except OSError:
        pass  # 日志目录建不成就只走 stdout，绝不能拖死数据服务
    log.addHandler(logging.StreamHandler(sys.stdout))


_configure_logging()


def scan_names():
    """两个桌面目录下的可见文件名集合。

    隐藏/系统项（desktop.ini）必须排除：ListView 不显示它们，若计入则
    "视图追平"永远等不满，删除事件那一轮会拿含旧项的视图算计划而零动作。
    """
    names = set()
    for directory in di.desktop_dirs():
        for entry in directory.iterdir():
            attrs = di.file_attributes(entry)
            if attrs & (di.ATTR_HIDDEN | di.ATTR_SYSTEM):
                continue
            names.add(entry.name)
    return names


def changed(previous, current):
    return previous != current


def settle(scan, interval=SETTLE_INTERVAL, max_rounds=SETTLE_MAX_ROUNDS):
    """等文件名集合稳定一轮，把拷入风暴合并成一次编排。"""
    names = scan()
    for _ in range(max_rounds):
        time.sleep(interval)
        nxt = scan()
        if nxt == names:
            return names
        names = nxt
    return names


def incremental_moves(items, plan, previous_names, removed_names=()):
    """按漂移纠正语义从完整计划里挑出本次真正要写的落位动作。"""
    moves = []
    for item, placement in zip(items, plan):
        if placement.pos is None:
            continue
        if (item.x, item.y) == placement.pos:
            continue
        if placement.zone == "app" and item.name in previous_names:
            # 应用区只动新出现的项；但压在分区标签空行上的图标例外——
            # 标签可读性优先于"不碰用户摆位"（spec story 22）
            if not _in_label_band(item):
                continue
        if placement.zone == "app" and removed_names and item.name not in previous_names:
            continue  # 同轮既有消失又有新增，可能是重命名；不动，留给下次全量编排
        if placement.zone == "recycle":
            continue  # 回收站不由看门狗移动
        moves.append((item.name, placement.pos[0], placement.pos[1]))
    return moves


def _in_label_band(item):
    """图标是否压在分区标签独占的那一行空行里。"""
    import zones_geometry as geo

    top = geo.DOC_ORIGIN[1] - geo.ROW_STEP
    return top <= item.y < geo.DOC_ORIGIN[1] and item.x < geo.AVOID_X


def arrange_once(previous_names):
    """一次增量编排：算计划、挑动作、快照、落位。

    返回 (当前名集合, 落位数, 视图是否追平)。落位后的读回收敛由
    desktop_icons.write_named_moves 负责，这里不再重复自愈。
    """
    current = scan_names()
    removed = previous_names - current
    try:
        with zones_lock.ArrangeLock(wait_seconds=0):
            # 文件系统事件先于 explorer 的 ListView 刷新；视图没跟上就规划，
            # 会把"已删除"仍算在内、计划等于现状而什么都不做。等视图追平；
            # 新增图标进视图的延迟实测可达十秒级，等不满就标记未追平。
            caught_up = False
            for _ in range(VIEW_CATCHUP_ROUNDS):
                items = di.list_items()
                if {i.name for i in items} == current:
                    caught_up = True
                    break
                time.sleep(SETTLE_INTERVAL)
            plan = zp.plan_layout(items, zo.load_pinned(), usage_score.ranking(items))
            moves = incremental_moves(items, plan, previous_names, removed)
            log.info("arrange: view=%d fs=%d moves=%d", len(items), len(current), len(moves))
            if moves:
                dl.ensure_factory(items)
                dl.take_snapshot(items, "run")
                with di.IconView() as view:
                    view.write_named_moves(moves)
                log.info("增量编排落位 %d 项", len(moves))
    except zones_lock.ArrangeBusy:
        log.info("编排锁被占用（手动编排进行中），本轮跳过")
        return current, 0, True
    return current, len(moves), caught_up


def run_watch_loop(interval=2.0):
    previous = scan_names()
    while True:
        try:
            time.sleep(interval)
            current = scan_names()
            if not changed(previous, current):
                continue
            current = settle(scan_names)
            previous, moved, caught_up = arrange_once(previous)
            if not caught_up:
                # 视图没追平：本轮计划可能漏了新图标，立刻再排一轮
                log.info("视图未追平，追加一轮编排")
                previous, moved, _ = arrange_once(previous)
        except di.DesktopViewUnavailable as exc:
            log.warning("本次编排跳过（图标视图不可用）：%s", exc)
            previous = scan_names()
        except Exception as exc:
            log.exception("编排失败，跳过：%s", exc)
            previous = scan_names()


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    interval = float(argv[0]) if argv else 2.0
    print(f"zones-watcher: 监控桌面目录，每 {interval}s 扫描；Ctrl-C 退出")
    try:
        run_watch_loop(interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
