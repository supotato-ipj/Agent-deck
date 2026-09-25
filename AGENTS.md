# AGENTS.md

本仓库用于 Wallpaper Engine「TERMINAL 02」壁纸改造：显示 Qoder 任务状态。

## Worktree 布局（平行开发）

- **主检出**：`D:\local_works\agent-deck`，常驻 `master`；数据服务、看门狗与自启链路以主检出为准，master 随时保持可推送。
- **feature 开发用 worktree**：`git worktree add "D:/local_works/agent-deck-wt/<slug>" -b feat/<slug>`，分支名统一 `feat/<slug>`。
- 每个 worktree 首次使用自建虚拟环境：`uv venv --python 3.12 && uv pip install -r requirements.txt`。
- 并行跑数据服务用 `QD_PORT` 区分端口（如 5001/5002），5000 留给主检出的看门狗实例。
- 票据（`.scratch/`）随分支走：worktree 只看得到自己分支的票据版本，合并进 master 后才汇合。
- 开发完 merge 回 master 推送，再 `git worktree remove <路径>` 清理。

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式存放在 `.scratch/<feature>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五标签词汇（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.
