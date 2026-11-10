# docs/ops — 仓库运维脚本

## 历史窗切根（7 天滚动钝切）

master 历史按 7 天滚动窗定期钝切，完整流程与验收判据见 `AGENTS.md`「历史保留窗（2026-10-25 用户拍板）」一节；本目录是当年（工单 #281，2026-10-25 首切 / 2026-11-01 二切实证）用过的两刀脚本，复用时按下表改常量。

| 脚本 | 作用 | 复用前必改 |
|---|---|---|
| `cut-history.py` | 第一刀·边界钝切：拓扑序重建 master 链，保留 `CUTOVER` 之后提交，斩断跨界父指针（保留集内每个提交的集外父都要脱，不止最老那一个——2026-11-01 实证边界入口可能不止一个） | `CUTOVER` epoch 常量（旧值是 2026-10-18，**每次须重新换算并验证**，别信注释直接用） |
| `cut-history-phase2.py` | 第二刀·树过滤：从每棵树剥除 `app/accept/`、`.scratch/` 前缀下的 `*.png` blob（防树引用残留），拓扑不动 | 通常不用改；剥除口径若变（见 PR #284 哨兵）再调 `PREFIXES` |

两刀都是确定性重建：作者/时间戳/消息逐字节保留（gpgsig 例外，父哈希一变签名必失效，按惯例丢弃）；只动 `refs/heads/master`，其余分支/tag/backup ref 不碰。

### 执行顺序（全流程见 AGENTS.md，此处只列脚本位）

1. 前置核对：`git fetch origin` 后确认 `origin/master` 仍等于重建基点
2. `python cut-history.py`（reset --soft 落新链）
3. `python cut-history-phase2.py`（剥 PNG blob）
4. ruleset `master-integration-gate` 经 API 临时停用（**`PUT` 不是 `PATCH`**，2026-11-01 实证）
5. `git push --force-with-lease=refs/heads/master:<基点SHA> origin <新tip>:refs/heads/master`
6. 同一 `PUT` 恢复 ruleset `"active"`
7. 验收：新旧 tip 树逐字节相同（`git diff <旧tip> <新tip>` 为空）+ 保留集提交逐字比对 + 新 tip 可达旧链提交数 = 0 + master 上 CI 绿

## 来源

2026-11-11 自仓库外工作底稿 `D:\test-folder\spec281-notes\` 抢救入库（该目录随后清理），脚本本体与当年执行时逐字节相同、未做任何"顺手改进"。
