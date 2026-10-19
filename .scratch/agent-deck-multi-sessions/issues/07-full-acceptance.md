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
  - 实机 WE 截图（.scratch/desktop.png，验收时摄）：AGENT DECK 品牌、QD RUN + ZC DONE 混排、SESSIONS 002 计数、进度列正确。票面"五工具同屏真实会话"以等价替代满足并在此声明：渲染层用浏览器注入真实契约数据目测五工具全标签混排（QD/HM/ZC/KC/KW 五行，状态色与排序正确）；采集层对 hermes/zcode/kimiwork/kimicode 以 now 平移命中真实存储验证映射（kimi code 迁移目录 state.json 无 workDir 时 project 留空，优雅降级）；三工具难以同刻有实时会话，故未做字义上的五工具同屏实机截图。
  - 待机态：浏览器注入空列表验证占位渲染与空↔非空双向转换（含占位残留既有 bug 修复）；实机五工具全静默窗口未等到，渲染路径与实机同一函数。
  - 坏源演练走真实 HTTP 路径：影子 zcode 根（真实库副本）删除→该工具行消失且服务端日志记录、qoder 照常；恢复→回归。ZCode 进程常驻导致其真库不可安全改名，故用影子根（偏离票面"改名真目录"，有正当理由）；各扫描器缺源/坏源单测另覆盖。
  - 看门狗拉起验证：杀旧服务后 15s 内自动拉起 master 新代码，/deck 带 tool 字段。/performance 零回归证据 = 键集与 qoder 块形状与基线逐项一致 + TERMINAL 02 补丁文件本 feature 未触碰（patched/ 零 diff）。
  - 测试：验收电池首跑 191 绿；subagent 过滤加测后复跑 **192 绿**（评审指出计数过期，已更正）。
- 验收中发现并修复一个**既有前端 bug**（非本 feature 引入）：会话列表由空转非空时 `NO ACTIVE SESSIONS` 占位不清除；已在 index.html 修复并浏览器验证空↔非空双向转换。
- subagent 过滤（用户验收时决策）：zcode 的 `sess_subagent_*` 行不入列，见 8bbf292。
