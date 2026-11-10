# -*- coding: utf-8 -*-
"""钝切第二刀：对当前 master（已是 7 天窗口的 193 提交链）做树过滤——
所有 app/accept/ 与 .scratch/ 前缀下的 *.png blob 从每个树剥除（镜像 #284 哨兵口径，
archive 的 2 张上游资产不动）。拓扑与父链保持不变，仅树重写；终树不含口径内 PNG，
tip 树 SHA 必须与过滤前一致。树重写逐层 memo 化（跨提交共享子树只算一次）。
"""
import subprocess, sys, os

REPO = r"D:\test-folder\wallpaperengine-research"
PREFIXES = (b"app/accept/", b".scratch/")

def git(*args, input_=None):
    r = subprocess.run(["git", "-C", REPO, *args], input=input_, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (args[0], r.stderr.decode("utf-8", "replace")))
    return r.stdout

_memo = {}
def filter_tree(tree, prefix):
    key = (tree, prefix)
    if key in _memo:
        return _memo[key]
    out = []
    raw = git("ls-tree", "-z", tree.decode())
    for ent in raw.split(b"\0"):
        if not ent:
            continue
        meta, name = ent.split(b"\t", 1)
        mode, typ, sha = meta.split(b" ")
        path = prefix + name
        if typ == b"blob" and path.endswith(b".png") and path.startswith(PREFIXES):
            continue
        if typ == b"tree":
            sub = filter_tree(sha, path + b"/")
            if sub is None:
                continue  # 子树被剥空 -> 目录随之消失
            out.append(mode + b" tree " + sub + b"\t" + name)
        else:
            out.append(mode + b" " + typ + b" " + sha + b"\t" + name)
    if not out:
        _memo[key] = None
        return None
    r = subprocess.run(["git", "-C", REPO, "mktree", "-z"], input=b"\0".join(out) + b"\0",
                       capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("mktree failed: %s" % r.stderr.decode("utf-8", "replace"))
    new = r.stdout.strip()
    _memo[key] = new
    return new

before_tip = git("rev-parse", "refs/heads/master").strip()
tip_tree_before = git("rev-parse", "refs/heads/master^{tree}").strip()
commits = git("rev-list", "--topo-order", "--reverse", "master").split()
kept = {}
stripped_trees = 0
for sha in commits:
    raw = git("cat-file", "commit", sha)
    head, _, msg = raw.partition(b"\n\n")
    tree = None; parents = []
    for ln in head.split(b"\n"):
        if ln.startswith(b"tree "): tree = ln[5:]
        elif ln.startswith(b"parent "): parents.append(ln[7:])
        elif ln.startswith(b"author "): author = ln[7:]
        elif ln.startswith(b"committer "): committer = ln[10:]
    new_tree = filter_tree(tree, b"")
    if new_tree != tree:
        stripped_trees += 1
    ident, ts, tz = committer.rsplit(b" ", 2)
    lt = ident.rindex(b" <")
    an, ae, ad = author.rsplit(b" ", 2), None, None
    ai = author.rindex(b" <")
    e = dict(os.environ)
    e.update({
        "GIT_AUTHOR_NAME": author[:ai].decode("utf-8", "replace"),
        "GIT_AUTHOR_EMAIL": author[ai + 1:].rsplit(b" ", 2)[0].decode("utf-8", "replace"),
        "GIT_AUTHOR_DATE": (author.rsplit(b" ", 2)[1] + b" " + author.rsplit(b" ", 2)[2]).decode(),
        "GIT_COMMITTER_NAME": ident[:lt].decode("utf-8", "replace"),
        "GIT_COMMITTER_EMAIL": ident[lt + 1:].decode("utf-8", "replace"),
        "GIT_COMMITTER_DATE": (ts + b" " + tz).decode(),
    })
    args = ["commit-tree", new_tree.decode()]
    for p in parents:
        args += ["-p", kept[p].decode()]
    r = subprocess.run(["git", "-C", REPO, *args], input=msg, capture_output=True, env=e)
    if r.returncode != 0:
        raise RuntimeError("commit-tree failed at %s: %s" % (sha.decode(), r.stderr.decode("utf-8", "replace")))
    kept[sha] = r.stdout.strip()

new_tip = kept[before_tip]
git("reset", "--soft", new_tip.decode())
tip_tree_after = git("rev-parse", "refs/heads/master^{tree}").strip()
print("commits=%d trees_changed=%d" % (len(kept), stripped_trees))
print("tip_tree_unchanged=%s" % (tip_tree_before == tip_tree_after))
print("old_tip=%s new_tip=%s" % (before_tip.decode()[:7], new_tip.decode()[:7]))
