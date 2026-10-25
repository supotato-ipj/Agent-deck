# 06: 编排与推荐

**What to build:** 分区语义平移完成：归类（应用入口入应用区、其余入文档区）、编排（首次全量 + 单项增量）、栏位分配（手钉在前、推荐位按使用频次填补、时间衰减加权）、冷启动先验（自建使用日志尚空时借系统启动记录折算初始频次）、使用日志移植（只含进程路径与时间戳，不含窗口标题）。区内跨区拖拽摆位并持久化；桌面文件夹监听增删同步（新项自动归类、删除项消失）；恢复出厂布局动作。漂移纠正与布局快照不迁移（自绘布局不受系统打扰）。

**Blocked by:** 05 桌面承载尖兵

**Status:** ready-for-human

- [x] 拖拽条目区内/跨区摆位，重启面板后位置保持
- [x] 新建桌面文件自动归类入区；删除文件后条目同步消失（电池探针）
- [x] 手钉条目稳定占据 dock 前段，推荐位按使用频次排序填充
- [x] 使用日志为空时冷启动先验生效（离线测试覆盖）
- [x] 归类/编排/栏位/频次/监听纯逻辑 vitest 全绿（Python 先例移植）
- [x] 恢复出厂布局一键回到出厂态
- [x] 真机截图存证于工单评论（本文件下「Comments」+ accept/evidence/06-*.png）

## Comments

**2026-09-27 实现落地 + 验收电池 47/47 连跑两轮全绿（收编前后各一轮）+ vitest 210/210**

**架构：编排语义层（plan.ts）+ 摆位存储（layout-store.ts）+ 使用频次（usage/*）**

- `desktop/plan.ts`（纯，zones_plan.py 自绘版平移）：归类沿用 05 的 isAppEntry；**文档区按组聚合**——固定组序 folders/office/pdf/image/archive/other、每组一列、组间空一列、组内新在上（mtime 降序同值按名）、满 docMaxRows 折本组右侧相邻列（Python DOC_MAX_ROWS 先例，经 config 下发）；**dock 栏位分配**两段拼接——手钉按清单序占最前、显式摆位紧随、剩余按使用分数降序填补（同分按名稳定、无分数记 0 仍参与），手钉永不被推荐顶替。自绘世界无坐标：输出语义位置（dock 序 + 文档组/列/行），渲染层按序自绘。「首次全量 + 单项增量」收敛为**每次扫描全量重算**——自绘布局没有写盘探针的代价，显式摆位在重算中天然存续（增量语义被全量重算子约，Python 的增量是为了少动真图标而存在）。
- `desktop/layout-store.ts`（纯）：摆位存储 = `pinned`（手钉清单）+ `dock`/`docs`（显式摆位有序名单，成员制非坐标制——「拖到哪」记成「排在谁前面」）。名单允许陈旧名字（文件删除后摆位保留，文件回来位置还在）；损坏 JSON 自愈出厂态；恢复出厂 = 清 dock/docs 留 pinned。**漂移纠正与布局快照不迁移**（自绘布局不受系统打扰），出厂态即「无显式摆位」。
- `desktop/watch.ts`（纯逻辑 + fs.watch）：两个桌面根目录监听，事件 settle（300ms 静默）合并拷入风暴后触发一次重扫描——「新建自动入池、删除同步消失」从 05 的 1Hz 提到亚秒级；监听错误静默退场，1Hz 重扫描兜底网在场。触发不分增删改：条目池集合运算（指纹 diff）自会分辨。
- `usage/log.ts`（纯，usage_log.py 平移）：pid 差分识别真启动（新 pid 各计一次——同路径第二实例与退出重启都数得到）、前台差分识别聚焦；start/focus 各写各的按天 JSONL，**每条记录只有 ts 与 exe**（ADR-0002）；90 天滚动清理（boot 一轮 + 内核每小时一轮）。spec 有源码级隐私守卫测试（GetWindowText/window_title 全仓禁现）。
- `usage/score.ts`（纯，usage_score.py 平移）：衰减半衰期 14 天；UserAssist 值解析（ROT13 值名 + count@4/FILETIME@60 布局，零时间戳拒绝）；**融合在条目层面**——日志与先验各自映射到条目（.exe 经 lnk 目标反查；.lnk 先验目标一致才认；盘上存在却解不出目标的 lnk 不回退 stem——Python 同义「宁可不认不错挂」；盘上不存在的 shell 别名路径才按 stem 对齐），再按 1/(1+日志启动次数) 让先验退位——日志为空权重 1（冷启动先验撑起首版排名），日志积累后先验退场；大小写差异不裂应用。
- `usage/userassist.ts`：reg.exe **export 导出 .reg 再纯解析**（比 advapi32 枚举稳，ROT13 名字的引号/反斜杠由 reg 转义层兜住）；长 hex 折行续接处理；**异步 execFile**——一次性 reg 导出成本不堵 boot 关键路径（05「dock 随首绘就位」教训），先验晚到只影响推荐序初值，1Hz 重算自然收敛。失败空表（先验可缺位）。
- `usage/native.ts`：EnumProcesses + QueryFullProcessImageNameW（koffi 延迟绑定，out 参数走 Buffer 与电池 lib 实证形态一致）；全程不获取窗口标题。
- `services/usage.ts`：UsageService——collect 状态机 + iconScores 端到端打分；采集轮询/滚动清理由内核定时器驱动。
- `services/desktop.ts` 扩展：每次扫描后套用摆位覆盖（dock/docs 名单成员改写 zone，跨区拖拽即换区）→ 全量编排；`move`（校验：池内名字、参照在目标分区、非自身；**手钉条目在应用区内显式拒绝拖动**——栏位由手钉清单决定，拖了也会弹回，显式报错而非无声失效；跨区拖出手钉仍允许）落盘后即时重编排；`resetLayout` 清摆位留手钉；lnk 目标按 iconKey 缓存（mtime 变更即重解析）。
- 指纹升级：条目指纹 + 编排指纹拼接——dock 序/文档列位任一变化渲染层即重排，条目集合不变则图标缓存不动。

**桥接契约扩展（只扩表不开新通道）**：`DesktopState += plan{dock,docs}`；`PanelSnapshot += layout{docZone,docMaxRows,dockMaxWidth}`（config.json 新 desktop 段下发，缺省 = renderer 生产值固化，老 config 兼容）；`desktop/move {name,zone,beforeName}→{ok,error?}`；`desktop/reset-layout →{ok,cleared}`。

**渲染层**：dock 按 plan.dock 序铺条；文档区改分组列块（每组极小标签 + 满行折列）；**拖拽摆位 = 指针事件自实现**（非 HTML5 DnD——合成 SendInput 驱不动 OLE 拖放协议，且自绘世界要的是「排在谁前面」语义）：6px 阈值起拖、幽灵贴光标、落点参照高亮、拖拽期全窗热区（中途路过非热区空档不转穿透，pointer 流不断）；RESET LAYOUT 右下角一键回出厂（08 设置浮层收编前的过渡入口，已在代码注明）。

**逐条验收证据（`app/accept/evidence/`，电池输出 03-battery.log.txt，47/47 连续两轮）**

- **手钉前段**：P5.5a 种子 layout.json（pinned=[Kimi.lnk]）→ dock 首位 source=pinned、其余 9 项全 recommended；实拍 `06-dock-pinned.png`。
- **新建自动归类**：P5.5b 造 docx+pdf 探针 → docEntries 归 office/pdf 组、实拍 `06-doc-groups.png`；删除后条目同步消失。
- **拖拽摆位**：P5.5c SendInput 按下-12 步移动-抬起真拖 dock 末位条目至第 2 位之前 → `desktop-moved ok=true` + 渲染序更新（`desktop-rendered` dock 序反转）+ 实拍 `06-drag-moved.png`。
- **重启保持**：P5.5c 重启面板后 dock 序不变（layout.json 持久化），实拍 `06-drag-persisted.png`。
- **恢复出厂**：P5.5d 点击 RESET LAYOUT → `desktop-layout-reset ok=true cleared=1`、非手钉全回推荐位、手钉保留前段，实拍 `06-factory-reset.png`。
- **离线**：vitest 210/210——编排（zones_plan_doc/recommend 移植 23 例）、摆位存储 10 例、使用日志/频次（usage_log/score 移植 30 例+隐私守卫）、看门狗真 fs.watch 4 例、服务编排/摆位 11 例、契约 move/reset 3 例、config desktop 段 5 例。

**真机踩坑记录（后续工单注意）**

1. **右下角是通知横幅高发遮挡位**：RESET 按钮首版 bottom:20，首轮电池点击被瞬时浮层吞掉（WindowFromPoint 实证面板命中时也可能被即将弹出的横幅抢先）——按钮抬到 bottom:64 + 电池侧遮挡探测（ESC 收层重试）+ 复位点击无响应 1s 后补射一轮。三层兜底后连两轮全绿。
2. **分数异步就位会让 dock 首拍（名序）在 ~1s 后重排为频次序**：电池拿首拍矩形去点击会点在换位后的别的条目上（05 的「单击选中」首轮实测踩中）——电池新增 `waitStable`（事件安静 1.5s 才取矩形）。
3. **电池轮次间的状态污染**：调试探针 taskkill /T 会连守卫一起杀（无还原路径）→ HideIcons 残留 1 → 下一轮电池基线被污染、P5 还原断言失败。清场必须走 --icon-restore 并核实 reg 偏好回 0；跨轮次的「用户状态」备份（layout.json）同样可能把种子带进下一轮。
4. **同步 reg.exe export 在 boot 关键路径上最坏 15s**（评审收编前的事实）：改 execFile 异步 + 先验晚到不阻塞——「冷启动先验」的语义是空日志时撑排名初值，晚到几百 ms 无伤。

**Code-review 收编（两轴并行）**：plan.ts 条目类型与契约面去重（删 DockPlacement/DocPlacement 双声明，import contract）；`DesktopSlotSource` → `DesktopDockSource`（CONTEXT.md 词汇「栏位」避「槽位」）；desktopFingerprint/planFingerprint 共享 fnv1a；userDataPath 助手收口 layout.json/usage 目录的 electron-catch-LOCALAPPDATA 三连；userassist 删无用 rot13 转出；bridge zone 类型改用契约 DesktopZone；renderer itemUnder 的 el0 → hit；滚动清理每小时一轮（Python run_loop 先例，常驻面板不能只靠重启收敛）；手钉应用区拖拽显式拒绝；lnk stem 回退加盘上存在性守卫（Python 同义）；先验读取异步化。**有意保留**：RESET LAYOUT 独立按钮（08 设置浮层的过渡入口）；watch.spec 用真 fs.watch/真时钟（libuv 事件绕过假定时器，文件内注明）；watchDesktopRoots deps 间隙（watch.ts 纯逻辑已测，安装薄壳不值得假源）。

**移交 07/08 的注意**：① 手钉目前只能手改 layout.json（pinned 数组）——08 设置浮层应给「右键钉住/取消钉住」或等价的用户通道，`desktop/move` 对手钉在应用区内是显式拒绝（error 文案已写明去 layout.json 改）；② 分区标签位未独立进 config（DOCS 标签随 docZone 原点、dock 无标签），story 9 的「分区标签位」以 config 兜底缺省覆盖，08 如需挪标签再加字段；③ 使用日志 focus 事件已落盘但打分只吃 start（07「真启动次数」同源）；④ 拖拽渲染层的 desktop-rendered rects 存证可直接复用为更多真鼠标探针的落点来源。

**残留物**：无（电池清场：探针 lnk/docx/pdf/标记文件删除、托盘 IsPromoted 还原、图标状态回电池前 visible、layout.json 清场还原/删除、无残留 electron 进程、光标归位；本机 HideIcons=0 核实）。
