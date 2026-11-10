# -*- coding: utf-8 -*-
"""工单281 收官追加：按用户裁决把 master 历史钝切到 2026-10-18 00:00 (+08:00) 之后。
确定性重建：拓扑序遍历 master 全图 -> 保留 committer_ts >= CUTOVER 的提交 ->
每个保留提交的父指针过滤为「父也在保留集」(跨界父链一律斩断, 合并旧链漏不掉) ->
commit-tree 逐个重建(作者/时间戳/消息字节原样保留) -> master reset --soft 到新链。
只动 refs/heads/master；其余分支(并行 worktree 在用)、tag、backup ref 一概不碰。
"""
import subprocess, sys, os

REPO = r"D:\test-folder\wallpaperengine-research"
CUTOVER = 1792252800  # 2026-10-18 00:00:00 +08:00（2026-10-18 00:00 UTC=1792281600，减 8h）

def git(*args, input_=None):
    r = subprocess.run(["git", "-C", REPO, *args], input=input_, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (args[0], r.stderr.decode("utf-8", "replace")))
    return r.stdout

def split_ident(raw):
    # b"Name <email> 1791657600 +0800" -> (name, email, "ts tz")
    ident, ts, tz = raw.rsplit(b" ", 2)
    lt = ident.rindex(b" <")
    return ident[:lt], ident[lt + 1:], ts + b" " + tz

master = git("rev-parse", "refs/heads/master").strip()
all_commits = git("rev-list", "--topo-order", "--reverse", master).split()
kept = {}          # old sha -> new sha
dropped = 0
for sha in all_commits:
    raw = git("cat-file", "commit", sha)
    head, _, msg = raw.partition(b"\n\n")
    tree = None; parents = []; author = None; committer = None
    for ln in head.split(b"\n"):
        if ln.startswith(b"tree "): tree = ln[5:]
        elif ln.startswith(b"parent "): parents.append(ln[7:])
        elif ln.startswith(b"author "): author = ln[7:]
        elif ln.startswith(b"committer "): committer = ln[10:]
    ts = int(committer.rsplit(b" ", 2)[-2])
    if ts < CUTOVER:
        dropped += 1
        continue
    new_parents = [kept[p] for p in parents if p in kept]
    an, ae, ad = split_ident(author)
    cn, ce, cd = split_ident(committer)
    e = dict(os.environ)
    e.update({
        "GIT_AUTHOR_NAME": an.decode("utf-8", "replace"),
        "GIT_AUTHOR_EMAIL": ae.decode("utf-8", "replace"),
        "GIT_AUTHOR_DATE": ad.decode(),
        "GIT_COMMITTER_NAME": cn.decode("utf-8", "replace"),
        "GIT_COMMITTER_EMAIL": ce.decode("utf-8", "replace"),
        "GIT_COMMITTER_DATE": cd.decode(),
    })
    args = ["commit-tree", tree.decode()]
    for p in new_parents:
        args += ["-p", p.decode()]
    r = subprocess.run(["git", "-C", REPO, *args], input=msg, capture_output=True, env=e)
    if r.returncode != 0:
        raise RuntimeError("commit-tree failed at %s: %s" % (sha.decode(), r.stderr.decode("utf-8", "replace")))
    kept[sha] = r.stdout.strip()

new_tip = kept[master]
old_tree = git("rev-parse", master + b"^{tree}").strip()
git("reset", "--soft", new_tip.decode())
new_tree = git("rev-parse", "refs/heads/master^{tree}").strip()

print("kept=%d dropped=%d" % (len(kept), dropped))
print("old_tip=%s new_tip=%s" % (master.decode()[:7], new_tip.decode()[:7]))
print("tree_equal=%s" % (old_tree == new_tree))
print("roots=%d" % subprocess.run(
    ["git", "-C", REPO, "rev-list", "--count", "--max-parents=0", "master"],
    capture_output=True).stdout.strip().decode())
