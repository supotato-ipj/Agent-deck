# 10: 插件体系自举

**What to build:** 桌面组件插件化：插件契约（manifest 声明能力与前端入口 + cordis 生命周期钩子）；前端资产经应用自定义协议交付渲染层动态加载；插件目录即安装位（放入即被识别）；时钟、天气、会话列表、Qoder 状态块、硬件五个内置信息块改造为首批桌面组件；运行时加载/卸载/重载单个插件不重启面板。cordis 锁 3.x 稳定线，只圈定生命周期与依赖注入子集。插件机制经真实组件自举验证，而非玩具样例。

**Blocked by:** 04 数据卡片

**Status:** ready-for-agent

- [ ] 五个内置信息块经插件契约加载渲染，观感与改造前一致
- [ ] 运行时重载单个插件（改其资产后触发）无需重启面板即生效（电池探针）
- [ ] 卸载插件其卡片消失，重装恢复
- [ ] 外部样例插件放入插件目录即被识别加载（以测试样例验证）
- [ ] 插件生命周期契约测试在内核契约缝全绿
- [ ] 真机截图存证于工单评论

## Comments

**2026-09-28 开工前决策与两拍边界（用户已拍板，执行者按此直接开工，无需再询问路线/拆分问题）**

**路线拍板：路线 (b)——无打包器 + 自定义协议上原生 ESM，修订 spec。** 在「(a) 引入 Vite 对齐 spec 原文」与「(b) 无打包器」之间已选 (b)，理由存要：① 插件契约在两条路线下同构，Vite 只关乎宿主自身构建且随时可后补，(b) 不封死 (a)；② 本票真风险在五卡搬迁回归，(a) 叠加工具链迁移会搅浑归因；③ Vite 从未落地而 04-08 零痛感，非必要依赖；④ 两个技术障碍有现成解（TS 5.9.3 `rewriteRelativeImportExtensions` 解后缀改写；特权协议注册约 30-60 行，且 (a) 路线同样要做）。工作区已有 10a 契约雏形（`contract.ts` 的 `PluginInfo`/`PluginCapability`/`deck-plugin://`/快照 `plugins` 段，未提交）——与本决策一致，按 10a 在途工作继续，不推倒。

**10a（第一拍，一个提交）——机制，不碰五卡：**

1. **文档先行（本拍第一个动作，非可选项）**：`spec.md:17` 与 `spec.md:90` 删 "Vite 前端" 表述、改写为实况（无打包器，tsc 直出 ESM；自定义协议交付插件资产）；02 票 Comments 踩坑 #4 追加一行 supersede（原文保留，注明 Vite 预期作废、边界改由本票原生 ESM 消解）。ADR-0004 不含 Vite 表述（已核，唯一"前端"在否决项语境），无需动。
2. **机制本体**：特权协议注册（`registerSchemesAsPrivileged`，standard+secure + 正确 JS MIME，须在 app ready 前）；渲染层入口从经典脚本改 ESM（`index.html:456` 的 `<script src="./main.js">` 加 `type="module"`，加载走协议）；插件目录扫描 + manifest 契约（`contract.ts` 已有雏形）；cordis 生命周期（加载/卸载/重载，锁 3.x 生命周期+依赖注入子集，同 02 注记 5 的坑位经验）。
3. **验收探针（本拍唯一验收）**：最小外部样例插件放入插件目录 → 面板识别并渲染、不重启。生命周期契约测试在内核契约缝全绿；`npm test` / `typecheck` 干净。
4. **边界**：五卡渲染逻辑与观感一行不动（渲染入口的加载方式改造除外）；bridge 契约只扩表不另开通道；热区/穿透/钉扎零改动。

**10b（第二拍，一个提交）——五卡搬迁 + 收口：**

1. 五卡逐个迁为插件，由简到繁：时钟 → 天气 → 会话列表 → Qoder 状态块 → 硬件（时钟是 02 tracer 先例，先行探路）。
2. 运行时重载/卸载/重装探针上电池——**新探针段必须排电池最后**（09 踩坑 8：动 config/重启面板的探针不得排中间，会确定性搞挂 P5 图标状态机）；卸载后卡片消失、重装恢复。
3. 全绿后逐条勾票面 AC、真机截图存证、置 ready-for-human。观感一致以电池截图对照为准（08 的卡片底色滑杆/设置浮层行为不得回归）。**票面 AC 在 10b 前一律不勾**，10a 的证据写本 Comments。

**预决策清单（按此默认执行，不再询问；真机实证需要偏离时记录理由后偏离）：**

- 内置五卡建议做**单文件插件**（各一个入口、零相对导入），后缀改写问题直接消失；确需相对导入再开 `rewriteRelativeImportExtensions`。
- 渲染层 `contextIsolation + sandbox` 不变：插件文件读盘只在主进程，资产经协议投喂、数据经既有桥接契约；插件拿到的快照按 `capabilities` 声明裁剪（少给而非不给，同桌面项池校验思路）。
- 插件目录默认 `userData/plugins`（+config 可改），executor 定稿后随 spec 修订段写明；「放入即被识别」用 fs.watch 或重扫均可，以 10a 探针实测为准。
- 评审按 code-review skill 正规双轴（两个并行子代理、固定点 = 提交前 HEAD），不得自创轴切法（09 票流程教训）。
- 本票提交节奏：10a、10b 各一个提交，票面一张不动（01 票两提交一票先例）；10a 前若有他票在途改动（如 contract.ts 之外的散件）先确认归属再动。

**2026-09-28 10a 落地（机制拍：插件机制可用，五卡渲染逻辑与观感一行未动）**

**先说一件事**：开工时票面记的「工作区已有 10a 契约雏形（contract.ts 未提交）」在本 worktree 里**不存在**（git 干净、contract.ts 无插件字样），故本拍按决策记录从零建契约，未推倒任何东西。

**契约**（`shared/contract.ts`）：`PluginManifest`/`PluginCapability`/`PluginInfo`/`PluginStatus` + 快照段 `plugins` + 事件 `plugins/changed`（热插拔不等 1Hz 快照）。能力名与快照段名**一一对应**（`PLUGIN_CAPABILITIES` 是唯一登记处），渲染层按声明裁剪视图——「少给而非不给」。

**主进程**（`src/main/plugins/`，纯逻辑与 Electron 接线分文件：assets/manifest/watch 可离线测，service 是 cordis Service，protocol 只做接线）：
- `manifest.ts`：id 即协议主机名，限小写字符集；entry 必为插件目录内 `.js/.mjs`（绝对路径/盘符/反斜杠/穿越一律拒）；未知能力串静默丢弃（认不得的能力不给），必填项缺失才整体失效。
- `assets.ts`：`deck-plugin://<host>/<path>` → 文件 + MIME 的纯解析。穿越/未知主机/目录/白名单外一律 null（→404）；`.js` 必 `text/javascript`，否则 ESM 被 Chromium 拒。
- `service.ts`：扫多根 → manifest → 实例（`ready`/`dispose` 生命周期，ctx 注入）→ `fs.watch`（含插件目录**递归**，改自己的 card.js 也要触发）→ 重扫 → 推事件。资产指纹 = manifest 原文 + 入口 mtime/size，变了即换代：revision 递增、entry URL 带 `?v=`，渲染层据此绕开 ESM 模块缓存。
- `protocol.ts`：`registerSchemesAsPrivileged`（standard+secure+supportFetchAPI+cors，**app ready 前**）+ `protocol.handle`。读盘只在这里，渲染层 `contextIsolation + sandbox` 一字未动。

**渲染层**：`index.html` 的 `<script type="module">`，页面改经 `deck-plugin://app/index.html` 载入（与插件资产同源）；新增 `renderer/plugins.ts` 运行时——`syncPlugins` 幂等对齐（新增装载/消失卸载/换代重挂/其余只推视图），在途 import 用令牌防「迟到的模块复活已卸载组件」。

**三处执行期偏离决策记录（均按预决策清单默认执行，无新增提问）**：
1. **插件目录**：缺省 `userData/plugins`，并按「+config 可改」新增 `config.plugins.dir`（空串=缺省，纯模块不引 Electron，真实落点由主进程解析）。目录由宿主**建出来**——首运行还没有这个目录是常态，不建就永远等不到首次放入的那个事件。
2. **`unload(id)` 不作对外 API**：AC 的卸载动作是「移除插件目录」（文件级）由重扫驱动。保留一个只在进程内生效、下一次重扫又被装回来的 `unload` 是半吊子语义，不如不做。
3. **原型键 id 不靠字符集挡**：字符集只挡大小写混写（`toString` 被拒）；`constructor` 这类放行，查表全程 `Map`（09 踩坑 1 的纪律），用例证「原型键 id 可寻址、`dirOf('toString')` 为 undefined」。协议主机名逐字匹配（WHATWG 只对特殊协议归一大小写，自定义协议主机名原样保留）——不做猜测映射。

**测试**：318 → **403 全绿（28 文件）**，typecheck 干净。新增 `tests/plugins/`（manifest 28 / assets 30 / service 18，真 `fs.watch` 集成含「放入即识别/移除即消失」）+ 契约缝 5 条（快照带 plugins、放入/移除、事件独立推送、坏插件 error 态、**源码级守卫：渲染层不碰 fs**）+ config.plugins 4 条。

**真机实证（冒烟脚本，不入库）**：起面板后把 `app/samples/hello-plugin` 复制进插件目录，**全程不重启面板**（boot 存证 1→1）：
- 放入 → `plugin-mounted` + `hello-mounted`（插件模块真的跑起来了）+ 卡片进热区 `hello-card {48,760,320x120}`
- 改 card.js → 再次 `plugin-mounted`（换代重载）
- 删目录 → 热区里 `hello-card` 消失 + `plugins-changed`
- 放回 → 恢复装载
收尾已清理冒烟残留，`HideIcons` 键已消失（= 原生图标可见，还原链路无残留）。

**未跑**：P11 电池探针已按「排最后」（09 踩坑 8）写进 `battery.js`，随 10b 的整轮电池一起跑——本拍只承诺真机冒烟，整轮电池与截图存证属 10b 的验收面。票面 AC 一律未勾。
