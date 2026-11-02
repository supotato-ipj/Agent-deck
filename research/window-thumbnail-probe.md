# 工单373 探针结论文档：外部窗口实时缩略图与最小化降级验证（spec #369 原生门槛）

- 探针：`app/accept/experiments/t373-window-thumbnail-probe.js`（取证探针，同 t249/t371/t372 先例，**不是验收电池段**）
- 正式出证轮：guard `accept-sprint` 托管，exit 0，断言全部通过（此前开发轮 r14/r15 连续两轮全绿）→ `app/accept/evidence/373-window-thumbnail-probe.log.txt`
- 运行环境：Windows 11 build 26300，主屏 2560×1440，系统 DPI 96（scale=1.00x），控制器 Per-Monitor V2
- 对照材料：spec #369 决策 15（窗口预览服务）、决策 26（胶囊 200ms 预算）、决策 30（失败关闭）；ADR-0028「预览与数据」「恢复与性能」；GLOSSARY「窗口预览」

## 一、裁决：go（附边界）

生产预览链的承重柱全部实测成立：

1. **实时缩略图跨进程成立**：`DwmRegisterThumbnail`（面板持有目标窗 → 外部源窗）+ `DwmUpdateThumbnailProperties`（`DWM_TNP_RECTDESTINATION | OPACITY | VISIBLE | SOURCECLIENTAREAONLY`，目标矩形=目标窗客户坐标，源取客户区）对 5 扇代表性源窗（真实第三方 notepad / msedge、Electron、探针伴生 Win32 plain 与自绘 WS_POPUP）全部注册呈现。**实时性有直接证据**：源窗 `setcolor` 颜色切换后缩略图 11–21ms 跟随；notepad/msedge/electron 几何驱动内容变化后缩略图 6–24ms 像素差可见——缩略图是持续流，不是注册时静态帧。
2. **平台硬约束（实现票必须遵守）**：`DwmRegisterThumbnail` 的**目标窗必须属调用进程**——目标窗为另一进程（Electron BrowserWindow）时恒 `E_INVALIDARG (0x80070057)`，同轮探针自有目标窗 6 格注册全部成功。生产必须**在面板进程内**对自家窗口注册，与 spec 决策 15「目标窗必须由面板持有」一致；不能在独立 helper 进程里代注册。
3. **最小化降级链成立**：最小化前 `PrintWindow(PW_RENDERFULLCONTENT)` 抓内存位图（实测品红占比 0.87）→ 最小化后注销实时关系、`StretchBlt` 缓存入目标格（55ms 内可见、特征色像素比对通过）→ 无缓存时回退**图标+标题**（WM_GETICON→GetClassLongPtrW→ExtractIconExW(exe) 链 + GetWindowTextW，44ms 内可见）。
4. **释放与不落盘成立**：全部 `DwmUnregisterThumbnail` 后 6 格回底色；同源再注册成立（关系可完全释放重建，无泄漏锁死）；缓存 GDI 资源显式销毁；缩略图全流程文件清单前后比对**零新增图像文件**（临时目录与证据目录；edge-profile 内 Chromium 自管缓存不计——非探针写路径）。缓存只存内存是**结构性质**（PrintWindow→DIB→Buffer，代码中无图像文件写调用）。
5. **时延远低于 200ms 预算**（见第四节账本）：逐张填入 11–23ms、实时传播 6–24ms、缓存填入 48–55ms、回退填入 45–67ms。DWM 侧全部环节合计离 200ms 预算有一个数量级余量；胶囊点击→预览窗打开的 UI 段属 UI 层，不在本探针（诚实留档）。

## 二、兼容矩阵（正式轮实测，逐项记录、不作无条件承诺）

| 源窗 | 形态 | 实时缩略图 | 实时传播 | 最小化后 DWM 行为 | 缓存/回退 |
| --- | --- | --- | --- | --- | --- |
| win32-live | 探针伴生 Win32（GDI 自绘） | OK | OK（setcolor 21ms） | **冻结（最后一帧留存）** | 缓存 OK（最小化前抓） |
| notepad | 真实第三方 Win32 | OK | OK（几何重渲染 24ms） | 冻结（blank 0.084 / frozen 0.991） | 无缓存回退图标+标题 OK（GCLP_HICON + 标题） |
| msedge | 真实第三方 Chromium（硬件加速，--app 独立 profile） | OK | OK（几何重排 21ms） | 冻结 | —（行为记录） |
| electron | Chromium/Electron 源窗 | OK | OK（几何重排 17ms） | 冻结 | —（行为记录） |
| win32-popup | 自绘无边框 WS_POPUP | OK | OK（setcolor 11ms） | 冻结 | —（行为记录） |
| cloak-self（同进程） | DWMWA_CLOAK=1（CLOAKED 读回=1） | OK（cloaking 前呈现） | — | — | cloak 期间**冻结（最后一帧留存）**；解除后恢复呈现 |
| electron-dest（跨进程目标） | Electron BrowserWindow 作目标窗 | **E_INVALIDARG**——目标窗须属调用进程（平台约束，非缺陷） | — | — | — |
| win32-cloak（跨进程置 cloak） | medium-IL 对他人窗置 DWMWA_CLOAK | — | — | — | **E_ACCESSDENIED 被拒（N/T）**——生产对他人窗不可主动 cloak，只能经 `DWMWA_CLOAKED` 读回识别（如其他虚拟桌面窗） |

**关键实测语义**（实现票直接可用）：

- **最小化 = 冻结而非空白**：本机 5 扇源窗最小化后 DWM 实时缩略图全部留存最后一帧（blankRatio≈0、frozenRatio≈1.0）。生产语义上「冻结的最后画面」与「内存缓存」可以统一，但仍须显式抓缓存：下一节。
- **最小化后再抓 PrintWindow 不可靠**：win32-live 最小化后 `PrintWindow` 返回成功但内容全非（品红占比 0.00）——**缓存必须在最小化前抓取**，这是实测结论不是猜测。
- **图标回退链**：notepad 走 `GCLP_HICON` 即得图标；`WM_GETICON` 未中时 `GetClassLongPtrW` 兜住；进程 exe `ExtractIconExW` 是最后兜底。标题 `GetWindowTextW` 正常。

## 三、重要发现（实现票直接可用的坑位清单）

1. **koffi 2.16.3 输入型结构指针传 plain object 会被静默错转**（本票 r2 实测，全轮像素证据全零的根因）：`FillRect` 的 RECT、`DWM_THUMBNAIL_PROPERTIES`、`GetDIBits` 的 BITMAPINFO 一律手工打包 Buffer；**输出型**结构指针的 `[{}]` 模式沿 t372 `GetWindowRect` 先例成立。`GetDIBits` 的 BITMAPINFO 头是入参（biWidth/biBitCount/biHeight 须预填），`[{}]` 空对象会让它读出全零。
2. **`GetDIBits` 硬约束**：位图处于选中进 DC 状态时调用会得到全零缓冲——先 `SelectObject` 归位再读；缓存位图读完后**重新选中**（后续 `StretchBlt` 渲染需要），释放时再归位。
3. **GPU 窗捕获色移位 + Edge auto-dark**：Chromium 窗的屏幕捕获色会被色彩管理移位（#00c800→5ec42d）且 Edge 对浅色页 auto-dark（#00c800→264e12）——**GPU 窗的内容判定不能用精确色比对**，探针用通道支配启发式；探针页用 `position:fixed;inset:0` 铺满（Edge --app 下 html/body 高度链只画出下半屏）。
4. **Chromium 后台节流不可依赖**：JS `setInterval`/CSS 动画在可见但未聚焦的 Chromium 窗里会被节流冻结（r6/r7 实证源页单色）——探针改用**几何驱动内容变化**（跨进程 SetWindowPos 改宽 → 双色分栏边界移动）作确定性实时传播信号，t372 已证该写法对 msedge/electron 跨进程生效。
5. **目标窗矩形口径**：`rcDestination` 用目标窗**客户坐标**；WS_POPUP 客户区==窗口区换算最简。Electron 目标窗用 `GetClientRect`+`ClientToScreen` 换算（探针在屏幕坐标取证）。
6. **notepad 清理纪律**：Win11 notepad 单实例复用既有进程（本机 pid 33684 跨轮不变）——只按 hwnd 快照差集识别自己的窗、`WM_CLOSE` 收尾，绝不 taskkill 用户进程；且**不向 notepad 打字**（typed 内容触发保存提示污染清理路径），实时传播改走几何重渲染。
7. **源窗置顶**：探针把全部源窗 `HWND_TOPMOST`，像素取证区（源窗本体与缩略图格）不容桌面既有窗部分遮挡（r8 实证 electron 源窗左半被遮）。
8. **cloak 边界**：medium-IL 进程对**他人窗**置 `DWMWA_CLOAK` 被拒（E_ACCESSDENIED）；**自有窗**可置可读（CLOAKED=1），cloak 期间缩略图冻结最后一帧、解除后恢复。生产对「其他虚拟桌面窗」（系统 cloak）的缩略图行为按冻结帧预期设计并留失败回退（决策 30）。

## 四、时延账本（正式轮实测，支撑 200ms 主交互预算评审）

| 环节 | 实测（正式轮） | 开发轮范围（r5–r14） |
| --- | --- | --- |
| 打开（首格注册→首帧） | 12.4ms | 6.6–13.7ms |
| 逐张填入（注册→首帧，5 扇） | 11.9–22.7ms | 6.6–32.2ms |
| 实时传播（内容变化→跟随） | 17.0–24.3ms | 5.2–26.4ms |
| 缓存填入（最小化态） | 55.1ms | 48.1–55.1ms |
| 回退填入（图标+标题） | 44.7ms | 44.7–80.6ms |

评审口径：**DWM 注册→首帧**是预览「填入」的承重段，实测 ≤23ms；把注册作异步逐张填入（先开胶囊后填图）时，胶囊 200ms 可交互预算中 DWM 环节占比 <12%。胶囊点击→预览窗打开的 UI 段（浮层窗创建/定位）不在本探针，属窗口预览实现票的验收面。

## 五、与票面验收标准的对应

| 标准 | 证据 |
| --- | --- |
| 可见代表窗在面板持有目标窗中呈现实时内容 | S3 五扇 PASS + 实时传播四路 PASS（setcolor/几何重渲染/几何重排） |
| 最小化窗口展示最近缓存，无法捕获回退图标+标题 | S4a 缓存 PASS（特征色比对）+ S4b 回退 PASS（GCLP_HICON+标题，44.7ms）；最小化后再抓不可靠已实测留档 |
| 最小化/自绘/硬件加速/cloak 逐项记录，不作无条件承诺 | 第二节矩阵逐行实测（最小化=冻结、自绘 OK、GPU OK、cloak=冻结+跨进程被拒 N/T） |
| 预览关闭后关系/位图/缓存全释放，不建磁盘缓存 | S6a 注销回底色 + S6b 再注册成立 + S6c GDI 销毁 + S6d 文件清单零新增 |
| 打开与逐张填入实测时延，支撑 200ms 预算评审 | 第四节账本（打开 12.4ms、逐张 11.9–22.7ms） |
| 明确支持或否决生产预览链，不记作生产完成 | 第一节 **go（附边界）** + 「探针能力不记作生产完成」判读行 |

**go/no-go 判读**：探针能力不记作生产完成——生产窗口预览仍需按 spec #369 决策 15/26/30 与 ADR-0028 实现预览服务、生命周期（目标窗由面板持有、面板进程内注册）与失败关闭；本探针只裁决「原生路径可行、DWM API 组合选定、时延预算成立」。
