# 06: 用量徽标与汇总块——额度主口径、可配置

**What to build:** 右栏新增 USAGE 汇总块（默认隐藏）：今日/本周 token 按 agent 分色的紧凑条 + zcode 模型分布（数据源 /usage）；会话行徽标（按 agent 逐个配置开关）：主显 5 小时窗剩余%（数据 /usage 的 quota 字段，取自票 03），<20% 转 CONFIRM 琥珀色，无额度数据的 agent 显示今日 token 次级口径；徽标关闭时不占位。配置：config.json（服务端新文件，含每 agent 徽标开关、琥珀阈值）+ 壁纸属性粗开关（USAGE 块显隐）。

**Blocked by:** 04（/usage 契约）、05（右栏槽位）

**Status:** ready-for-agent

- [ ] USAGE 块：fixture /usage 注入断言分色条与模型分布渲染；关闭时不留白
- [ ] 徽标：quota 存在显剩余%、<20% 琥珀、null 降级今日 token、再 null 不显示
- [ ] config.json 逐 agent 开关生效；壁纸属性粗开关生效
- [ ] 60s 轮询不增请求（/usage 自带缓存）；WE 实机截图存证
