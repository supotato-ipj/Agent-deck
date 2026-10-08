# 工单132 执行报告——第一阶段定嫌 + 第二阶段修复 + 真机验证

## 第一阶段：H1/H7 双双证伪，根因为「stdout 管道写阻塞」（新立并实锤）

预登记的两臂对照（docs/audit/2026-10-09-t132-stall-duel-experiment.md）第一轮即翻案：**r1 A/B 两臂同冻**（kb 臂 boot 后 ~13s、sys 臂 ~27s 终末冻结）→ H1 出局；随后消元阶梯（raw 去 CDP / still 纯探针 / bare 零接触）逐一排除 CDP、鼠标合成、像素捕获、探针、记事本、taskbar 配置——**零接触裸面板也在 boot 后 +15.8s 定时刻终末冻结** → H7（系统输入管线）出局，H2/H4 修正版一并出局（无输入、无 Win+D 也冻）。

**栈取证**（r3-bare 冻结瞬间 koffi MiniDumpWriteDump，产物 `app/accept/evidence/stall-duel/1a/r3-bare/freeze-main.dmp`）：主线程阻塞在 KERNELBASE 写路径系统调用，RSP 栈含 windows.storage/oleaut32/CallWindowProcW/KiUserCallbackDispatcher，全 64 线程 Wait、spans 全闭合（卡点在未标注区，与 #117 取证「不在 11 个子系统内」一致）。

**干预对照**（决定性）：harness 排空面板子进程 stdout 后，零接触轮 ×3 全部 240s 存活、0 停摆；未排空的 7 轮（跨全部臂与 taskbar 配置）全部 +13~30s 冻结。排空轮实测 stdout 流量 **1,407,772 字节/240s（~6KB/s，两轮逐字节相同=确定性写入者）**，采样指认：

```
[W] app Error: property desktop is not registered, declare it as `inject` to suppress this warning
    at Object.resolveShortcutTarget (…services/taskbar.js) × 1190 次/240s
```

**根因两层**：
1. **喂料端**：生产装配（panel-kernel + DataplaneService）不在主进程注册 desktop 服务，TaskbarService 推荐位每拍解析 lnk 的默认兜底读 `ctx.desktop`——cordis 对未声明属性的访问每次落一条带全栈 [W] 告警（工单59 时代的 try/catch 只挡异常没挡告警）。单测内核（LocalPanelDataService）注册了 desktop，故从未复现。
2. **阻塞端**：验收控制器把面板 stdout 接成管道而不排空（battery.js `stdio:['ignore','pipe','pipe']` 只读 stderr）——64KB 匿名管道 ~11s 写满，主线程下一次同步写**永久阻塞**。

**对历史证据的回读**（全部吻合）：#97/#108/#127 全系「主进程假死」即此——电池每 (re)拉起面板 ~15s 冻死，懒探活让轮次带伤爬行，heal 重启→再冻→「重启恶性循环/双面板/12 波排除窗」；P9「cover-engaged 后卡死」= ShowWindow 撞已冻面板（次生，本票已修）；「真重启仍卡死」= 与机器态无关、与面板代际无关、只与管道形态有关。用户常驻面板不挂：Explorer 启动的 GUI 进程无 stdout 管道（写无效句柄即失败不阻塞）。

## 第二阶段：修复（ADR-0011 两约束之① + 根因双侧）

- `app/src/main/services/taskbar.ts`：`static inject` 声明 desktop 为可选依赖（`{ required: false }`）——告警源头抑制，缺席照旧走 Electron 兜底。单测 `tests/taskbar-inject-warning.spec.ts` 红绿双验锁定（旧声明红：1 告警；新声明绿：0 告警）。
- `app/accept/battery.js`：launchPanel 与 P7 二次拉起子进程 **stdout 排空**（结构防御）；**P9 恢复等待有界化**（ShowWindow→PostMessage WM_SYSCOMMAND/SC_MINIMIZE，停摆面板不再挂死电池）；**heal 有界唤醒窗 8s**（ADR-0011 约束①：检出后留窗让滞后哨兵迟到拍落盘再清障，窗末重读事件文件补取证）。
- `app/accept/taskbar-carry.js` / `tray-spike.js`：同款排空。
- 实验 harness（`app/accept/experiments/stall-duel.js` + 分析器纯函数单测）随票入库，供后续取证复用。

## 真机验证（guard 托管）

- 修复前基线（#127 时代，同机）：6 轮 pass=50~94 / fail=43~75，停摆级联+排除窗成片。
- 修复后本分支：连续轮 VERDICT `FAIL-CODE (pass=166 fail=4 excluded=0)`——**零排除窗、零停摆、零 heal**。剩余 4 个 FAIL 经基线判别定责（详见 PR）。
