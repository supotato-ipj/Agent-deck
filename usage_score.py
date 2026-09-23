"""使用频次打分：真启动次数 × 指数衰减（半衰期 14 天），叠加 UserAssist 冷启动先验。

打分是纯函数，"当前时间"一律由参数传入，便于断言衰减数学。
自建日志（06）提供逐次启动事件；系统现成的 UserAssist 记录只提供
"总次数 + 最后执行时间"，故折算为 count × decay(age(last)) 的先验项，
并按 1/(1+日志次数) 的权重随日志积累逐步退位——日志为空的第一天排名
仍非空，日志充足后先验被压过。

本模块只产出"可执行路径 -> 分数"；把分数挂到桌面图标上是 map_to_icons
的职责，映射不上的进程在这里不被丢弃（日志仍保留），只在排名中消失。
"""
import codecs
import json
import sys
import winreg
from datetime import datetime, timezone
from pathlib import Path

import usage_log as ul

HALF_LIFE_DAYS = 14.0

USERASSIST_KEY = r"Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist"
FILETIME_EPOCH_OFFSET = 116444736000000000


def decay(age_days):
    return 0.5 ** (age_days / HALF_LIFE_DAYS)


def score_starts(events, now):
    """[(ts, exe)] -> {exe: 衰减加权和}。纯函数。"""
    scores = {}
    for ts, exe in events:
        age = (now - ts).total_seconds() / 86400.0
        scores[exe] = scores.get(exe, 0.0) + decay(age)
    return scores


def parse_userassist(rotated_name, data):
    """解析一条 UserAssist 值：ROT13 值名 + 72 字节二进制。

    返回 (可执行路径, 次数, 最后执行时间)；长度不足返回 None。
    """
    if not isinstance(data, (bytes, bytearray)) or len(data) < 68:
        return None
    name = codecs.decode(rotated_name, "rot_13")
    count = int.from_bytes(data[4:8], "little")
    filetime = int.from_bytes(data[60:68], "little")
    if filetime == 0:
        return None  # 没有最后执行时间就无法衰减，先验无从谈起
    epoch_seconds = (filetime - FILETIME_EPOCH_OFFSET) / 1e7
    try:
        last = datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)
    except (OSError, OverflowError, ValueError):
        return None
    return name, count, last


def read_userassist_prior():
    """读系统现成启动记录，折算为 {路径: (次数, 最后执行时间)}。

    子键 GUID 随系统版本变化，动态枚举而非硬编码。只收 .exe 与 .lnk 结尾的
    条目：前者经 .lnk 目标映射，后者经 stem 与桌面显示名映射。
    """
    prior = {}
    try:
        root = winreg.OpenKey(winreg.HKEY_CURRENT_USER, USERASSIST_KEY)
    except OSError:
        return prior
    with root:
        for i in range(winreg.QueryInfoKey(root)[0]):
            try:
                sub_name = winreg.EnumKey(root, i)
            except OSError:
                break
            try:
                # 计数条目在 <GUID>\Count 下一层，GUID 层只有 Version
                key = winreg.OpenKey(root, sub_name + "\\Count")
            except OSError:
                continue
            with key:
                for j in range(winreg.QueryInfoKey(key)[1]):
                    try:
                        name, data, _ = winreg.EnumValue(key, j)
                    except OSError:
                        break
                    parsed = parse_userassist(name, data)
                    if not parsed:
                        continue
                    path, count, last = parsed
                    low = path.lower()
                    if not (low.endswith(".exe") or low.endswith(".lnk")):
                        continue
                    better = prior.get(path)
                    if better is None or count > better[0]:
                        prior[path] = (count, last)
    return prior


def read_start_events(directory=None, now=None):
    """读取 06 的 start 日志为 [(ts, exe)]；未来时间戳忽略。"""
    directory = Path(directory) if directory else ul.log_dir()
    now = now or datetime.now(timezone.utc)
    events = []
    for path in sorted(directory.glob("start-*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            ts = datetime.fromisoformat(record["ts"])
            if ts <= now:
                events.append((ts, record["exe"]))
    return events


def fuse(prior, events, now):
    """先验与自建日志融合为 {exe: 分数}。纯函数。

    先验项权重 1/(1+该 exe 的日志启动次数)：日志为空时权重为 1（排名来自
    先验），日志积累后权重趋于 0（先验退位）。
    """
    counts = {}
    log_scores = score_starts(events, now)
    for _ts, exe in events:
        counts[exe] = counts.get(exe, 0) + 1
    fused = {}
    for exe in set(counts) | set(log_scores) | set(prior):
        n = counts.get(exe, 0)
        prior_count, prior_last = prior.get(exe, (0, None))
        prior_term = prior_count * decay((now - prior_last).total_seconds() / 86400.0) if prior_last else 0.0
        score = log_scores.get(exe, 0.0) + prior_term / (1 + n)
        if score > 0:
            fused[exe] = score
    return fused


def map_to_icons(scores, items):
    """把路径分数挂到桌面快捷方式上：{显示名: 分数}。

    两条映射路：.exe 经 .lnk 目标反查；.lnk（UserAssist 的任务栏/开始菜单
    条目）经 stem 与桌面显示名对齐。映射不上的路径不出现在排名里（日志本身
    不受影响）。
    """
    by_target = {}
    by_stem = {}
    for item in items:
        if item.kind == "shortcut":
            if item.target:
                by_target.setdefault(item.target.lower(), item.name)
            by_stem.setdefault(item.name.lower(), item.name)
    ranking = {}
    for path, score in scores.items():
        low = path.lower()
        if low.endswith(".exe"):
            name = by_target.get(low)
        elif low.endswith(".lnk"):
            name = by_stem.get(Path(path).stem.lower())
        else:
            name = None
        if name:
            ranking[name] = ranking.get(name, 0.0) + score
    return ranking


def ranking(items, directory=None, now=None):
    """端到端：桌面项清单 -> {显示名: 使用频次分数}。"""
    now = now or datetime.now(timezone.utc)
    prior = read_userassist_prior()
    events = read_start_events(directory, now)
    return map_to_icons(fuse(prior, events, now), items)


def main(argv):

    import desktop_icons as di

    sys.stdout.reconfigure(encoding="utf-8")
    items = di.list_items()
    scores = ranking(items)
    if not scores:
        print("ranking: 空（先验与日志都无可映射项）")
        return 0
    for name, score in sorted(scores.items(), key=lambda kv: -kv[1]):
        print(f"{score:8.3f}  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
