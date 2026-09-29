# 11: 退役与收尾（contract 步）

**What to build:** 新应用全面接管：Startup 自启快捷方式切换到新应用并真重启复验；退役 Python 数据服务及其自启链、看门狗、Tk 搜索窗、zones Win32 挪真图标链路、三个 WE 部署脚本；deck/patched/backup 壁纸资产冻结归档（只读封存不再维护）；README 与 docs 更新到新架构语境（与 ADR-0004、CONTEXT.md 终稿一致）；旧使用日志历史数据的去向有明确交代（随迁移保留或声明重新积累）。

**Blocked by:** 03 宿主常驻件、04 数据卡片、05 桌面承载尖兵、06 编排与推荐、07 搜索并入、08 设置浮层与透明度、09 会话块直达、10 插件体系自举

**Status:** in-progress（代码与文档面已完成并收编双轴评审；余「真重启自启复验」与「电池最终全绿」两项待合入 master 后补做）

- [ ] 真重启后仅新面板自启就位；旧数据服务/看门狗/Tk 搜索窗进程不存在
- [ ] 旧自启项移除，新自启项经真重启验证
- [x] 退役代码与脚本移除或归档，壁纸资产只读封存
- [x] README/docs 与词汇表、ADR 一致
- [x] 使用日志历史去向明确（迁移保留或声明重新积累）
- [ ] 全量验收电池最终轮全绿并截图存证于工单评论

## Comments

**2026-09-29 实施记录（提交 a347a06 → 本票改动）**

**代码退役**：删除 Python 数据服务与其自启链全部模块（`server.py` / `agent_sessions.py` /
`zones_*.py` / `desktop_icons.py` / `desktop_layout.py` / `usage_log.py` / `usage_score.py` /
`listary_engine.py` / `pinned.json` / `requirements.txt`）、19 个 Python 单测文件、看门狗
（`server_watchdog.pyw`）、`create_startup_shortcut.ps1`，以及 deploy/apply/restore 三个 WE
部署脚本与 accept_zones / capture_* / list_screens 辅助脚本。`app/scripts/compare-sessions.mjs`
一并删除——它只比对 Python 扫描器，工单04 的逐字段对照结论已存证于该票评论。

**壁纸资产冻结**：`deck/`、`patched/`、`backup/` 原样移入 `archive/wallpaper-assets/`，配
`archive/README.md` 声明只读封存（不改、不依赖、可删）。

**自启切换**：新增 `app/src/main/autostart.ts` + `autostart.ps1`（COM 读写 Startup 快捷方式），
`config.autostart` 段（`enabled` + `appDir`）。语义经评审收编——**只有 `appDir` 声明的生产安装
位置才有权新建/接管自启项**，开发 worktree 运行不劫持（详见该文件头注三条规则）。

**使用日志去向（验收项 5）**：面板首启自动把 `%LOCALAPPDATA%\qoder-deck\usage` **复制**进
`userData/usage`（格式逐字段相同），旧目录原样保留待用户自删。幂等由「逐文件记账 + 按行去重」
保证。README「历史使用日志的去向」节有完整交代。

**运行态退役（本次实测）**：Startup 里的 `qoder-deck-server-watchdog.lnk` 曾于 09-27 删过后
**又被重建**（指向主检出 `D:\local_works\agent-deck\scripts\server_watchdog.pyw`，创建时间
2026-09-25）——说明「删一次」不成立，退役必须由程序无条件执行。已再次删除，并结束**两个**
看门狗进程（PID 10932 venv pythonw、PID 42712 uv cpython-3.12 pythonw，后者同跑一个脚本，
上一轮漏掉）。端口 5000 已无监听，无计划任务/HKLM 复活途径。

**双轴评审（/code-review，固定点 a347a06）收编**：
- 规格轴：worktree 劫持自启项（高）→ 已修（生产身份闸门 + 8 条新测试）；
  使用日志重跑翻倍 → 已修（按行去重，并删掉原注释里那句不成立的「靠去重兜住」）；
  使用日志去向未成文 → 已补 README 专节；电池未全绿 → 见下。
- 标准轴：`applyAutostart` 零测试 → 已补 6 条真 COM 集成测试（含旧链清除）；CONTEXT.md 缺
  「自启项」词条 → 已补；`autostart.ps1` 的 remove 分支为死代码 → 已删；
  `retentionDays?` 形参无人传 → 已删；`battery.js` 与 `clearDesktop` 形状相似 → 判定**故意
  不合并**（后者是开局全桌面扫描且其还原清单由末尾 finally 一次性消费），已就地注明理由。

**未达成项（留给合并后补做）**：
1. **真重启自启复验**未做——需先把工单 11 合入 master（master 至今尚无 `app/` 目录，工单 01–10
   同样未合），在主检出 `config.json` 填好 `autostart.appDir`，再重启核对。
2. **验收电池最终轮未全绿**：末轮 `pass=69 fail=2`。两条均为环境所致，非功能缺陷——
   「参照窗几乎被用户窗全遮（有效采样点仅 57）」与「右键未直达桌面：前台=Chrome_WidgetWin_1」，
   成因是电池运行期间桌面上有 Chromium 窗口遮挡/抢前台（采样到的 57 点命中率实为 100%）。
   对比：改动前 HEAD 末轮为 `pass=60 fail=7`，其中 4 条是本票修掉的真 bug——电池把自己的对照
   记事本铺在 `phys(1000,200) 1400x900`，正压住面板设置入口，导致设置浮层永远开不起来
   （P6 复位与 P8 开层全灭）。新增 `withControlWindowClear` 收放电池自己那一扇窗后修复。
   **最终全绿需在安静桌面下复跑**（电池跑时别开着 Chromium 窗口）。

**2026-09-27 旧栈运行态提前清理（bug 修复，非本工单验收）**

用户报告桌面偶现 WE 版残留 Listary 搜索框组件，定位为旧检出 `D:\test-folder\wallpaperengine-research` 的自启链：Startup 快捷方式 `qoder-deck-server-watchdog.lnk` → `server_watchdog.pyw`（PID 18604）→ `server.py`（PID 30612，内嵌 Tk 搜索面板窗）。已删 Startup 快捷方式并结束两进程（hermes 工具进程无关未动）；核查无计划任务/HKLM/看门狗自重建等其他复活途径。**本工单的「旧自启项移除」在运行态层面已提前完成**，代码退役（删脚本、冻结壁纸资产、Startup 改指新应用、真重启复验）仍按本工单计划执行。
