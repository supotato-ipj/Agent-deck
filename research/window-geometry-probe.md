# 工单372 探针结论文档：外部窗口几何写入与首次操作取消验证（spec #369 原生门槛）

- 探针：`app/accept/experiments/t372-window-geom-probe.js`（取证探针，同 t249/t371 先例，**不是验收电池段**）
- 正式出证轮：guard `accept-sprint` 托管，exit 0，断言全部通过 → `app/accept/evidence/372-window-geom-probe.log.txt`
- 运行环境：Windows 11 build 26300，主屏 2560×1440，系统 DPI 96（scale=1.00x），控制器 Per-Monitor V2
- 对照材料：spec #369 决策 8（窗口几何控制器）、决策 10（首次确认交互）、决策 12（容量与异常）、决策 30（失败关闭）；ADR-0028「几何状态」

## 一、裁决：go（附边界）

生产几何控制链的承重柱全部实测成立：

1. **跨进程读几何**：`GetWindowRect` + `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` + `GetDpiForWindow` + `GetWindowDpiAwarenessContext` 对 7 扇代表窗（真实第三方 notepad / msedge、Electron、4 扇跨进程 Win32 对照窗）全部可读。`GetWindowRect` 给外框矩形、DWM 扩展框给可见边框（比外框小 ~7px，无边框窗两者相等）——生产做「窗格对齐」时应选 `DWMWA_EXTENDED_FRAME_BOUNDS`，做「写回原样复原」时应选 `GetWindowRect`。
2. **跨进程写几何**：`SetWindowPos`（`SWP_NOZORDER|SWP_NOACTIVATE`）移动与缩放对全部可写代表窗逐像素生效（容差 1px 实测 0 偏差）。坐标口径：控制器 Per-Monitor V2 下**全部坐标为物理 px**，与目标窗自身的 DPI awareness 无关（msedge/notepad/electron 各自 ctx 不同，物理 px 写入一律生效）。
3. **首次操作取消/确认**：SendInput 真拖动与 `WM_SYSCOMMAND`（`SC_MAXIMIZE`/`SC_RESTORE`）最大化两条入口实测——首次操作后写回原矩形可逐像素复原；确认等待期零漂移、零外部事件、零新增写窗；确认后重新发起的操作生效。`WM_SYSCOMMAND` 跨进程 PostMessage 是可用入口（notepad 与 Electron 都响应）。
4. **回声抑制与 reconciliation**：`SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, WINEVENT_OUTOFCONTEXT)` 事件流可用；「自身写窗登记期望矩形（pending）→ 事件命中期望矩形归类 echo」的抑制模型实测单次写、不循环、静置 800ms 零再写；外部改窗（伴生进程自改）正确归类 external，reconciliation 单发落位、无乒乓。
5. **降级面**：见下表——固定尺寸/拒绝改窗可诊断可预期，自绘无边框不必然降级，降级不阻塞其他窗口。

## 二、应用兼容矩阵（正式轮实测）

| 代表窗 | 形态 | 读几何 | 写移动 | 写缩放 | DPI 口径（dpi / awareness ctx） | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| notepad（Win11 记事本） | 真实第三方 Win32 | OK | OK | OK | 96 / PER_MONITOR_AWARE_V2 | 单实例：新窗落进既有 notepad 进程 |
| msedge（独立临时 profile） | 真实第三方 Chromium | OK | OK | OK | 96 / PER_MONITOR_AWARE_V2 | `WM_SYSCOMMAND` 与 SetWindowPos 均生效 |
| electron（BrowserWindow） | Chromium/Electron | OK | OK | OK | 96 / PER_MONITOR_AWARE | ctx 与其他窗不同，物理 px 写入不受影响 |
| win32-plain | 跨进程对照 | OK | OK | OK | 96 / PER_MONITOR_AWARE_V2 | 基线 |
| win32-fixed（无 THICKFRAME/MAXIMIZEBOX） | 固定尺寸 | OK | 移动 OK | **钉死（降级）** | 96 / PER_MONITOR_AWARE_V2 | `WM_WINDOWPOSCHANGING` 回写 WINDOWPOS 钉死 cx/cy；单次尝试即可判定 |
| win32-reject（消息层主动回写） | 拒绝改窗 | OK | 移动 OK | **钉死（降级）** | 96 / PER_MONITOR_AWARE_V2 | 同上机制；写入结果可预期 → 诊断分类「异常未平铺-拒绝改窗」 |
| win32-popup（WS_POPUP 无边框） | 自绘形态 | OK | OK | OK | 96 / PER_MONITOR_AWARE_V2 | 自绘无边框**不必然**拒绝外部几何写入 |
| 高 IL（权限不足）窗 | — | **N/T** | N/T | N/T | — | 本机无确定性判定的高 IL 测试对象（探测到疑似 1 例 cua-driver，探针不写用户窗口、不申请提权）；生产按失败分类+单次尝试+不重试+诊断上报兜底 |

**结论口径**：矩阵支持「确定性平铺写窗 + 异常未平铺降级」可行；异常分类（固定尺寸/拒绝改窗）通过**一次写 + 回读比对**即可判别，无需反复探测。

## 三、重要发现（实现票直接可用的坑位清单）

1. **Electron 主进程不得 attach `process.stdin`**——一旦挂 stdin 监听，BrowserWindow 原生句柄在 ~1s 内被销毁（进程存活、无 `closed` 事件、`win.isDestroyed()` 无从反映），已二分坐实（data:URL 与 webPreferences 均排除）。生产若需要向 Electron 窗发命令，用别的不经主进程 stdin 的通道。另外 `loadURL('data:text/html,…')` 同样导致窗体早毁（`about:blank` 正常）。
2. **koffi 2.16.3 两处硬约束**：
   - `koffi.as(-4, 'void *')` 恒 `Invalid argument` → `SetProcessDpiAwarenessContext` 的 DPI_AWARENESS_CONTEXT 常量必须以 `int64_t` 形参传递（ABI 同为 64 位）。**注意：t371 的 try/catch 写法（`koffi.as`）实际一直静默失败**，本机 scale=100% 掩盖了它；t372 用 int64 绑定首次真正设置 PMv2。
   - `WM_WINDOWPOSCHANGING` 的 lParam 必须以 `void *` 进 koffi 回调才能 `koffi.decode/encode` 写回 WINDOWPOS；裸数字地址 decode/encode 均拒收。koffi.proto 注册后要用**字符串名** `'T372_WinEventProc *'` 注册回调（proto 返回对象不能与 `' *'` 拼接）。
   - 附带发现：`lib/win32.js` 的 `exeNameOfWindow` 返回**不带 `.exe` 的 basename**（如 `notepad`）——按影像名匹配窗口时先归一。
3. **Win11 notepad 单实例**：spawn 的 notepad.exe 常是激活 stub，新窗落在既有 notepad 进程——按「启动前可见窗 hwnd 快照差集」识别自己拉起的窗；清理只对该窗 `WM_CLOSE`，绝不 taskkill 用户进程。Edge 同理经启动器转手、进程树不挂 spawn pid 下，用 tasklist **pid 差集**圈定探针新增进程再 taskkill。
4. **事件流必须持续泵消息**：WinEvent out-of-context 回调靠挂接线程的消息循环派发，探针所有等待都经 `PeekMessage` 泵（纯 `sleep` 会饿死事件流）。回声窗口 1500ms 实测够用；静置 800ms 无新事件即稳定。
5. **`WM_SYSCOMMAND` 是跨进程最大化/还原的可靠入口**（notepad/Electron 实测），`SC_RESTORE` 还原矩形逐像素等值——生产「首次操作复原」不需要自己记录矩形再写回（最大化路径），但移动/拖动路径仍需 `SetWindowPos` 写回原矩形（同样逐像素成立）。

## 四、权限不足（高 IL）行的边界说明

- 探针**不申请提权、不写用户窗口**：本机仅探测到 1 个疑似高 IL 进程窗（cua-driver，机器上的既有驱动进程），其身份不适合当测试对象；确定性构造高 IL 测试窗需要 UAC，超出探针边界。
- 该行记 **N/T**，不冒充测试通过。生产侧等价防线已在另两行实证：写入失败的判定（回读比对）与单次尝试不重试的分类逻辑，与「权限不足」场景共用的正是同一失败通道（决策 12「权限不足进入异常未平铺」）。
- 未决边界（诚实留档）：`SetWindowPos` 是否受 UIPI 约束（对高 IL 窗是否静默生效）本轮未测得——生产实现仍应把「写后回读不符」作为唯一成功判据，不依赖调用返回值。

## 五、与票面验收标准的对应

| 标准 | 证据 |
| --- | --- |
| 普通 Win32 与 Chromium/Electron 窗可读写目标几何，坐标和 DPI 口径有实测记录 | S3/S4 全 PASS + 第二节矩阵（物理 px、Per-Monitor V2、各窗 ctx 逐行记录） |
| 首次几何操作能恢复原状并等待确认，确认后只有重新发起的操作生效 | S5A（真拖动复原/确认等待零写零漂移/重新发起生效）+ S5B（notepad/Electron 最大化双代表）全 PASS |
| 自身写窗事件不形成反复改窗循环，外部改窗能被识别并 reconciliation | S6a（全 echo、单写、静置零再写）+ S6b（external 识别、单发落位、无乒乓）PASS |
| 固定尺寸、自绘和权限不足窗口有限、可诊断、不阻塞的降级 | S7a/S7b/S7c/S7e PASS；权限不足 N/T 如实记录（第四节） |
| 探针退出零残留，验收专用绑定不当生产能力 | S8 全 PASS（进程圈定集全退、影像名计数不高于基线、临时目录删除、任务栏状态不变、hook 卸载）；探针声明「能力不记作生产完成」 |
| 结果明确支持或否决生产几何控制链，并列出应用兼容矩阵 | 本文档第一节 **go** 裁决 + 第二节矩阵 |

**go/no-go 判读**：探针能力不记作生产完成——生产几何控制器仍需按 spec #369 决策 8/10/12/30 实现授权状态机与失败关闭；本探针只裁决「原生路径可行、具体 Win32 组合选定」。
