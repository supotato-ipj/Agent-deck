# 工单02: 交互永不顶起 + 键盘模式

Status: resolved

Spec: `.scratch/generic-deck-fixes/spec.md`（Implementation Decisions「永不激活」「键盘模式」「实施闸门」；User Stories 5-13、19 的 z 序与键盘防回归线）。

## 机制实证（已探明，勿重查）

- 面板是单窗钉底：`win32.ts` `pinToBottom` = SetWindowPos HWND_BOTTOM（SWP_NOACTIVATE）。
- 现状顶起链路：热区点击激活窗口 → Windows 顶起；缓解只有 `hotzone.ts` 25ms 轮询 onLeave 重钉（`index.ts` HotzoneTracker hooks）。
- **前台/激活态下 HWND_BOTTOM 重钉依然生效**（窗口持键盘焦点同时可钉底）——探针 `.scratch/icon-probe/probe3.js` 实证。这是「键盘模式期间也钉底」的可行性依据。

## 实施闸门（第一步，阻断性）

真机验证「**不可激活窗口上点击后程序化聚焦能否稳定拿到键盘**」（Windows 前台锁风险）：

- 在 worktree 的 `.scratch/generic-deck-fixes/` 下写探针脚本（先例：`.scratch/icon-probe/probe3.js`），`focusable: false` 的 BrowserWindow + 合成点击 + `win.setFocusable(true)`/`win.focus()`，断言 GetForegroundWindow 命中面板且 SendInput 字符真落进输入框（渲染层存证或 DOM 取证），重复 ≥5 次全中才算稳。
- 探针跑 Electron 的坑（已踩）：`.scratch` 下 `require('koffi')` 要绝对路径指 app/node_modules；uncaughtException 会弹**阻塞式错误框挂死进程**——务必 uncaughtException 落盘 + setTimeout 看门狗 + `app.exit()`，结果写文件别依赖 stdout。真鼠标点击不可靠（探针窗钉底后埋在真实窗口下），用程序化激活替代。
- **被系统稳定拒绝 → 停**：带证据上报（spec 明文），保底方案「允许激活但点击即重钉」需用户重议，不得擅自切换。

## 实现（闸门通过后）

- **永不激活**（`app/src/main/panel-window.ts`）：`createPanelWindow` 加 `focusable: false`（Windows 下等价无激活扩展样式）。保留全部既有钉底路径：启动首显、`showPanel`（托盘/second-instance/Win+D 恢复共用）、热区离开重钉；**另加** `win.on('focus', () => pinToBottom(win))` 兜底重钉（probe3 实证有效）。
- **键盘模式**：走窗口宿主面（`panel-ipc.ts` wireHostIpc + `preload/index.ts`），**不进内核桥接契约**（ADR-0004 的缝不变）。开 = `setFocusable(true)` + `win.focus()` + 立即 `pinToBottom`；关 = `setFocusable(false)` + `pinToBottom`。全程 EventLog 存证（电池按事件断言）。退出后键盘焦点悬空、**不自动还原**到之前窗口（spec 拍板）。
- **渲染层接线恰好四处**（`app/src/renderer/main.ts`）：`searchActivate()`→开、`searchDeactivate()`→关、`openSettings()`→开、`closeSettings()`→关。注意关模式的窗口失焦会触发 search input blur → `searchDeactivate('blur')` 的再入——设计好护栏别打架（现有 `searchDeactivating` 护栏先例）。
- 交互行为零回归：拖拽摆位（全窗热区那段）、双击启动、单击选中、会话行直达（session/focus 是工具窗口置前，不是面板置前，不受影响）。

## 测试缝

- 离线缝（typecheck + vitest）保持绿；渲染层/宿主面现状无离线单测，不为此新开（真机缝覆盖）。
- **真机验收电池**（`accept/battery.js`，先例：02-pinned-bottom z 序探针）：
  1. 聚焦记事本（既有 overlap 场景）下点击热区：点击后**立即**断言面板仍在记事本之下 + 前台仍是记事本（现状只在离开热区后断言——把「点击顶起」的回归线前移到点击瞬间），并断言无激活扩展样式。
  2. 键盘模式：热区点击搜索卡 → keyboard-mode-on 存证 + 前台=面板 + **面板仍在所有普通窗之下**（键盘模式也钉底）+ SendInput 字符进输入框（焦点到手）；ESC → keyboard-mode-off 存证 + 面板仍钉底。
  3. 设置浮层：开层拿键盘（ESC 可关）、关层恢复不可聚焦。

## 验收

- [x] 闸门探针证据落盘（.scratch/generic-deck-fixes/），结论明确「通过/被拒」
- [x] typecheck + vitest 全绿
- [x] 电池三探针就位（真机全量由合并后在 PR 分支统一跑）
- [x] 既有钉底路径零删减

## Answer

**闸门结论：通过。** 探针 `.scratch/generic-deck-fixes/probe-focus-gate.js`（证据 `probe-focus-gate-result.json`），
6 轮全中：SendInput 点击 focusable:false 窗不夺前台 6/6；`setFocusable(true)+focus()` 后 GetForegroundWindow
命中面板 6/6；SendInput 字符真落输入框（DOM 取证，值累进 a→abcdef）6/6；前台/激活态下立即 HWND_BOTTOM
重钉——仍持前台且落在普通窗之下 6/6（「键盘模式也钉底」可行性再次实证）。第 0 轮首跑曾出现一次
「点击不激活」误报，定位为探针前置伪影（ref 首轮未拿到前台，断言前提不成立）而非面板被激活，
修严取证（ref 前台轮询 + fgAfterClick 身份记录）后 6/6 干净通过。Windows 前台锁未构成稳定拒绝，
保底方案无需启用。

**改动清单**

- `app/src/main/panel-window.ts`：`createPanelWindow` 加 `focusable: false`（WS_EX_NOACTIVATE）。
- `app/src/main/panel-ipc.ts`：`wireHostIpc` 新通道 `deck:host-keyboard-mode`（宿主面，不进 contract.ts）——
  开 = `setFocusable(true)` + `focus()` + 立即 `pinToBottom`；关 = `setFocusable(false)` + `pinToBottom`；
  EventLog 存证 `keyboard-mode-on` / `keyboard-mode-off`；退出不自动还原焦点。
- `app/src/main/index.ts`：`win.on('focus')` 兜底重钉（pin reason=`focus-fallback`）；既有钉底路径
  （启动首显、showPanel 托盘/second-instance/Win+D、热区离开重钉）零删减。
- `app/src/preload/index.ts` + `app/src/renderer/global.d.ts`：`host.setKeyboardMode(on)` 暴露与类型。
- `app/src/renderer/main.ts`：接线恰好四处——`searchActivate()`→开、`searchDeactivate()`→关、
  `openSettings()`→开、`closeSettings()`→关；关模式的失焦再入由既有 `searchDeactivating` 护栏与
  `searchActive`/`settingsOpen` 早退双保险拦住。
- `app/accept/battery.js` 三探针：① P2 段回归线前移到点击瞬间——点击后立即断言面板仍在记事本之下 +
  前台未变 + WS_EX_NOACTIVATE 在场，「点击→离开→重钉」段改写为永不顶起语义；② P7S 段 keyboard-mode-on
  存证 + 前台=面板 + `panelBelowAllNormal`（自顶向下取证面板之下无普通窗）+ Ctrl+V 键程直达输入框，
  ESC 后 keyboard-mode-off + NOACTIVATE 回归 + 仍钉底，`activate` 前台门断言意图不变最小改写；
  ③ P8S 段开层即 mode-on + 前台=面板，ESC 关层后 mode-off + 恢复不可聚焦。
- 闸门探针（独立提交）：`.scratch/generic-deck-fixes/probe-focus-gate.js` + `probe-focus-gate-page.html`
  + `probe-focus-gate-result.json`。

**验证输出摘要**

- `npm run typecheck`：通过（无输出即无错）。
- `npm test`：Test Files 32 passed (32)，Tests 451 passed (451)，33.68s。
- `npm run build`：通过（vite build + copy-assets 全量产物就位）。
- 真机：闸门探针 6/6（见上）。完整 `npm run accept` 按计划合并后在 PR 分支统一跑；
  生产面板在跑（单实例锁），本次未做烟囱起停、未触碰 D:\local_works\agent-deck。

**提交列表**（分支 `feat/gdf-02-never-activate`）

- `85cfa31` chore(generic-deck-fixes): 工单02 认领（ready-for-agent → claimed）
- `6737644` test(generic-deck-fixes): 工单02 实施闸门探针——不可激活窗口程序化聚焦 6/6 稳定拿到键盘（闸门通过）
- `145a0f8` feat(app): 工单02 交互永不顶起+键盘模式——面板创建即不可激活，键盘场景经宿主面临时聚焦
- `4b94e13` test(app): 工单02 验收电池三探针——永不顶起前移到点击瞬间/键盘模式钉底拿键盘/设置浮层开关层
