# 调研：后端 agent harness 可行性（DeepSeek 及三家 ACP 能力差）

工单 #67 · wayfinder:research · 2026-10-05/06 · 分支 `research/backend-agent-harness`

纯事实调研，不做决策。标注口径：**VERIFIED(本机)** = 在这台 Windows 机上实测/读了本地二进制、源码或配置；**VERIFIED(文档)** = 来自官方一手仓库/文档，但未在本机跑通；**NOT FOUND** / **UNCLEAR** 照字面。文档与本机现实冲突时，以本机现实为准并注明。

## TL;DR

| 候选 | 无头 spawn | 一次性 prompt | 长驻 stdio 协议 | MCP 注册 | 判定 |
|---|---|---|---|---|---|
| **DeepSeek Harness (dsh)** 官方 | ✅ `npx @deepseek-ai/dsh` | ✅ `--profile headless` + `--json` | ✅ 标准 ACP v1（`--profile acp`）+ 私有 SDK JSON-RPC（`--profile sdk`） | ✅ stdio / streamable-http | 存在且四项全满足，VERIFIED(文档)；本机未安装未实测；developer preview（v0.2.1-alpha.1，官方声明会有破坏性变更） |
| **Kimi Code** | ✅ 已实测 | ✅ 已实测 stream-json | ✅ `kimi acp` = 真 ACP（含 unstable 扩展） | ✅ stdio/http/sse + headers | VERIFIED(本机) |
| **zcode** | ⚠️ 可 spawn，但本机状态坏（见 §3.2） | ✅（契约来自 bundle 字符串） | ⚠️ `app-server` = 私有 "ZCode Protocol"，**非 ACP** | ✅ stdio/http/sse + headers/oauth | VERIFIED(本机字符串) |
| **hermes** | ✅ 已实测 | ✅ 已实测 stream-json | ✅ `hermes-acp` = 真 ACP（官方 Python SDK 0.9.0） | ✅ stdio/http/sse + OAuth；ACP 可按会话注入 | VERIFIED(本机) |

协议问题的答案：**ACP 是同一套（Zed 发起的 Agent Client Protocol，JSON-RPC 2.0，stable protocolVersion=1），kimi 与 hermes 都是货真价实的 ACP server；zcode app-server 是私有协议，不是 ACP 方言。** 若 deck 走 ACP，公共分母覆盖 kimi/hermes/dsh 三家；zcode 只能单独适配或只用一次性模式。

---

## 1. DeepSeek harness 是否存在 — VERIFIED(文档)：存在，官方出品

前序探查确认本机无任何 DeepSeek CLI（PATH、npm global、`%LOCALAPPDATA%\Programs`、`~/.deepseek*` 均无）——该结论仍成立。但外部调研发现 **DeepSeek 官方已于 2026-08 开源了自己的 agent harness**：

- 仓库 `deepseek-ai/deepseek-harness`（GitHub 官方 org，MIT，创建于 2026-08-13，主页 deepseek.com/harness，★24 万+，最新 release `dsh-v0.2.1-alpha.1` 2026-10-03）。npm 包 `@deepseek-ai/dsh`，bin 名 `dsh`。
- 口号 "Everything is a Plugin"，构建于 **Cordis**（`@deepseek-ai/cordis`，设计论文 arXiv:2608.25512）。**与本仓库 ADR 0004（electron-cordis-standalone-panel）同框架谱系**——对 deck 是潜在协同事实。
- 官方定位：**developer preview，迭代快，明确警告会有兼容性破坏变更**（README）。另有 Desktop（Electron，profile 名 `desktop` 被 CLI 保留）与 Web UI（`dsh web`，默认 127.0.0.1:3080）。

### 入口模式（apps/cli/README.md，VERIFIED(文档)）

| 命令 | 用途 |
|---|---|
| `dsh --profile headless "job"` | 一次性：跑一个全新持久化 session，打印最终回答后退出 |
| `dsh --profile acp` | **标准 ACP stdio server**，服务自动化客户端直到断连 |
| `dsh --profile sdk` / `sdk-minimal` | 私有 JSON-RPC stdio SDK server |
| `dsh web` / `dsh <name>` | Web profile / 自定义 profile（`$DSH_HOME/profiles/<name>`） |

调用目录即默认 workspace root。`web/headless/sdk/sdk-minimal/acp` profile 首次使用自动从模板初始化。

### headless 一次性契约（.agents/notes 2026-09-09，implemented）

`dsh --profile headless [--json] [--session-id <id>] [<task>... | -]`

- 默认：stdout 只有一条最终 assistant 文本，reasoning 走 stderr；**exit 0 当且仅当终局 turn/end reason=completed**。
- `--json`：stdout 改为 NDJSON 运行事件，stderr 只剩 `dsh:` 诊断。事件表：
  - `session`（首行：sessionId, cwd）→ `status`（phase=turn_start|step_start|step_end|turn_end，turn/step/usage/reason）→ `text` / `thinking`（committed block，非 token delta）→ `tool_call`（callId, tool, input）/ `tool_result`（callId, status, result）→ `error`（turn 外失败）→ `final`（末行，无损全文，唯一不设上限的事件）。
  - 字符串/键上限 8KiB、单行上限 32KiB，截断带 `truncated:true`。
- 会话续接：无 `--session-id` 时自铸 `session-<uuid>` 并在首事件回报；`--session-id <id>` 是 **adopt-only**（日志不存在则 exit 1，绝不静默开新会话）；cwd 与会话记录不一致、preset/subagent/fork 会话、已有活进程占用同 id，均 exit 1。
- task 可从 stdin 传入（规避 ARG_MAX 与进程列表泄露）。无 per-run `--model`（明确 out of scope）。冷启动（官方 note 实测）：warm ~0.45s / cold ~1.2s。
- 预算/超时：文档未见 `--max-turns`/`--run-budget` 对等 flag（NOT FOUND）；`toolCallTimeoutMs` 只管 MCP 工具调用（默认 60s）。

### dsh 的 ACP（.agents/notes 2026-07-23 + 2026-08-22，implemented）

- 用 `@agentclientprotocol/sdk` 1.4 实现 **标准 ACP v1 自动化子集**：`session/new`、`session/list`、`session/resume`、`session/close`、`session/prompt`、`session/cancel`、`session/set_config_option`、JSON-RPC `$/cancel_request`、`session/update`、`session/request_permission`。**不加任何私有方法/能力位/_meta**。
- 明确不支持：`session/load`、delete、fork、additionalDirectories、SSE 与 ACP-transport 的 MCP、modes、commands、plans、terminals、client FS 操作、elicitation。
- 定位是 "automation-only protocol"：给外部 agent/自动化控制器用（其进程外 subagent 后端 `dsh-subagent-acp` 就走这条协议），刻意不做编辑器 UI；update 只发 committed 语义事实（无 token delta）。每 session 一个在飞 prompt。
- `session/new`/`session/resume` 请求可携带 **stdio/HTTP MCP 挂载声明**——即 ACP 客户端可按会话喂 MCP，无需改配置文件。

### dsh 的 MCP（.agents/notes 2026-07-07，implemented）

`@deepseek-ai/dsh-mcp-client` 用官方 `@modelcontextprotocol/client`（StdioClientTransport + StreamableHTTPClientTransport）。配置为 cordis.yml 里每 server 一个插件实例，扁平判别联合：

- `transport:"stdio"`：serverName（本地命名空间，必填）、command、args、env、cwd、toolCallTimeoutMs（默认 60000）
- `transport:"streamable-http"`：serverName、url、headers（可放鉴权）、toolCallTimeoutMs
- **无 SSE transport**。仅 client 侧（无 MCP server 实现）；resources/instructions 支持，prompt templates 不支持。

### 判定

DeepSeek 官方 harness **存在**且四项判据（无头 spawn / 一次性 / 长驻 stdio / MCP）在文档层面全部满足，且其长驻协议就是标准 ACP v1——与 kimi/hermes 同协议。风险事实：developer preview + 官方明示破坏性变更 + 本机未安装未实测（Node 版本要求、Windows 兼容性、provider/API key 配置均未验证）。**不是**「与 Qoder、Kimi Work 同类的不可用后端」。

## 2. ACP 是一套还是三套 — VERIFIED(本机)：一套 ACP（kimi、hermes）+ 一套私有（zcode）

### 2.1 ACP 规范本体（VERIFIED(文档)：zed-industries/agent-client-protocol README + agentclientprotocol.com）

- 发起/维护：Zed Industries（现独立 org `agentclientprotocol`，有 Rust crate、TS SDK、Python SDK）。JSON-RPC 2.0，典型 transport 是 stdio。**当前 stable protocolVersion = 1**，在 `initialize` 里交换；仓库同时发布 schema/v1 与 schema/v2 工件。
- 生命周期：client 发起 `initialize`（protocolVersion、clientCapabilities{fs, terminal}、agentCapabilities{loadSession, promptCapabilities, mcpCapabilities{http,sse}}）→ 可选 `authenticate` → `session/new`（**mcpServers 为必填参数**：stdio=command/args/env，http/sse=url/headers）→ `session/prompt`。
- 流式：agent→client 单向通知 `session/update`，变体含 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan` 等。
- 取消：client 发 `session/cancel` 通知；agent 中止工作并让原 `session/prompt` 请求以 `stopReason:"cancelled"` 落定。
- 工具往返：agent 自己执行工具；若 client 声明能力，agent 可反向调用 client 的 `fs/read_text_file`、`fs/write_text_file`、`terminal/*`；执行前经 `session/request_permission` 拿授权。

### 2.2 kimi — 真 ACP，覆盖面最大（VERIFIED(本机)：kimi.exe v0.27.0 二进制字符串 + --help）

- `kimi acp` 自述 "Run kimi-code as an Agent Client Protocol (ACP) server over stdio"；`--login` 提供 device-code 登录（ACP terminal-auth 入口）。
- 二进制内含全部核心 wire 方法：`session/new`(x6)、`session/prompt`(x10)、`session/cancel`(x10)、`session/update`(x11)、`session/load`(x7)、`session/request_permission`(x3)、`fs/read_text_file`、`fs/write_text_file`、`terminal/create`(x2)。
- 另含 50 处 `unstable_*` 扩展：`unstable_setSessionModel`、`unstable_forkSession`、`unstable_deleteSession`、`unstable_listProviders/setProvider/disableProvider`、NES 下一编辑建议（`unstable_startNes/suggestNes/acceptNes/rejectNes/closeNes`）、文档同步（`unstable_didOpen/didChange/didSave/didFocus/didCloseDocument`）、`unstable_createElicitation/completeElicitation`——即面向 Zed 类编辑器的 ACP unstable 扩展面。
- 本体是 Node SEA（内含 commander、`@modelcontextprotocol/sdk` TS 客户端，含 streamableHttp/sse）。

### 2.3 hermes — 真 ACP，官方 Python SDK（VERIFIED(本机)：源码 + --check 实测）

- `hermes-acp.exe`（v0.21.4）是薄启动器；真身在 `%LOCALAPPDATA%\hermes\hermes-agent\acp_adapter\*.py`，依赖 **`agent-client-protocol` 0.9.0**（venv dist-info 自述 "A Python implement of Agent Client Protocol (ACP, by Zed Industries)"，`acp/meta.py: PROTOCOL_VERSION = 1`）。
- 适配器实现：`initialize`、`authenticate`（terminal auth → `hermes-acp --setup`）、`new_session`（**接收 mcpServers: McpServerStdio|McpServerHttp|McpServerSse，按会话挂载 MCP**）、`load_session`、`resume_session`、`fork_session`、`list_sessions`、`cancel`、`prompt`；流式经 `session/update`（agent_message_chunk / thought / tool call start+complete / usage / mode / model state）；`session/request_permission` 用于工具与编辑审批（permissions.py、edit_approval.py）；还注册 slash commands（availableCommands）。
- wire 方法集（acp/schema.py 字符串）：`session/new|prompt|update|cancel|load|close|fork|list|resume|request_permission|set_mode|set_model|set_config_option`、`fs/read_text_file`、`fs/write_text_file`、`terminal/create|output|kill|release|wait_for_exit`。hermes 的工具在自身进程执行，不回调 client fs/terminal。
- 自检：`hermes-acp --check` 本机实测输出 "Hermes ACP check OK"，exit 0。
- SDK 的 router 有 unstable 门控（`use_unstable_protocol`），resume/fork/list/close/set_* 属扩展面。

### 2.4 zcode — 私有 "ZCode Protocol"，非 ACP（VERIFIED(本机)：zcode.cjs 0.16.9 bundle 字符串）

- 自述常量："ZCode Protocol"（x55），协议版本常量 =1；错误码 `sessionUnavailable:-32004`（JSON-RPC 风格负码）。
- **握手不是 ACP 的 initialize**，而是自有信封：server→client `{kind:"hello", protocolVersion:1, connectionId, clientMode:"desktop-continuous"|…}`，client→server `{kind:"clientHello", protocolVersion:1, clientId, clientKind:"desktop"|"web"|"mobileRemote"…}`，另有 deliveryProfile 匹配约束与 `startup/storagePath|storagePrepared|storageState` 启动序列。
- 方法表（bundle 内完整枚举）：`runtime/capabilities`；`session/create|resume|list|read|messages|events|debug|subscribe|send|stop|cancelBackgroundTask|fork|compact|goal|close|setModel|setThoughtLevel|setMode|subagents|requestRuntimePreferences|usage`；`mcp/list`；`workspace/*`、`provider/*`、`plugins/*`、`workflows/*`、`automation/*`、`offPeak/*`、`usage/stats`、`process/childProcesses`。
- server→client 反向请求：`interaction/requestPermission`、`interaction/requestUserInput`、`interaction/requestProviderRuntimeHeaders`、`interaction/requestOfficialMcpAuthHeaders`、`interaction/browserList|browserExecute`、`computer-use/operation-event`。
- **不含任何 ACP 核心方法名**（无 session/new、session/prompt、session/update、session/cancel、fs/*、session/request_permission；bundle 里孤立的 "session/new 超时"、"opencode runtime crashed"、"bun has crashed" 只是错误文案分类字符串）→ 不是 ACP 实现也不是方言。opencode/Bun 字样暗示运行时谱系与 opencode（SST）相关，但协议面独立。
- 背景（VERIFIED(文档)）：ZCode 是智谱 Z.ai 的三端（桌面/浏览器/终端）AI 编程工作台，2026-09 下旬开源（v3.14.4，与本机 `~/.zcode/v2/runtime/provider/.../3.14.4` 对上）；开源前有「静默上传」争议报道。

### 2.5 四维对比（全部 VERIFIED(本机)）

| 维度 | kimi acp | hermes-acp | zcode app-server |
|---|---|---|---|
| 服务端反向发起 | `fs/read_text_file`、`fs/write_text_file`、`terminal/create`、`session/request_permission` | `session/request_permission`（工具+编辑审批）、terminal-auth `authenticate`；不回调 client fs/terminal | `interaction/requestPermission`、`requestUserInput`、`requestProviderRuntimeHeaders`、`requestOfficialMcpAuthHeaders`、`browserExecute` |
| 增量流式 | `session/update`：agent_message_chunk / thought / tool_call(_update) 等（ACP 标准） | 同左（ACP 标准）+ usage/mode/model 状态更新 | `session/events` + `session/subscribe` 私有事件流（含流式 tool-input delta，env `ZCODE_ACTIVE_STREAMING_TOOL_INPUT_*` 可调） |
| 中途取消 | `session/cancel` → stopReason:cancelled | `session/cancel`（adapter cancel()） | `session/stop`（turn 级）+ `session/cancelBackgroundTask`（后台任务级） |
| 续接既有会话 | `session/load` + `unstable_forkSession`/`unstable_deleteSession`；一次性侧 `-S/-c` | `session/load` + `resume/fork/list`（SDK 扩展）；一次性侧 `--resume/-c/--create-if-missing` | `session/resume` + `session/list`；一次性侧 `--resume <sess_…>/-c` |

## 3. 一次性模式输出契约

### 3.1 kimi — VERIFIED(本机实测，两次成功运行)

`kimi -p "<task>" --output-format stream-json`（空临时目录，v0.27.0）：

```json
{"role":"assistant","content":"OK"}
{"role":"meta","type":"session.resume_hint","session_id":"session_b7fc157a-…","command":"kimi -r session_b7fc157a-…","content":"To resume this session: …"}
```

带工具调用的运行（实测触发 Bash 工具）追加两类事件（OpenAI 风格）：

```json
{"role":"assistant","tool_calls":[{"type":"function","id":"tool_…","function":{"name":"Bash","arguments":"{\"command\":\"…\"}"}}]}
{"role":"tool","tool_call_id":"tool_…","content":"<工具输出，失败时含 Command failed with exit code: N>"}
```

- **退出码**：0=跑完（工具失败不改退出码，失败信息在 tool 事件里）；1=用法错误（实测 `-p` 与 `--yolo` 互斥：`error: Cannot combine --prompt with --yolo`，exit 1）。
- **无增量 delta**：实测 assistant 文本按整块消息出现（每 turn 一条），非 token 级流。
- **预算/超时**：无 `--max-turns`/`--run-budget` 对等 flag（--help 全文核对，NOT FOUND）。权限面替代物：`--plan`（只读规划）、`--auto`（auto permission mode）；实测非 TTY 的 `-p` 模式下 Bash 工具未经审批直接执行。
- **续接**：`-S/--session [id]`、`-c/--continue`；实测流尾 `session.resume_hint` 给出 `session_<uuid>` 与 `kimi -r <id>` 命令。

### 3.2 zcode — VERIFIED(本机 bundle 字符串)；实测未完成（本机状态坏，以此为准）

`zcode -p "<task>" --json`：stdout **恰好写一个**终端 JSON（bundle 中唯一的 stdout.write(JSON.stringify({type:"result"…})) ；无增量 JSONL）：

```json
{"type":"result","sessionId":"sess_…","traceId":"…","turnId":"…","response":"<最终文本>",
 "turnResponses":["…"],"usage":{"…":0,"cacheReadTokens":0},
 "eventCount":0,
 "projection":{"status":"…","turnCount":0,"totalTokenCount":0,"contextUsed":null,"contextWindow":null},
 "resultType":"success"}
```

- `resultType` 枚举（zod schema 原文）：`success | cancelled | error_max_turns | error_max_budget | error_during_execution | error_max_tool_calls`。
- **预算**：无 CLI flag；运行时配置有 `maxTurns`（profile.maxTurns / runtimeConfig.maxTurns / subagents.maxTurns 默认 4），与 error_max_turns / error_max_budget / error_max_tool_calls 结果类型呼应；`--disallowed-tools "Bash Edit"` 可裁工具面；`--mode build|edit|plan|yolo` 控权限。
- **续接**：`--resume <sess_…>`、`-c/--continue`；session id 形如 `sess_<uuid>`。
- **实测失败记录（本机现实与前序探查不一致）**：
  1. `node "C:\Program Files\ZCode\resources\glm\zcode.cjs" -p …` → `无法定位 CLI ZCode Built-in Provider Config`，exit 1。bundle 逻辑：找 `<dirname(entrypoint)>/provider/zcode-builtin.json` 与 `<上五级>/config/provider/zcode-builtin.json`；实际文件在 `C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json`（Electron 布局对不上裸 node 调用）。**解法（本机验证到第二关）**：设 env `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=C:\Program Files\ZCode\resources\config\provider\zcode-builtin.json`（bundle 内确有此 env 名）。
  2. 之后失败于 `Error: Model creation failed`，exit 1，仅 stderr；日志根因 `Select a model before continuing`（CONFIGURATION_ERROR）——`~/.zcode/cli/config.json` 只有 plugins+mcp，模型选择在桌面端 `~/.zcode/v2/setting.json`（bigmodel oauth coding-plan）。失败运行仍完成了启动序列：session `sess_…` 已建、**8 个已配置 MCP server 启动即连（790ms）**、事件已持久化。
  - 对 spawn 集成的含义：zcode 无头跑通需要 env override + CLI 侧登录/选模型的前置状态；前序探查记录的 `node zcode.cjs -p --json 可用` 在当前本机状态下复现失败。

### 3.3 hermes — VERIFIED(本机实测 + 源码 hermes_cli/stream_json.py)

`hermes chat -q "<task>" --oneshot --format stream-json`（实测 exit 0，事件与源码契约完全一致）：

```json
{"type": "system", "subtype": "init", "model": "glm-5.3-flash", "session_id": "20261005_231642_ff912c", "timestamp": 1791213402904}
{"type": "text", "text": "OK", "timestamp": 1791213459801}
{"type": "result", "session_id": "…", "exit_code": 0, "text": "OK",
 "tokens": {"input": 7252, "output": 3, "total": 7255, "cache_read": 0, "cache_write": 0},
 "duration_ms": 57374, "timestamp": 1791213460278}
```

- 事件表（源码）：`system/init` → `text`（增量 delta，逐条 flush）→ `tool_use`（name, tool_call_id?, input）/ `tool_result`（name, output 截 5000 字符, duration_ms, is_error）→ 唯一终局 `result`（session_id, **exit_code**, text, tokens{input,output,total,cache_read,cache_write}, duration_ms, error?）。每行都带 `timestamp`。
- **退出码**：进程 exit code = result.exit_code（run 失败→1）；session_id 同步打在 stderr；诊断只走 stderr（stdout 纯 JSONL）。
- **预算**：`--max-turns N`（默认 500，config agent.max_turns）；`--run-budget SECONDS`（80% 时给 agent 一次性收尾提醒，provider stale timeout 被裁到剩余预算；config agent.run_budget_seconds）。三家中唯一有墙钟预算的。
- **续接**：`--resume <id|latest>`、`-c/--continue [name]`、`--create-if-missing`（「发往命名线程、没有就建」——对话窗场景现成语义）、`--in DIR`、`--no-restore-cwd`。session id 形如 `YYYYMMDD_HHMMSS_xxxxxx`。
- **嵌入方专用开关**：`--source tool`（第三方集成会话不进用户会话列表）、`--ignore-user-config`、`--ignore-rules`、`--safe-mode`（连 MCP 都禁掉）、`--query-file -`（stdin 传 prompt，免 shell 转义）、`--accept-hooks`。
- 用法错误（如 stream-json 无 query / 配 --tui）exit 2（源码 SystemExit(2)）。

## 4. 能否被喂一个 MCP server

### 4.1 kimi — VERIFIED(本机)

- 用户级 `~/.kimi-code/mcp.json`：`{"mcpServers":{name:{command,args[,env]}}}`（本机实文件：codebase-memory-mcp，stdio）。bundle 内 skill 文本明确 kimi 还读**当前工作目录**的 mcp.json（项目级）。
- transport：二进制含 `transport: literal("sse")`、`config.transport === "http" || "sse"`、`SseMcpClient`、`url`/`headers` 字段、官方 `@modelcontextprotocol/sdk` 的 streamableHttp+sse 客户端 → **stdio / http / sse 都支持**，http/sse 有 `headers`（可放鉴权）。
- 自检：`kimi doctor` 实测只验 config.toml / tui.toml（help 原文），**无 mcp list/test 类命令**（NOT FOUND）；doctor 是否覆盖 mcp.json UNCLEAR。
- 生效时机：进程启动时读取。长驻 `kimi acp` 改配置是否热加载 UNCLEAR（未见证据），保守按「需重启」设计。

### 4.2 zcode — VERIFIED(本机)

- `~/.zcode/cli/config.json` → `{"mcp":{"servers":{name:{…}}}}`（本机实文件）。bundle schema：`type:"stdio"`（command/args/env/timeoutMs）或 `type:"http"|"sse"`（url、headers、`oauth?`、`enabled?`）；另有 websocket 枚举与 legacy `http_headers`→`headers` 迁移逻辑。
- 自检/管理：TUI 内 `/mcp list|status|connect|disconnect`（**会话内动态连断，无需整进程重启**）；app-server 协议有 `mcp/list` 方法；实测日志显示 headless 启动即连全部已配置 server（8 个，790ms，含 `plugin:` 前缀的插件自带 MCP）。
- 鉴权：官方 MCP 的 auth headers 走 server→client 请求 `interaction/requestOfficialMcpAuthHeaders`；`~/.zcode/v2/mcp-oauth-*.authz.lock` 表明有 OAuth 授权流。
- CLI 侧无 `zcode mcp …` 子命令（命令表核对，NOT FOUND）。

### 4.3 hermes — VERIFIED(本机)

- `%LOCALAPPDATA%\hermes\config.yaml` → `mcp_servers:`（本机实文件：codebase-memory-mcp command 形态）。
- transport：`tools/mcp_tool.py` 动态 import 官方 Python MCP SDK 的 `stdio_client` / `streamablehttp_client`（含 legacy 别名 `streamable_http_client`）/ `sse_client` → **stdio / streamable-http / sse 全支持**；SSE 不可用时降级禁用并给诊断。
- 鉴权：headers（Authorization / X-Api-Key 等，日志与探测输出自动脱敏）、env 变量引用、OAuth（`hermes mcp login` / `hermes mcp reauth --all`）。
- **自检命令三家最全**：`hermes mcp list|test|add|remove|configure|catalog|install`（实测 help），`test`=连通性测试，`catalog`=Nous 认可目录一键装；还有 `hermes mcp serve` 反向把 hermes 会话暴露成 MCP server。
- **ACP 专属通道**：`session/new` 请求可携带 mcpServers（McpServerStdio|Http|Sse，acp_adapter/server.py `_register_session_mcp_servers`）→ **deck 可以按会话注入 MCP，完全不改配置文件**；适配器还有 MCP late-refresh 调度（`_schedule_mcp_late_refresh`）。
- 生效时机：config.yaml 启动读取；热重载未见证据（UNCLEAR），但 ACP 按会话注入使该问题对 deck 不重要。

### 4.4 dsh — VERIFIED(文档)

cordis.yml 插件实例配置（stdio / streamable-http，无 SSE，见 §1）；ACP `session/new`/`session/resume` 可携带 stdio/HTTP MCP 挂载声明。

## 5. 决策输入（事实汇总，不做决策）

- 可 spawn 后端从三家变四家：kimi（ACP+一次性）、hermes（ACP+一次性）、zcode（私有协议+一次性）、**dsh（标准 ACP v1 + 一次性 NDJSON + 私有 SDK JSON-RPC，需先安装）**。Qoder、Kimi Work 维持不可用。
- 协议公共分母 = ACP v1：kimi acp、hermes-acp、dsh --profile acp 三家同协议；zcode 是唯一私有协议（支持它需独立适配或只用一次性模式）。
- 三套 ACP 的能力面不同：kimi 覆盖最广（fs/terminal 回调 + unstable 扩展），hermes 次之（permission 回调 + resume/fork/list 扩展 + 按会话 MCP 注入），dsh 最窄但最纯粹（标准 v1 自动化子集，无私有扩展，committed 语义无 token delta）。
- 一次性模式成熟度：hermes 对嵌入方最友好（--source tool、--ignore-user-config、--create-if-missing、--run-budget、exit_code 内嵌于 result 事件）；kimi 契约最简（role 风格 JSONL + resume_hint，无预算控制）；zcode 只有单个终局 result JSON（有 resultType 枚举与 usage/projection，但本机当前跑不通，需 env override + 模型选择前置）。
- dsh 风险：developer preview、官方明示破坏性变更、本机未实测。Cordis 同源（`@deepseek-ai/cordis` vs 本仓库 ADR 0004）是潜在协同点。
- zcode 风险背景：开源前「静默上传」争议报道；CLI 裸 node 调用与 Electron 安装布局脱节（provider config 路径），spawn 集成需带 env。

## 证据与来源

本机实测（2026-10-05，全部在 `%TEMP%\harness-probe` 空目录，短超时，未启动任何交互/长驻会话）：
`kimi --help` / `kimi acp --help` / `kimi doctor --help` / `kimi --version`(0.27.0) / `kimi -p … --output-format stream-json` x2（含一次触发 Bash 工具）；
`hermes --help` / `hermes chat --help` / `hermes mcp --help` / `hermes-acp --help` / `hermes-acp --check`(OK) / `hermes-acp --version`(0.21.4) / `hermes chat -q … --oneshot --format stream-json --max-turns 1` x1；
`node zcode.cjs --help`(0.16.9) / `app-server --help` / `-p --json` x2（两次失败，根因见 §3.2）；
kimi.exe、zcode.cjs 二进制字符串取证；hermes-agent Python 源码与 venv dist-info；`~/.kimi-code/mcp.json`、`~/.zcode/cli/config.json`、`~/.zcode/v2/setting.json`、hermes `config.yaml`（只读）。

网络一手来源（2026-10-05/06 访问）：
- ACP 规范：github.com/zed-industries/agent-client-protocol（README）；agentclientprotocol.com（overview/introduction、protocol/prompt-turn、protocol/schema）
- DeepSeek Harness：github.com/deepseek-ai/deepseek-harness（README、apps/cli/README.md、apps/cli/package.json、releases；.agents/notes：2026-07-23 acp-automation-only-protocol、2026-08-08 dsh-run-headless-command、2026-08-09 headless-direct-core-entry-point、2026-08-22 standard-acp-automation-controls、2026-09-09 headless-machine-readable-run-surface、2026-07-07 mcp-client-plugin）；deepseek-ai org 仓库列表（gh api）
- ZCode 背景：zcode.z.ai/cn/docs/configuration；智谱开源与争议报道（toutiao/csdn/infoq/huxiu，2026-09-24~29）
- kimi-code 文档站：moonshotai.github.io/kimi-code（确认 ACP 与 MCP 入口存在；细节以本机二进制取证为准）

未做/跳过：未启动 `kimi acp`、`hermes-acp`、`zcode app-server` 任何长驻进程（协议细节全部来自字符串/源码取证）；未安装或运行 dsh；npmjs 网页直连 403，`@deepseek-ai/dsh` 包存在性经 GitHub package.json + releases 交叉证实。
