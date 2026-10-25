# 工单03: Qoder 状态块退役

Status: resolved

Spec: `.scratch/generic-deck-fixes/spec.md`（Implementation Decisions「Qoder 状态块退役」「词汇与导言」；User Stories 14-18、20）。决策共识：彻底移除（卡片+快照段+插件能力），**弃**只撤卡片；会话列表卡加高补位，**弃**硬件卡上移、**弃**留空。

## 移除面

- `src/renderer/cards/qoder/`（card.ts + plugin.json）整目录删。
- `src/shared/contract.ts`：`QoderSessionState`、`QoderStatus`、`PanelSnapshot.qoder`、`PluginCapability` 联合与 `PLUGIN_CAPABILITIES` 数组中的 `'qoder'`；相关注释同步（04 扩展注记等）。
- `src/main/services/sessions.ts`：qoder 状态字段、`qoderState()`、`qoderStatus` 导入。
- `src/main/services/bridge.ts` `snapshot()`：qoder 行删。
- `src/main/scanners/`：**只删状态卡计算**——`scanners/qoder.ts` 的 `qoderStatus`、`types.ts` 的 `QoderStatus`、`scanners/index.ts` 的对应 re-export。`scanQoder` 及其共用辅助（taskStats/projectName/sessionLast/sessionState，删前核实谁还用）全部保留。
- `src/renderer/index.html`：`#qoder-*` CSS 删；`#sessions-card` 高度 348 → 522（top 152 不动，吞掉 16px 间隙 + 158px 状态块槽），`#hardware-card` 位置零改动（top 690 不动）。可见会话行约翻倍。
- 渲染层 `main.ts` 里五卡注释等 Qoder 残留措辞清理。
- `accept/battery.js`：qoder-rendered 断言块（~L663）删；内置五卡 builtinIds 改四卡；新增断言「qoder 卡不存在 + 会话卡补位」（热区声明按 id 找 `qoder-card` 应缺席、`sessions-card` 矩形覆盖原状态块槽位/高度≈522）。**会话行直达探针整段保留**——`relaunchWith({ qoder: ... })` 走的是 `config.tools.qoder`，与本工单无关。

## 保留面（不许动）

- 五工具会话扫描链：`defaultSessionRoots().qoder`、`SCANNERS.qoder`、collectSessions 出 QD 行、会话卡 QD 标签/运行状态/行内任务进度（`cards/sessions/card.ts` 的 `qoder: 'QD'` 标签映射保留）。
- 点击直达：`config.tools.qoder`（`config.ts` defaultTools 的 qoder 段、focus 服务）——那是五工具通用能力。

## 测试缝

- **内核桥接缝**（离线）：契约/服务级 spec（先例 `tests/services.spec.ts`、`tests/contract.spec.ts`）断言——快照无 qoder 段、Qoder 会话行仍在、插件能力表无 'qoder'（manifest.ts 的 CAPABILITY_SET 随 PLUGIN_CAPABILITIES 自动收窄，未知能力串静默丢弃语义不破坏）。
- 扫描器测试：`tests/scanners/collect.spec.ts` 等 qoderStatus 用法删，scanQoder 行级测试保留（fixtures 里纯状态用例删、会话行用例留）。
- 现有全套绿：`npm run typecheck && npm test`。

## 词汇与导言（User Story 20）

- `CONTEXT.md`：开篇段（「呈现多个 AI 工具……会话与任务状态」处）改通用 deck 措辞、去「Qoder 任务进度」；「Qoder 状态块」词条移入「已退役词汇」并注明保留面（会话行 QD 标签/行内进度/直达保留）；「会话行」词条的 Avoid 注记里对「Qoder 状态块」的指涉改为指向已退役词条。
- `AGENTS.md` 首段描述句与 `README.md` 开篇（qoder 相关段）同步去 Qoder 状态块措辞。只动词汇与导言，别的历史章节不翻案。

## 验收

- [x] typecheck + vitest 全绿；快照形状/能力表断言就位
- [x] 电池：qoder 卡缺席 + 会话卡补位探针就位（真机全量由合并后在 PR 分支统一跑）
- [x] QD 会话行端到端保留（扫描→快照→会话卡→直达映射零改动）
- [x] CONTEXT.md / AGENTS.md / README.md 词汇归位

## Answer

### 改动清单（提交 a17b3c8 / 052debe / 9e95eb0）

**移除面**
- `app/src/renderer/cards/qoder/`（card.ts + plugin.json）整目录删。
- `app/src/shared/contract.ts`：`QoderSessionState`、`QoderStatus`、`PanelSnapshot.qoder`、`PluginCapability` 与 `PLUGIN_CAPABILITIES` 中的 `'qoder'`；注释注明退役与能力串静默丢弃语义。
- `app/src/main/services/sessions.ts`：`qoder` 字段、`refresh` 内 qoderStatus 采样、`qoderState()` 删。
- `app/src/main/services/panel-data.ts`：`PanelDataPort.qoder()` 与本地实现删（typecheck 揪出的工单未点名传递依赖：`services/dataplane.ts` 的 `qoder()` 兜底实现、`dataplane-protocol.ts` 的 `DataplaneSnapshot.qoder`、`dataplane.ts`/`kernel.ts` 的快照 qoder 行一并摘除）。
- `app/src/main/services/bridge.ts`：`snapshot()` qoder 行删。
- `app/src/main/scanners/`：`qoder.ts` 的 `qoderStatus()`、`types.ts` 的 `QoderStatus` re-export、`index.ts` 的对应 re-export 删。
- `app/src/renderer/index.html`：`#qoder-*` CSS 五条删；`#sessions-card` 高 348→522（top 152 不动）；`#hardware-card` 零改动（top 690，152+522+16=690 对齐核过）。
- `app/src/renderer/main.ts`：五卡措辞改四卡。
- `app/accept/battery.js`：qoder-rendered 断言块删；`builtinIds` 五卡改四卡；新增「qoder-card 热区缺席 + sessions-card 补位（top 152/高 522，覆盖原槽位 152..674）」探针（P11 内置卡自举段之后，与四卡断言同源 hotzones 事件，无时序竞态）。

**测试缝**
- `tests/services.spec.ts`：快照断言 `'qoder' in snap === false`；SessionsService 改断言 QD 行 + 行内任务进度（tasks 1/2）保留；panel/changed 测试本就断言 qoder 会话行随推送到达（保留）。
- `tests/contract.spec.ts`：新增工单03 组——`PLUGIN_CAPABILITIES` 无 `'qoder'`；旧 manifest 声明 `['qoder','clock']` 得 `capabilities: ['clock']` 且 status ok（静默丢弃语义行为级验证）。
- `tests/dataplane-kernel.spec.ts`：数据面快照 `'qoder' in snap === false`，原 qoder 状态断言删。
- `tests/scanners/collect.spec.ts` 无需改：本就没有 qoderStatus 直接用法，全部用例都是 scanQoder 行级测试，原样保留。

**词汇与导言**
- `CONTEXT.md`：开篇改「会话列表与硬件指标」；「Qoder 状态块」移入「已退役词汇」置顶，注明保留面（QD 标签/行内进度/直达）；「会话行」Avoid 注记改指向已退役词条。
- `AGENTS.md` 首段、`README.md` 开篇去「Qoder 任务进度」类措辞。

### 保留面核实结论

工单要求删前核实 `scanQoder` 及其共用辅助的去留。核实结果：`taskStats`/`projectName`/`sessionLast`/`sessionState`/`qoderJsonlRows`（含 `QoderRow`）在全仓（src+tests）只有两个使用方——`scanQoder` 与 `qoderStatus` 本体，无任何外部直接引用；`qoderStatus` 的唯一外部使用方是 `sessions.ts`（随本工单移除）。结论：共用辅助全部保留（服务 scanQoder），只删 `qoderStatus` 与 `QoderStatus` 类型及其 re-export。五工具扫描链（`defaultSessionRoots().qoder`、`SCANNERS.qoder`、collectSessions 出 QD 行、会话卡 `qoder: 'QD'` 标签）与点击直达（`config.ts` defaultTools qoder 段、focus 服务）零改动核实无误；电池会话行直达探针整段未动（`relaunchWith({qoder:…})` 走 `config.tools.qoder`）。

### 验证输出摘要

- `npm run typecheck`：通过（无输出即无错误）。
- `npm test`：**Test Files 32 passed (32)；Tests 453 passed (453)**（约 29s）。首跑曾出现 `tests/desktop/service.spec.ts` 一例 5s 超时，单跑复现即绿（112ms），为全量并行下的偶发超时，与本次改动无关（工单05 桌面扫描，不含 qoder 引用）。
- `npm run build`：通过；`dist/renderer/cards/` 仅 clock/hardware/sessions/weather 四卡，qoder 卡不再产出。
- 按工单未跑 `npm run accept`（合并后统一跑）、未跑 `npm run dev`（单实例锁让位生产面板）。
