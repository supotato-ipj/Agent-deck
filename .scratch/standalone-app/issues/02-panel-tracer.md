# 02: 底座尖兵（tracer bullet）

**What to build:** 新底座第一次端到端贯通：Electron 主进程运行 cordis 内核；透明无边框窗口浮于用户自选壁纸（背景层）之上、底部钉扎；面板默认鼠标穿透，光标进入渲染层声明的交互热区时临时接收点击；渲染层经桥接契约从内核取快照，渲染第一个桌面组件（时钟卡）；config.json 加载生效（屏幕几何以当前生产值为默认）。内核契约缝 vitest 首测建立，验收电池探针雏形（透明/穿透/钉扎）随票落地。01 的 spike 结论决定透明路径。

**Blocked by:** 01 透明与输入机制 spike

**Status:** ready-for-human

- [x] 面板浮于系统壁纸与（如运行中）WE 壁纸之上，背景透明透出壁纸，文字实色清晰
- [x] 底部钉扎生效：任意普通应用窗口均可盖住面板
- [x] 默认穿透：点击与右键直达桌面；光标进入时钟卡热区时该卡接收点击，离开即恢复
- [x] 时钟卡实时走时，数据经桥接契约自内核而来；契约测试在 vitest 通过
- [x] config.json 加载生效：改动几何后重启面板即反映
- [x] 单一桥接 API 形态确立（后续工单只扩展此契约，不另开通道）
- [x] 验收电池雏形一键可跑，截图存证于工单评论

## Comments

**2026-09-27 实现落地 + 验收电池 14/14 跑绿（含一轮 code-review 收编）**

新应用位于 `app/`（TypeScript 全栈）：Electron 44.4.3 窗口宿主 + cordis 3.18.1 内核（锁 3.x 稳定线）+ koffi FFI 钉扎 + vitest 契约缝。`npm run dev` 面板启动，`npm run accept` 一键验收电池，`npm test` / `npm run typecheck` 离线测试。

**桥接契约形态（工单验收点之一，后续工单按此扩展）**

- 类型映射收口在 `app/src/shared/contract.ts`：`BridgeMethods`（method → 请求/响应体，02 有 `panel/snapshot`）与 `BridgeEvents`（event → 载荷，02 有 `panel/changed`）。后续工单只扩这两张表 + `BridgeService.invoke` 的 dispatch 分支，不另开通道。
- 渲染层唯一入口 `window.deck`：`deck.bridge.invoke/on`（内核契约）+ `deck.host.setHotZones/notify`（窗口宿主机制：热区声明、点击/渲染存证）。host 面不属于内核契约，但与 bridge 同走同一对 IPC 通道（`deck:bridge-invoke` / `deck:bridge-event` + 两个 host 通道），传输层用 ok/error 信封、preload 侧解包。
- 内核契约缝（spec 新缝）：`app/tests/contract.spec.ts` 在纯 Node 里 `createKernel()` 驱动 cordis 内核，断言 invoke 响应、panel/changed 推送与退订、未知方法拒绝；config 模型（合并/校验/告警/首运行落盘）在 `app/tests/config.spec.ts`。9/9 绿。
- 内核为 cordis `Context` + 两个 Service（clock/bridge），`static inject` 声明依赖；注意 cordis 3.x Service 在 `ctx.start()` 后才挂上 `ctx.<name>`，且无 `ctx.setInterval`（自装 setInterval + dispose 清理）。

**逐条验收证据（电池输出原文见 `app/accept/evidence/02-battery.log.txt`，14 探针全绿）**

- 透明合成：棋盘参照窗压到钉扎面板之下，透明区棋盘双色命中率 **99.1%**（样本 1165056）；时钟卡白色文字像素 2623/56320 实色清晰。截图 `02-transparent-on-checker.png`（透明区透出参照窗、卡片实色白字）；`02-on-wallpaper.png` 为关参照窗后面板叠真壁纸的观感实拍（动态壁纸逐帧不同，不做像素断言）。
- 默认穿透（左键+右键）：穿透态 EXSTYLE 含 WS_EX_TRANSPARENT|WS_EX_LAYERED；面板空区左键点击前台翻转为 Progman（直达桌面）；右键同样直达——Win11 桌面右键菜单弹出（前台 XamlExplorerHostIslandWindow_WASDK，即桌面菜单宿主）。
- 热区：渲染层上报 clock-card rel(48,48) 320×176；光标进入后 WS_EX_TRANSPARENT 移除、点击被时钟卡接收（count=1 存证）；离开恢复穿透。截图 `02-pinned-bottom.png`（记事本盖住面板右半、卡片外露）。
- 走时数据链路：`clock-rendered` 存证 3 次渲染 epochMs 递增——初始 snapshot（invoke）+ panel/changed 1s 推送（订阅）都真实到达渲染层。
- 钉扎：热区点击后面板被顶起，离开热区重钉生效——记事本仍盖住面板；自顶向下枚举序面板(47) 在记事本(29) 之下。
- config 几何生效：电池改写 config.json 为 (60,60,1100×800) 后真重启面板，GetWindowRect 与期望吻合（±24 物理像素容差，frameless 隐形边框），随后还原 config。**Win+D 恢复后的重钉触发点按票 01 实施要点留待工单 03（Win+D 防抖恢复是 03 的验收项）**。

**config.json 政策（评审收编）**

config.json 为运行时用户可编辑文件，已 gitignore 不入库：首运行按当前屏幕全屏（本机 1560×1040 DIP @200%）自动生成，改动几何重启即生效（字段级校验：非法字段回退默认并告警、坏 JSON 不覆写用户文件，均有测试）。入库一份机器专属副本会让其它机器首运行拿到错误几何——「以当前生产值为默认」由生成逻辑保证而非仓库文件。另观测到一个无害钳制：非 resizable 窗口被 Windows 钳到工作区高度（GetWindowRect 992 DIP = 1040 − 任务栏 48），任务栏条带本被任务栏自身覆盖，观感与全屏一致。

**实现要点（探针01 结论的落地对照）**

- 透明路径按 01 定案：`transparent+frameless`，未走 alpha 降级。
- 穿透：默认 `setIgnoreMouseEvents(true,{forward:true})`；主进程 25ms GetCursorPos 轮询热区命中切换（`hotzone.ts`）。
- 钉扎：koffi 直调 SetWindowPos(HWND_BOTTOM)，flag `NOMOVE|NOSIZE|NOACTIVATE|NOOWNERZORDER`；触发时机=启动后 + 每次热区离开后（01 结论的「交互后重钉」），Win+D 恢复后随票 03。
- 电池复用 01 探针库（SendInput 虚拟屏坐标、WindowFromPoint→GA_ROOT、DPI 感知 PowerShell 截屏、清场逐窗最小化+还原）。

**踩坑记录（后续工单注意）**

1. **Z 序枚举护栏**：`topLevelWindows()` 逐窗走 Z 序，本机顶层窗总数 ~517，护栏 512 会恰好截掉钉扎在最底部的面板窗——电池的护栏已提到 2048。凡「找最底窗口」的探针/电池都要注意。
2. **Electron 下 spawn 的 child.pid ≠ 面板真实主进程 pid**（plain node 下相等）：面板以 boot 存证自报 pid，电池据此找窗/清杀；电池重启面板前须重置存证文件，否则 waitEvent 会命中上一轮的 boot。
3. **电池模式必须压掉「窗口全关默认退出」**：Electron 无 window-all-closed 处理器时关窗即退，电池参照窗销毁会中断电池——accept 模式注册空处理器；面板模式的退出处理器只在 bootPanel 内注册。
4. **渲染层是经典脚本**：tsc 以 module:es2022 出 `dist/renderer/main.js`（类型经 global.d.ts 全局别名，文件零 import/export）；一旦引入运行时模块语法即 SyntaxError。Vite 随票 04 引入后此边界自然消解。
5. cordis Service 在 `ctx.start()` 之后才挂 `ctx.<name>`（首轮冒烟 `kernel.bridge` undefined 即此因）；`ctx.stop()` 拆卸。
6. 评审收编的其余项：`fileEventLog` 目录推导改用 `path.dirname`；report 头不再带「02-battery」前缀重复；`pinToBottom`/`RectLike` 等命名与形状保留现状（「钉扎」是 spec 词汇表对 z 序的正式用词，与「手钉」不同概念；rect 三形状在票 05/06 编排落地时再归一）。

**残留物**：无（电池自清理：记事本 WM_CLOSE+kill、面板 taskkill /T、config 还原、用户窗口逐窗还原、光标归位）。字体沿用系统等宽栈，选型随后续界面票据在 font-compare 候选中落定。
