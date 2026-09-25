# AGENTS.md

本仓库是 AGENT DECK（desktop-deck）：本地数据服务 + 桌面图标编排的独立项目，不依赖 Wallpaper Engine。

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式存放在 `.scratch/<feature>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五标签词汇（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.
