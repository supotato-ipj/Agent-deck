# 08: 快捷入口带——顶部锁死行 + 手钉两级语义

**What to build:** 桌面顶部新增固定"快捷入口带"：一行常显应用图标，位置锁死、不参与应用区推荐竞争、任何编排（含 --apply 全量）绝不触碰其坐标。pinned.json 升级两级语义：`entryrail`（入口带钉，有序数组）与 `appzone`（原手钉语义不变）；zones_plan 编排时先扣除入口带占用再规划应用区。入口带区域与壁纸分区标签/顶栏不重叠（坐标常量进 zones_geometry）。

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

- [ ] pinned.json 两级语义解析 + 旧格式向后兼容（无 entryrail 键时行为不变）
- [ ] 编排排除：fixture 桌面断言入口带图标在任何编排（增量/全量）下坐标不变
- [ ] 坐标常量进 zones_geometry；与现有晶格/分区标签无重叠
- [ ] 实机：入口带钉 3 个应用跑 zones_orchestrate --apply 前后坐标不变，截图存证
