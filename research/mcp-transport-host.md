# 调研：MCP 传输与宿主——单实例常驻面板如何被外部 agent 接入

- 工单：#68（wayfinder:research），map #66
- 分支：`research/mcp-transport-host`（抛弃分支，从 `origin/master` = `7e73833`）
- 日期：2026-10-05
- 只查事实，不做决策。决策在《MCP 传输与宿主进程选型》。

## 验证口径

本文严格区分三类证据：

- **[本机实测]** = 在这台机器上跑命令 / 读安装目录里客户端**自己的**捆绑代码得到的结果。客户端捆绑代码 = 一手真源，优先于其官方文档。
- **[文档]** = 官方文档 / 规范 / README / npm registry。
- **[推断]** = 由上述两者推出、但无直接文字依据的判断，逐条标注。

未能核实的条目集中在 §6。所有 SDK 论断都钉到版本号。

---

## 0. 结论速览

| # | 问题 | 结论 | 标签 |
|---|---|---|---|
| 1 | MCP TS SDK | `@modelcontextprotocol/sdk` **1.32.1**（2026-10-05，dist-tag 只有 `latest`），实现 **2025-11-25** 规范。stdio + Streamable HTTP 为正式传输；`SSEServerTransport`/`SSEClientTransport` 带 `@deprecated`，**首次出现在 1.21.1**（2025-11-07），1.21.0 与 1.20.2 无。规范层面 HTTP+SSE **自 2025-03-26 起废弃**。回环监听 + DNS 重绑定防护有现成件（`createMcpExpressApp` 默认 host `127.0.0.1`）；**没有内置静态 bearer token**，需自写 express 中间件塞 `req.auth`。`Transport` 接口极小（start/send/close + 3 个回调），自定义传输（命名管道）完全可行——但**本机五个客户端没有一个能配它**，见 §3。 | VERIFIED |
| 2 | stdio ↔ 常驻应用 | 三个成熟薄 bridge（`mcp-proxy` Python、`supergateway` Node、`mcp-remote` Node），都是「客户端 spawn 一个 stdio 进程 → 转发到 HTTP」。Windows 代价可以**为零**：`ELECTRON_RUN_AS_NODE=1 <面板 exe> bridge.js` 复用 Electron 自带的 Node（`runAsNode` fuse 默认 Enabled，本仓无 fuse 配置）。Node SEA 是 Stability 1.1 + 需要 postject + 单文件打包，纯亏。「拉起已运行实例」的行业写法是**描述符文件**（pid + baseUrl + token），本机就有活例：Qoder CN 的 `mcp-router.json`。 | VERIFIED |
| 3 | 五客户端传输 | Qoder / Kimi Code / zcode / hermes **四家都支持 url 型**（http + sse），且都支持自定义 header；**Kimi Work 确认不支持任何用户可注册的 MCP**。`--add-mcp` 接受 url 型：VERIFIED。zcode 的 `type`/`headers`/`oauth`/`timeoutMs`/`isolation`/`protocolVersion` **全部真能用**（strict zod schema）。 | VERIFIED |
| 4 | Electron 宿主 | 主进程 / utilityProcess / 独立 node 子进程都能挂 HTTP 或命名管道监听。**utilityProcess 无法承载 stdio MCP server**——`stdio` 选项只管 stdout/stderr，「Configuring `stdin` to any property other than `ignore` is not supported and will result in an error」。挂进现有 `deck-dataplane` 技术上可行，但按本仓 ADR-0005 自己的口径是**双向故障耦合**（koffi/SQLite 崩溃带走 agent 会话；agent 输入引发的停顿带走 1Hz 采集器）。 | VERIFIED（能力）/ 推断（耦合代价，依据 ADR-0005 原文） |
| 5 | 本地监听安全 | 仅回环：**本机实测无任何防火墙规则**，有规则的都是绑了非回环地址的（Steam 0.0.0.0:27036、Qoder CN IDE、hermes.exe）。命名管道 ACL **能限到当前用户**（`CreateNamedPipe` 的 `SECURITY_ATTRIBUTES`；默认描述符反而给 Everyone/anonymous 读权限），**不能限到特定进程**（Windows ACL 按 SID，无 PID 主体；只能连上后用 `GetNamedPipeClientProcessId` 反查再挂断），且 **Node 建的管道设不了 DACL**（`SetNamedSecurityInfo` 明确只支持 semaphore/event/mutex/waitable timer/file mapping，不含管道）。端口：**本机实测**存在 TCP 排除段（49702-49801、50000-50059(admin)、50060-50159、50160-50259、50269-50368、57899-57998、63313-63412），落在里面即使没人监听也 bind 失败 → 固定端口应选 1024-49151。`app/config.json` 已有挂端口的位置（`search.port` / `search.everythingPort`，同口径 1..65535 校验 + warn+fallback）。 | VERIFIED（本机 + Win32 文档）/ 防火墙「不弹框」仅有实测证据，无微软原文 |

---

## 1. MCP TypeScript SDK 现状

### 1.1 包与版本 [文档 + 本机实测]

- 包名 `@modelcontextprotocol/sdk`，仓库 `github.com/modelcontextprotocol/typescript-sdk`，主页 `modelcontextprotocol.io`。
- **最新版 1.32.1，发布于 2026-10-05**；`npm view dist-tags` 只有 `latest`，**没有 v2 的 dist-tag**。
- 版本节奏（部分）：1.21.0 = 2025-11-03、1.21.1 = 2025-11-07、1.22.0 = 2025-11-13、1.23.0 = 2025-11-25、1.25.0 = 2025-12-15、1.30.0 = 2026-07-27、1.32.0 = 2026-10-02。
- `engines.node >= 18`；**必需 peer dep** `zod ^3.25 || ^4.0`（另有 `@cfworker/json-schema ^4.1.1`）。
- 17 个运行时依赖，含 `express ^5.2.1`、`hono ^4.11.4`、`@hono/node-server`、`cors`、`express-rate-limit`、`jose`、`pkce-challenge`、`ajv`、`eventsource`、`raw-body`、`cross-spawn`、`zod-to-json-schema` 等。**对一个只想要「本机回环 + 一个 POST 端点」的 bridge 来说，这是可观的体积与供应链面。**
- README 明写：本 SDK 实现 **2025-11-25 MCP 规范**。

### 1.2 支持哪些 transport [本机实测：解包 1.32.1 tarball 看 dist]

服务端（`dist/esm/server/`）：

| 模块 | 状态 |
|---|---|
| `stdio.js` | 正式 |
| `streamableHttp.js`（Node http 包装）+ `webStandardStreamableHttp.js`（Web 标准核心实现） | 正式，README 推荐 |
| `sse.js` + `sseKeepAlive.js` | **`@deprecated`**：「SSEServerTransport is deprecated. Use StreamableHTTPServerTransport instead.」 |
| `express.js` → `createMcpExpressApp()` | 便捷工厂（见 1.4） |
| `mcp.js` → `McpServer.connect(transport: Transport)` | 高层 server，传输无关 |
| `auth/`（`middleware/bearerAuth`、`middleware/clientAuth`、`middleware/allowedMethods`、`providers/proxyProvider`、`router`、`handlers/*`） | OAuth 2.1 全套 |
| `middleware/hostHeaderValidation.js` | DNS 重绑定防护 |

客户端（`dist/esm/client/`）：`stdio`、`streamableHttp`、`sse`（`@deprecated`：「Prefer to use StreamableHTTPClientTransport where possible instead. Note that because some servers are still using SSE, clients may need to support both transports during the migration period.」）、**`websocket`**（有客户端类，**服务端无对应实现**，非规范传输）。

### 1.3 SSE 从哪个版本废弃 [本机实测 + 文档]

两个层面，别混：

- **规范层面**：HTTP+SSE 由 **2025-03-26** 修订版用 Streamable HTTP 取代。2026-07-28 修订版的 changelog 把它写死了：「Reclassify the HTTP+SSE transport (**deprecated since protocol version 2025-03-26**) as Deprecated under the feature lifecycle policy (SEP-2596)」。同版还引入了「feature lifecycle」：Active / Deprecated / Removed，**最短 12 个月废弃窗口**，并有 deprecated features registry。
- **SDK 层面**：`@deprecated SSEServerTransport` 这行 JSDoc 的**首个发布版本是 1.21.1（2025-11-07）**。实测方法：`npm pack` 四个版本再 grep `dist/esm/server/sse.d.ts` —— 1.20.2 无、1.21.0 无、**1.21.1 有**、1.22.0 有。对应上游提交「Add @deprecated annotations to legacy APIs (#1018)」（2025-11-03，晚于 1.21.0 发版）。

### 1.4 HTTP transport：回环监听 + bearer / 自定义 header [本机实测 .d.ts]

- **绑定地址不是 transport 的事**，由你的 HTTP server 决定。SDK 给了便捷件：
  - `createMcpExpressApp(options)`：**`host` 默认 `'127.0.0.1'`**，文档原文「When set to '127.0.0.1', 'localhost', or '::1', DNS rebinding protection is automatically enabled」。绑 `0.0.0.0` 则不自动开，需自传 `allowedHosts`。
  - `hostHeaderValidation(allowedHostnames)` / `localhostHostValidation()`（只放行 `localhost`、`127.0.0.1`、`[::1]`）——按 hostname 校验、**端口无关**。
  - 注意：transport 自己的 `allowedHosts` / `allowedOrigins` / `enableDnsRebindingProtection` 三个选项**在 1.32.1 里已标 `@deprecated`**，改为「Use external middleware」。
- **鉴权：没有开箱的静态 token。**
  - `requireBearerAuth({ verifier, requiredScopes, resourceMetadataUrl, expectedResource })` 需要一个 `OAuthTokenVerifier`；`ProxyOAuthServerProvider` 是把 OAuth 代理到上游 AS。都偏重。
  - 静态 token 的正确做法是**自写 express 中间件**，把校验结果挂到 `req.auth`，因为 transport 的入口签名就是 `handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?: unknown)`；另有 `HandleRequestOptions.authInfo` 可显式传入。[推断：三行中间件即可，无需 OAuth 机制。]
  - 自定义 header 无需 SDK 支持——就是普通 HTTP 头，中间件自己读。
- 客户端侧：`StreamableHTTPClientTransportOptions` 有 `requestInit?: RequestInit`（塞任意 header，如 `Authorization: Bearer …`）、`fetch?: FetchLike`、`authProvider?`、`redirectPolicy?: 'same-origin'（默认）| 'follow'`、`reconnectionOptions`、`sessionId`。
- 会话与流控选项（服务端）：`sessionIdGenerator`（给函数 = stateful；`undefined` = stateless，不做会话校验）、`onsessioninitialized` / `onsessionclosed`、`enableJsonResponse`（只回 JSON、不起 SSE 流）、`eventStore`（可恢复性）、`retryInterval`、`keepAliveMs`（默认 15000，<1 关闭）、**`maxRequestBodySize` 默认 4 MiB**（超限在解析前直接 413）。

### 1.5 自定义 transport（Windows 命名管道）[本机实测 + 规范原文]

- 规范 2025-11-25「Custom Transports」原文：「Clients and servers **MAY** implement additional custom transport mechanisms to suit their specific needs. The protocol is transport-agnostic and can be implemented over any communication channel that supports bidirectional message exchange.」附加约束：「**MUST** ensure they preserve the JSON-RPC message format and lifecycle requirements」，且「**SHOULD** document their specific connection establishment and message exchange patterns」。
- SDK 的抽象接口（`dist/esm/shared/transport.d.ts`）小到几乎无成本：

  ```ts
  export interface Transport {
    start(): Promise<void>
    send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>
    close(): Promise<void>
    onclose?: () => void
    onerror?: (error: Error) => void
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void
    sessionId?: string
    setProtocolVersion?: (version: string) => void   // 可选
  }
  ```
  `TransportSendOptions` = `{ relatedRequestId?, resumptionToken?, onresumptiontoken? }`。
- **所以：写一个 `node:net` 命名管道 transport 是完全可行的**（Node 官方支持：「The `node:net` module supports IPC with named pipes on Windows」）。**但**——§3 会看到，本机五个客户端**没有任何一个**能被配置成走自定义传输。自定义 transport 的实际用途只剩面板自己的工具链/测试。

### 1.6 语言/运行时选型 [文档 + 本机实测]

- **TS SDK 是自然解**：Electron **44.4.3**（`app/package.json` devDependencies）内嵌 **Node 24.21.0 / Chromium 152**（`releases.electronjs.org/releases.json` 实测），远超 SDK 的 `node >= 18`。
- Python MCP SDK 存在（hermes 就在用），但本仓 Python 数据服务已于 2026-09-29 退役（工单11），重新引入运行时代价远大于收益。
- 备选：**手写 Streamable HTTP 子集**（一个 POST 端点 + 可选 GET SSE），避开 express/hono/zod/jose 全家桶。规范 2026-07-28 之后协议变**无状态**（见下），手写面反而变小。

### 1.7 规范漂移风险（必须记） [文档]

**2026-07-28 修订版已发布，且是破坏性重构**：

1. 去掉协议级会话与 `Mcp-Session-Id`；list 类端点不再按连接变化；跨调用状态改用「服务端铸造的 handle 当普通 tool 参数传」。
2. **MCP 变无状态**：删掉 `initialize`/`notifications/initialized` 握手；每个请求在 `_meta` 里带 `io.modelcontextprotocol/protocolVersion` 与 `clientCapabilities`；新增 `server/discover`（服务端 **MUST** 实现）。
3. `subscriptions/listen` 取代 HTTP GET 端点与 `resources/subscribe`。
4. 删 `ping`、`logging/setLevel`、`notifications/roots/list_changed`。
5. 引入 MRTR（Multi Round-Trip Requests）取代服务端主动请求（`sampling/createMessage`、`elicitation/create`、`roots/list`）。
6. 删除 SSE 可恢复性（`Last-Event-ID`）。
7. **Deprecate Roots / Sampling / Logging 三个特性**（12 个月窗口后移除）。
8. Streamable HTTP POST **要求** `Mcp-Method`、`Mcp-Name` 标准头。

而 **SDK 1.32.1 只实现 2025-11-25**。上游已在 2025-12-19 落地 v2 monorepo 拆包（PR #1279：`sdk-core` / `sdk-client` / `sdk-server`），并有 `v2-bc`（"v2 backwards-compatibility series"）标签的 PR 系列（如 #1909「restore SSEServerTransport under /node/sse, @deprecated」）——**但这三个包在 npm 上全是 404，尚未发布**。

**旁证：zcode 已经在跑 2026-07-28**（其 schema 里 `protocolVersion: "legacy"|"auto"|"2026-07-28"`、`protocolEra: "legacy"|"modern"`），`supergateway` README 也已声明支持 2026-07-28。也就是说客户端侧已经先于 SDK 走了。
