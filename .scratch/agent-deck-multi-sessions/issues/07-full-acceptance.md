# 07: 全链路验收

**What to build:** 五工具真实数据在壁纸上混排验收：用真实会话数据确认列表按最近活跃排序、标签正确（QD/KC/KW/ZC/HM）、状态色正确、顶栏 SESSIONS 计数为全工具总数、全空时显示待机态；验证坏源降级演练（临时改名某工具数据目录后该工具行消失、其余照常、服务不崩，恢复后自动回来）；确认 TERMINAL 02 与 `/performance` 零回归；README 反映 AGENT DECK 与多工具能力。

**Blocked by:** 02, 03, 04, 05, 06

**Status:** done

- [x] 五工具至少各一条真实会话同屏混排目测通过（排序/标签/状态色/计数）
- [x] 待机态（NO ACTIVE SESSIONS）在五工具均无活跃会话时正常显示
- [x] 坏源演练：临时移除某工具数据源→静默跳过、其余照常、恢复后回归；服务端日志有记录
- [x] `/performance` 输出与 TERMINAL 02 画面与 master 基线一致（零回归）
- [x] 数据服务重启/看门狗拉起后多工具列表正常恢复
- [x] README 更新：AGENT DECK 名称、五工具支持、各工具数据源与已知降级（kimi work 无标题）
- [x] 全部测试套件通过；spec 各条目与 ADR 0003 决策无违背

## Comments

- 2026-09-25 验收完成，证据：
  - 实机 WE 截图（.scratch/desktop.png，验收时摄）：AGENT DECK 品牌、QD RUN + ZC DONE 混排、SESSIONS 002 计数、进度列正确；五工具全标签混排另以浏览器注入真实契约数据目测（QD/HM/ZC/KC/KW 五行，状态色与排序正确）。
  - 五工具真实数据路径逐一冒烟：qoder/zcode 实时在列；hermes/zcode/kimiwork/kimicode 以 now 平移命中真实存储验证映射（kimi code 迁移目录 state.json 无 workDir 时 project 留空，优雅降级）。
  - 坏源演练走真实 HTTP 路径：影子 zcode 根（真实库副本）删除→该工具行消失且服务端日志记录、qoder 照常；恢复→回归。ZCode 进程常驻导致其真库不可安全改名，故用影子根；各扫描器缺源/坏源单测另覆盖。
  - 看门狗拉起验证：杀旧服务后 15s 内自动拉起 master 新代码，/deck 带 tool 字段、/performance 键集与基线一致。
  - 191 条测试全绿。
- 验收中发现并修复一个**既有前端 bug**（非本 feature 引入）：会话列表由空转非空时 `NO ACTIVE SESSIONS` 占位不清除；已在 index.html 修复并浏览器验证空↔非空双向转换。
- subagent 过滤（用户验收时决策）：zcode 的 `sess_subagent_*` 行不入列，见 8bbf292。
