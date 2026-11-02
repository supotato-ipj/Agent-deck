# 调研：MiniMax Code 会话来源与五工具状态/标题映射

- 工单：#374（spike，母 spec #369 决策 21/22/23；产出供 #376/#380/#381 会话预览垂直实现取用）
- 分支：`feat/spec369-t374-minimax-session-probe`（基点 `origin/master` = `90c6536`）
- 日期：2026-11-03
- 只查事实与可用信号，不做生产接线。接线归后续垂直工单。

## 验证口径

- **[本机实测]** = 在这台机器上跑命令 / 读工具自己的数据文件得到的结果（本节命令与输出摘要见 §5、§6）。
- **[推断]** = 由实测推出但无直接文字依据的判断，逐条标注。
- 未能核实的条目集中在 §7。本机 MiniMax Code 为浮动版本（ADR-0026 同款漂移风险），格式断言钉到观测日。

---

## 0. 结论速览

| # | 问题 | 结论 | 标签 |
|---|---|---|---|
| 1 | MiniMax Code 会话位置 | `~/.minimax`（MiniMax Code CLI 数据根；`bin/` 下 `minimax.cmd`、`mcode-tools*.cmd`）。会话主账本 `v2/sqlite/runtime-state.sqlite`（本机 263 MB、活跃 WAL）；dated 历史目录 `v2/sessions/YYYY/MM/DD/HH-MM-SS-mmm-session_<base64(session_id)>/`。旧代 `~/.minimax/sessions/mvs_*` 只剩 `workspace/` 空壳；`~/.minimax-agent-cn` 只有空 `projects/`，均无可读会话事实。 | 本机实测 |
| 2 | 会话身份 | `local_runtime_sessions.session_id`，形如 `mvs_<hex32>`（36 字符）；与 dated 目录名 `session_<base64(session_id)>` 双向可逆（实测反解一致）。 | 本机实测 |
| 3 | 标题 | `local_runtime_sessions.title` 非空 109/109——MiniMax 有真实标题信号（工具自记，未必用户命名）。 | 本机实测 |
| 4 | 项目名 | `workspace_dir` 非空 109/109，取末段即项目名；另有 `local_runtime_projects`（7 行，含 `display_name`）可作扩展源。 | 本机实测 |
| 5 | 执行信号 | **无诚实执行信号**：`status`（值域 idle/started/aborted/error）与活跃时间不相关（实测 `started` 会话 162 分钟未动、`idle` 会话反而 82 分钟新）；messages.jsonl 末条 `assistant` 带 `stopReason=toolUse` 只能配「疑似」，与 Qoder CONFIRM 同级启发式。 | 本机实测 / 推断 |
| 6 | 等待信号 | **存储层无对等 pendingPermission**：`permission.json` 是 allow/deny/ask 规则集；`local_runtime_plugin_miniapp_permission` 是插件级开关；messages.jsonl 无 permission 类记录（custom 记录实测只有 background_task_read_settlement）。MiniMax 等待 = 只能给「未知」。 | 本机实测 |
| 7 | 只读访问 | `node:sqlite` `readOnly:true` 打开活跃 WAL 库成功，探针前后库三件套（db/wal/shm）sha256+mtime 逐字节不变；文件只 readFileSync/statSync。 | 本机实测 |
| 8 | 五工具矩阵 | 见 §3。zcode 的 `session.title`（311/311 非空）与 kimicode 的 `state.json.title`（38/38 非空）是**现扫描器未读的真实标题信号**，垂直实现可补接。 | 本机实测 |

---

## 1. MiniMax Code 存储事实（本机实测，2026-11-03）

### 1.1 数据根与布局

- `~/.minimax/`：主数据根。`config.yaml`（模型/provider/permissionMode）、`bin/`（`minimax.cmd`、`mcode-tools-cn.cmd`、`mavis*`——据此认定这是 MiniMax Code CLI 的家）。
- 会话主账本：`~/.minimax/v2/sqlite/runtime-state.sqlite`（活跃 WAL：`-wal`/`-shm` 与库同时更新；本机 263 MB）。核心表 `local_runtime_sessions`：

  ```
  session_id TEXT, updated_at_ms INTEGER, agent_name TEXT, runtime TEXT, session_type TEXT,
  status TEXT, archived INTEGER, workspace_dir TEXT, project_workspace_dir TEXT,
  title TEXT, created_at_ms INTEGER, error_message TEXT, …（列更多）
  ```

- dated 历史目录：`~/.minimax/v2/sessions/YYYY/MM/DD/HH-MM-SS-mmm-session_<base64(session_id)>/`，内含：
  - `manifest.json`：`{schemaVersion:1, sessionId, createdAtMs, updatedAtMs, source:'local-runtime', layout:'v2-final-dated-session', paths:{sessionDir, ledger, display, snapshot, reports, messages}}`。注意 `paths` 里 ledger/display/snapshot/reports **常为 declared-only（文件不存在）**，实际存在的通常只有 `messages.jsonl`（部分会话另有 `reports/tool-outputs/*`）。
  - `messages.jsonl`：每行 `{message_id, turn_id, message}`；`message.role` ∈ `user | assistant | toolResult | custom`；`content` 是 `[{type:'text'|'toolCall'|'thinking', …}]`；每条带 `timestamp`（epoch 毫秒）；assistant 记录带可选 `stopReason`（实测值域 `toolUse`/`stop`）与 usage。
  - `llm-call.json`：**含 systemPrompt**，非必要不读（敏感面，垂直实现不要碰）。
- 旧代 `~/.minimax/sessions/mvs_*/`：只剩空 `workspace/` 目录，无会话事实。
- `~/.minimax-agent-cn/`：只有空 `projects/`，与 MiniMax Code 是两个产品根，无信号。

### 1.2 信号逐项判定

| 信号 | 判定 | 依据 |
|---|---|---|
| 真实标题 | **有**（工具自记） | `title` 109/109 非空；空值时探针给 `null` 降级「未命名会话」，不拿目录名顶替 |
| 项目名 | **有** | `workspace_dir` 109/109 非空，取 `path.basename` |
| 会话 ID | **有**（稳定） | `mvs_<hex32>`，36 字符；与 dated 目录名互逆 |
| 执行中 | **无诚实信号** | `status` 与活跃时间不相关（§0#5）；执行只能落「最近活跃」或显式标注的「疑似」 |
| 最近活跃 | **有** | `updated_at_ms`（DB）或 messages.jsonl 逐条 `timestamp`（更细） |
| 等待询问 | **无** | 存储层无任何 pending 类记录（§0#6）→ 只能「未知」 |
| 未知/不可用降级 | **有** | 缺库/坏库/被写方独占 → 整工具空集静默跳过（与既有扫描器同语义，ADR-0003） |

## 2. 只读访问与零修改证明

- SQLite 走与 zcode/hermes 同一接缝 `openReadOnly`（`app/src/main/scanners/sqlite.ts:8`，`readOnly:true` + `busy_timeout=500`），文件一律 `readFileSync`/`statSync`。
- **真机零修改证明（2026-11-03 实测）**：对 `runtime-state.sqlite{,-wal,-shm}` 与 3 个 dated `manifest.json` 取 sha256+mtime → 只读探针（SELECT 主账本、遍历 manifest）→ 复测，**8/8 SAME**（size/hash/mtime 逐字节不变，输出原文见 PR 评论）。
- **夹具级机制证明（随 PR 入库，长期回归）**：`tests/scanners/minimaxcode.spec.ts` 对合成夹具全树做 sha256+mtime 清单，探针前后逐字节一致；并断言 `openReadOnly` 连接执行 INSERT 即抛（readOnly 语义锁死）。

## 3. 五工具状态/标题信号矩阵

来源映射按 spec #369 决策 21：qodercn=现有 Qoder CN 扫描器；zcode/kimicode=现有只读来源（下表标 ✚ 的列是**现扫描器未读、垂直实现可补接**的信号）；minimaxcode=本票新探针；DSH=ACP 内存投影（`ConversationSessionView`，`app/src/shared/contract.ts:485`）；hermes/kimiwork 不进气泡（spec Out of Scope）。

| 工具 | 来源 | 真实标题 | 项目名 | 会话 ID | 执行中 | 最近活跃 | 等待询问 | 未知/降级 |
|---|---|---|---|---|---|---|---|---|
| qodercn | `~/.qoder-cn/projects/*/<uuid>.jsonl`（+`tasks/`） | **无**（实测 jsonl 全字段并集无 title）→ 未命名 | ✚有：jsonl `cwd`（现扫描器已读） | 有：文件名 stem | **无**明确信号 | 有：文件 mtime | **启发式 CONFIRM**（末条 assistant 带 `tool_use`）→ 只配**疑似等待** | 读失败静默跳过 |
| zcode | `~/.zcode/cli/db/db.sqlite` `session` 表 | ✚**有**：`title` 311/311 非空（`title_source`: custom/first_input/generated）——现扫描器未读 | 有：`directory` | 有：`session.id` | **无**明确信号 | 有：`time_updated` | **无**：`session.permission` 是权限模式（build/yolo）非 pending；`permission` 表按 project 且实测 0 行 → 未知 | 缺库/坏库/子代理会话排除 |
| kimicode | `~/.kimi-code/sessions/<wd_*>/<session>/state.json` | ✚**有**：`state.title` 38/38 非空 + `isCustomTitle`——现扫描器未读 | 有：`workDir` | 有：目录名 | **无**明确信号 | 有：`updatedAt` + state.json/wire.jsonl mtime | **无** → 未知 | 非对象 state.json 连累整工具跳过（现语义） |
| minimaxcode | `~/.minimax/v2/sqlite/runtime-state.sqlite`（+ dated 目录） | **有**（DB `title` 109/109） | 有：`workspace_dir` 末段 | 有：`mvs_*` | **无**明确信号（`status` 不靠谱，见 §1.2）→ 最近活跃或疑似 | 有：`updated_at_ms` / 消息 `timestamp` | **无** → 未知 | 缺库/坏库 → 空集 |
| dsh | 内存投影 `ConversationSessionView`（非文件扫描） | **有**：`label`（创建时用户命名，`contract.ts:500`） | 有：`cwd` | 有：面板会话 `id`（+`backendSessionId`） | **有（真实）**：`status='busy'`（turn 在途） | 有：transcript 逐条 `at`（仅内存） | **有（真实）**：`pendingPermission` 非 null（ACP 请求原样选项） | starting/ended/failed/status + `error` |

### Qoder 启发式 CONFIRM 与 DSH 真实 pendingPermission 的区分（票面验收第 3 条）

- **Qoder CONFIRM**（`app/src/main/scanners/qoder.ts:58` `sessionState`）：判据是「jsonl 末条 assistant 记录最后一个 content 块是 `tool_use`」——它只说明**工具调用发起后尚未见到后续记录**，等待的对象可能是用户确认、也可能是工具自身执行，存储层不区分。**只能显示「疑似等待」**（spec 决策 22 明文：RUN/CONFIRM 不得直接等同执行中/等待询问）。
- **DSH pendingPermission**（`app/src/main/conversation/service.ts:812`，`contract.ts:523`）：ACP 后端发来的真实权限请求（`session/request_permission` 原样选项），null=无，绝不超时自动拒绝。**可显示「等待询问」**。
- 两者在投影层必须走不同状态值（疑似等待 vs 等待询问），不得共用一个「等待」标签；minimaxcode/zcode/kimicode 的等待一律「未知」。

## 4. 输入契约（给 #376/#380/#381 的垂直实现）

随本 PR 入库的探针接缝（`app/src/main/scanners/minimaxcode.ts`，**未注册进 SCANNERS**——生产接线归垂直工单）：

```ts
interface MinimaxSessionProbe {
  id: string                    // DB session_id（mvs_*，稳定身份）
  title: string | null          // 工具自记标题；空/缺 → null（UI 显示「未命名会话」）
  project: string | null        // workspace_dir 末段；缺 → null
  lastActivityMs: number | null // DB updated_at_ms（epoch 毫秒）
  status: string | null         // DB status 原样透传——不是执行信号，只作诊断
}
probeMinimaxSessions(root: '~/.minimax 形态数据根'): MinimaxSessionProbe[]   // 最近活跃降序，失败空集
probeMinimaxTail(messagesJsonlPath): { lastRole, lastStopReason, suspectedPendingTool }  // 疑似执行启发式，只配「疑似」
minimaxHistoryDirName(sessionId): string                                     // session_<base64(id)>
```

- 夹具：`tests/scanners/fixtures.ts` 的 `MinimaxFx`（合成 sqlite + dated 目录两件套，确定性、零真实内容），`tests/scanners/minimaxcode.spec.ts` 9 用例锁定格式与只读性。
- 状态投影规则（spec 决策 22/23 落地口径）：
  1. 只有 DSH `status='busy'` 可显示「执行中」；mtime/updated_at_ms 一律「最近活跃」。
  2. 只有 DSH `pendingPermission` 可显示「等待询问」；Qoder CONFIRM 显示「疑似等待」；其余工具等待一律「未知」。
  3. 标题三列分展：真实标题缺 → 「未命名会话」；项目名与短 ID 作次级信息；工具源不可读 → 该工具卡片消失（空工具不占位）。
  4. 会话唯一键必须带工具前缀（tool + id，ADR-0003 后果第 4 条）。
- 活跃窗沿用 90 秒 RUNNING / 10 分钟活跃池（`types.ts`）——minimaxcode `updated_at_ms` 直接可比。

## 5. 关键实测命令（摘要）

```powershell
# 表结构与值域（node:sqlite readOnly）
node -e "new (require('node:sqlite').DatabaseSync)('C:/Users/An W/.minimax/v2/sqlite/runtime-state.sqlite',{readOnly:true})
  .prepare('SELECT status, COUNT(*) c FROM local_runtime_sessions GROUP BY status').all()"
# → [{"status":"aborted","c":3},{"status":"error","c":3},{"status":"idle","c":101},{"status":"started","c":2}]

node -e "… SELECT COUNT(*) c, SUM(title<>'') FROM local_runtime_sessions"      # → 109 / 109
node -e "… SELECT (strftime('%s','now')*1000-updated_at_ms)/60000 age_min, status …"  # → started@162min、idle@82min（status≠活跃）

# 零修改证明：hash+mtime 前后比对 → 8/8 SAME（db/wal/shm + 3×manifest）
```

## 6. 局限

- 观测窗口内没有正在执行的 MiniMax 会话（`started` 仅 2 例且都不新鲜），「执行中判定为何不可信」的结论基于 status 与活跃时间的相关性缺失（§0#5），不是对运行态的全相空间采样。
- 本机未观察到任何 pending 权限记录；不能排除 MiniMax 权限询问只存在于进程内存/其他通道——按「存储层无信号」处理，若日后发现新存储再补探针。
- `runtime-state.sqlite` 列集与值域随 MiniMax 浮动版本漂移（同 ADR-0026 风险），fixture 只锁探针读取的列。

## 7. 未证实项（垂直实现开工前须知）

1. `status='started'` 的确切语义（上游文档不可得）——不得用作执行信号，除非后续拿到反向证据。
2. messages.jsonl `timestamp` 的时区/单调性未做全量核验（抽样为 epoch 毫秒、随序递增）；垂直实现若按条级时间算活跃，先加大样本校验。
3. `manifest.paths` 里 ledger/display/snapshot 何时落盘未证实（观测窗口内 declared-only）；不要为拿标题去等这些文件。
4. title 的生成方（用户命名 vs 工具自动摘要）未区分——UI 侧一律当「工具自记标题」呈现，不声称用户命名。
5. 多实例/多 profile 场景下 `~/.minimax` 是否唯一根未证实（本机单根）。
