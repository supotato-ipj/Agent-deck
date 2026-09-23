# 05: dry-run / apply 首次全量编排

**What to build:** 把编排核心接到真实桌面上，交付**第一个用户可见的完整成果**：跑一条命令，桌面就从一列混杂图标变成上下两个分区。

命令默认是 **dry-run**——只打印完整编排计划（每一项的显示名、被归到哪一区、当前坐标、目标坐标），不写入任何东西。必须显式传入 apply 参数才真的落位。落位前自动完成快照（含出厂态快照的首次生成）。

编排遵循"先算完整计划、再一次性落位"，不存在算一半就写的路径。落位过程中任一项失败即中止后续写入并报告，此时桌面可能处于部分落位状态，用 02 的还原命令即可回退。

**Blocked by:** 02, 04

**Status:** ready-for-agent

- [x] 默认运行为 dry-run，只打印计划、不写入任何坐标
- [x] dry-run 输出含每项的显示名、分类、当前坐标、目标坐标，中文名正确对齐可读
- [x] 显式 apply 参数才落位
- [x] apply 前自动写运行前快照；若出厂态快照尚不存在则先生成它
- [x] 实机验证：dry-run 打印的计划与 apply 后重新读回的真实坐标一致
- [x] 实机验证：apply 后桌面呈现上部应用区（6×2）与下部文档区，回收站在左下角
- [x] 实机验证：还原命令能把桌面退回出厂态
- [x] 落位失败时中止后续写入并明确报告，不静默吞掉
- [x] 整个过程不移动、重命名或删除任何磁盘文件
- [x] 数据服务既有的 `/performance` 与 `/deck` 契约无回归

## Comments

- 2026-09-23: 由 to-tickets 创建。当前实机基线的 14 个图标项 = 回收站 1 + 快捷方式 8（用户桌面 3、公共桌面 5）+ 文档 5，首次全量编排会给全部 14 项算出目标坐标（含回收站移往左下角）。`desktop.ini` 是隐藏文件，不出现在图标清单里。
- 2026-09-23: 实施完成。产物：`zones_orchestrate.py`（dry-run 默认 / `--apply`）、`pinned.json`（手钉清单，当前为空数组）。纯函数部分 `moves_from_plan` / `verify_positions` / `plan_report` 由 `tests/test_zones_orchestrate.py` 覆盖，全套 80 测试绿。
- 2026-09-23: **apply 后读回校验立刻抓到两个真问题**（这正是 02 票要求读回的原因）：
  1. 回收站原坐标 `(13,1294)` 不在 98 晶格上，被 explorer 吸附到 `(13,1276)` → `RECYCLE_POS` 改为 1276，并新增晶格同余测试。
  2. 实机截图发现应用区首行 `(13,2)` 压住 DECK 顶栏的品牌字（顶栏 4.6rem≈74px 横跨整屏）→ `APP_ORIGIN` 下移到 `(13,100)`、`LABEL_Y` 改 330。DECK 为定稿形态不可动，只能让图标让位。spec 的几何常量已同步更新。
- 2026-09-23: 实机验收链：dry-run 打印 14 项计划 → `--apply` 落位且读回全匹配 → 桌面截图确认分区观感（应用区两行在上、文档区单列在左中、回收站左下、DECK 右栏与顶栏无遮挡）→ `restore factory` 读回与出厂快照零偏差 → 再次 apply 保持分区态。`/performance` 200、`/deck` 200 无回归。
- 2026-09-23: code-review 后修（两轴同指）：`set_position` 原先不检查 `SendMessageW` 返回值，导致"落位中途失败即中止"是死路径——现在失败抛 `DesktopViewUnavailable`，`IconView.write_moves` 统一为唯一写路径并在中途失败时抛 `WriteAborted(done, name)`，调用方据此上报"中止于第 k/N 项（名字）"；读回验证的同名项不再静默跳过，进 `ambiguous` 名单并打印（与 02 的契约一致）；apply 后的读回也包了视图不可用的保护；`load_pinned` 的无用 path 参数内联；`apply` 局部变量改名 `do_apply`；同名计数抽成 `desktop_icons.name_counts` 供 layout/orchestrate 共用；move 统一为 `(index, 显示名, x, y)` 四元组。全套 80 测试绿。
