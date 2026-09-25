# 02: DSH scanner——第八工具状态接入

**What to build:** agent_sessions 新增 dsh 扫描器：先写一个只读探针脚本摸清 `~/.dsh/sessions/` 的会话存储结构（目录布局、状态文件、mtime 语义、是否有 title/project 可取、subagent 会话特征），再按探针结论实现扫描器：会话行进混排（标签 DH、四态判定、project/title 尽最大可得），subagent/内部会话若噪音过大则按 ZCODE_SUBAGENT_PREFIX 先例排除并在票面记录规则。注意区分开源 harness（dsh CLI）与桌面端（@deepseek-ai/dsh-desktop）的会话归属，避免同会话双计。

**Blocked by:** None（可立即开工；探针先行）

**Status:** done

- [x] 探针结论记录在本票 Comments（目录结构、关键字段、样例脱敏摘录）
- [x] 扫描器实现：fixture 临时目录断言 DH 标签、四态、title/project 可得性
- [x] 双源去重或归属规则明确（harness vs desktop 不双计）
- [x] 坏源静默跳过；SESSION_ROOTS 增加 dsh 根
- [x] 全部测试通过；README 表格更新（八工具）

## Comments

**2026-09-25 实现完成（done）**

- 探针结论：`~/.dsh/sessions/<workspace-slug>/session-<uuid>/session.v3.jsonl.zstd`
  （zstd 压缩 jsonl；本机 83 个）。首行 session meta：id/createdAt(ms)/cwd/
  delegationDepth/agentPreset。记录类型：assistant/message（content 块含 reasoning
  与 text）、user/message（content 块 text）、tool/call、tool/result、step/*、
  session/end-seed、session-log-deepseek/delivery-accepted。
- 四态：mtime 定 RUN 窗；倒扫 tool/call 为最新动作→CONFIRM（更早 message 只供预览），
  assistant/message→DONE、user/message→IDLE。preview 取最近 text 块（reasoning 不用），
  截断 100 字。
- 子会话：delegationDepth>0 排除（对齐 zcode subagent 先例）。
- project：meta.cwd 尾段，缺失退 workspace slug 尾段。
- token：会话记录无计量字段（delivery-accepted 亦无）——/usage 的 dsh 维持 null，
  额度走票 03 的 balance/订阅端点。
- 归属：~/.dsh 即 harness/desktop 共享根（桌面端与 CLI 同一存储），无双计问题。
- 依赖：zstandard 惰性导入，缺失时整工具静默空。requirements.txt 已加。
- 真机：宽窗 2 会话，中文 preview 原文与 CONFIRM 判定正确。
