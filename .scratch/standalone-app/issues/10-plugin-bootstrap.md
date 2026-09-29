# 10: 插件体系自举

**What to build:** 桌面组件插件化：插件契约（manifest 声明能力与前端入口 + cordis 生命周期钩子）；前端资产经应用自定义协议交付渲染层动态加载；插件目录即安装位（放入即被识别）；时钟、天气、会话列表、Qoder 状态块、硬件五个内置信息块改造为首批桌面组件；运行时加载/卸载/重载单个插件不重启面板。cordis 锁 3.x 稳定线，只圈定生命周期与依赖注入子集。插件机制经真实组件自举验证，而非玩具样例。

**Blocked by:** 04 数据卡片

**Status:** ready-for-human

- [x] 五个内置信息块经插件契约加载渲染，观感与改造前一致
- [x] 运行时重载单个插件（改其资产后触发）无需重启面板即生效（电池探针）
- [x] 卸载插件其卡片消失，重装恢复
- [x] 外部样例插件放入插件目录即被识别加载（以测试样例验证）
- [x] 插件生命周期契约测试在内核契约缝全绿
- [x] 真机截图存证于工单评论

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

**2026-09-28 10b 落地（五卡插件化 + 双轴评审收编；票面 AC 全绿，置 ready-for-human）**

**做了什么**：五张内置信息卡各成一插件（`src/renderer/cards/<id>/card.ts` + `plugin.json`），由插件宿主按序装载。卡片元素在 `mount` 时自建，**id 与样式表一一对应**——几何与配色仍由面板既有样式表承担，观感零漂移（10b 前后的 `04-cards-*.png` 逐项对照：位置、尺寸、字重、曲线样式全同，只有实拍数值与壁纸不同）。`index.html` 只留搜索/桌面承载/设置浮层/日历，`main.ts` 只做宿主与编排。

**真机证据（`app/accept/evidence/03-battery.log.txt` 末段 + `10-plugin-hello.png` / `10-plugin-reinstalled.png`）**：

- `桌面组件·内置五卡自举`：clock/weather/sessions/qoder/hardware 五张均经插件契约装载，且**五张都进了热区声明**，时钟卡矩形 `48,48 320x176` 与 `index.html` 的 `CARD_DIP` 逐项相等（观感一致性的机器可查部分；像素级仍按 spec 惯例人工核截图——「界面视觉对齐不设自动化缝」）。
- `桌面组件·放入即识别`：外部样例插件放入插件目录后**无需重启面板**即被装载并渲染，`capabilities=["clock"]`，卡片热区 320x120。
- `桌面组件·运行时重载` / `桌面组件·卸载` / `桌面组件·重装恢复`：改 card.js 即时重载、移除目录卡片从热区消失、放回即恢复；四步走完 **boot 存证 3→3 未增**——「没重启面板」由 boot 条数自证，不靠探针自述。
- 测试：403 全绿（28 文件）+ typecheck 干净；`tests/plugins/`（manifest 28 / assets 30 / service 18，含真 `fs.watch` 集成）+ 契约缝 5 条 + config.plugins 4 条。

**本轮踩坑（三条都是真机才暴露的，值得留给后续）**：
1. **插件目录之外的兄弟文件在协议寻址里不存在**：五卡首跑全灭（`plugin-load-failed` ×88）。协议以插件 id 作主机名，卡片相对导入 `../kit.js` 落到主机名 `kit`，无根可寻 → 整条模块图 404。解法：共用呈现工具经 `PluginHost.util` 由宿主转交，卡片回到**单文件、零相对导入**（spec 插件体系段已补这一句）。
2. **在途装载令牌不能是全局单计数**：五个插件并发 import 时互相作废，侥幸装上第一个，其余四张退化成「每秒补一张」，首屏缺卡 4 秒（证据：jsonl 里五个 `plugin-mounted` 间隔 ~1000ms）。改为**按插件计**的代号。
3. **失败记账不能无限期拉黑**：内置卡片入口 URL 恒定，一次偶发失败会让它**永远**不再出现。改为按 id 记账、冷却 30s 后再给机会——既压住刷屏（一个 404 卡片曾 2 秒刷 88 条存证），又留自愈口子。

**偏离记录（如实存证，不藏）**：
- **电池整体判定仍是 FAIL（pass=60 fail=7）**。这七条与 09 票基线失败集**逐条相同**（对照 `62cfd93` 的 `03-battery.log.txt`），成因均为环境，非本票回归：用户自己的窗口盖住参照窗/面板空区（09 踩坑 7：跑电池前请先最小化自己的窗口），以及**电池自己**在 P5 段开的那扇记事本压住右下角设置入口（诊断行 `命中 Notepad pid=...`，两轮同因）。本票五条插件探针全绿，「全绿」按「本票相关探针全绿且失败集不超出基线」判定。
- **动了既有探针两处**（票面边界写的是「热区/穿透/钉扎零改动」，此处如实记）：① P4 热区探针改等「声明了 clock-card 的那一拍」——卡片改异步挂载后，首拍热区快照里还没有它们，拿首拍断言等于把「插件尚未挂上」误判成「渲染层没声明热区」；② `latestZoneOf` 加 `sinceMs` 按面板代次过滤，并新增 `lastBootMs()`——面板重启后事件文件不清，拿上一任面板的旧矩形去点会点在没有热区的空处。两处只改探针取数口径，**热区机制本身一行未动**（`hotzone.ts` 与渲染层声明逻辑零改动）。
- **新契约面两处**（`PluginHost.util`、`renderer/format.ts`）：均为踩坑 1 的解法，已同步写进 spec「插件体系」段（沿用 10a 的文档先行纪律）。
- 五卡 `mount` 脚手架（建 div/取 N 个 querySelector/复位计数）确有重复，评审判为 judgement call；本拍**不改**——收拢它要给宿主再加一个 `card()` 便利 API，为五个调用点换一个本票验收面之外的 API 面，不划算。记此备查。
- 顺带清掉 4 个文件里我自己在 10a 用 PowerShell 写入带出的 UTF-8 BOM（`git grep` 对照 `840281e` 确认原文件无 BOM）。

**双轴评审（code-review skill 正规流程，固定点 `62cfd93`，两个并行子代理）**：Standards 轴 FAIL（硬伤二条：battery.js 词汇漂移「信息块」→ 已改「桌面组件」并 amend 了提交信息；新探针未按代次取事件 → 已加 `lastBootMs` 边界）、Spec 轴 FAIL（AC 未勾/未存证 → 本条补上；失败记账无自愈 → 已在踩坑 3 修）。两轴指出的实质缺陷全部已修并复跑电池验证，剩余 judgement call 见上。
