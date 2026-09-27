# 05: 桌面承载尖兵

**What to build:** 面板接管桌面承载第一段：启动时隐藏原生桌面图标（退出与崩溃时自动还原，绝不留空桌面）；扫描用户桌面与公共桌面合并去重得桌面项池；图标自 lnk/文件提取并缓存；面板自绘 dock 应用区与文档区呈现真实条目；双击启动条目、单击选中。从本票起，桌面项由独立面板承载。

**Blocked by:** 02 底座尖兵

**Status:** ready-for-human

- [x] 原生桌面图标隐藏且桌面无「两套图标」；杀进程后面板自动还原原生图标
- [x] 面板条目集合与磁盘扫描结果一致（含公共桌面，电池对照）
- [x] 双击验收探针 lnk 启动成功（造唯一名、验证启动、清理）
- [x] 单击选中态可见
- [x] 扫描与图标提取纯逻辑 vitest 覆盖
- [x] 真机截图存证于工单评论

## Comments

**2026-09-27 实现落地 + 验收电池 40/40 连跑四轮全绿（含两轴 code-review 收编）**

**架构：外层守卫进程（icon-carry）**

`electron .`（默认入口）现在是**外层守卫**：抢单实例锁（二次拉起毫秒级拒绝）→ 释放锁 → 隐藏原生图标 → spawn `--panel` 面板子进程 → 常驻等待 → 面板退出（**含崩溃/强杀**）后还原图标、以面板退出码退出。还原链路的成立依据：taskkill /T 只清向下子树，杀面板进程杀不到父级守卫（电池 P5.3 实证）。`--icon-restore` 一次性模式确保图标可见（电池清场兜底 + 用户自救通道）；`--panel` 直启面板（`npm run dev:panel`，调试迭代用）。

- 隐藏机制 = explorer「查看→显示桌面图标」同一命令：SHELLDLL_DefView 的 `WM_COMMAND 0x7402`（explorer 同步写回注册表 HideIcons）；DefView 宿主随壁纸状态在 Progman/WorkerW 间漂移，两处都找（本机常态在 WorkerW 分支——WE 挂着壁纸窗）。
- 还原条件唯一：**本次由我隐藏**（用户自身偏好 HideIcons=1 则全程不动，避免顶掉用户设置）；还原前再核视图事实（SysListView32 可见性），用户运行期手动重新显示了图标就不再翻回（评审收编，防二次翻转造空桌面）。
- 守卫是唯一图标属主：面板进程自身不碰图标。已知残留：直接强杀守卫（如 taskkill /T 到守卫 pid）无还原路径——`--icon-restore` 是自救通道，电池清场已用。

**扫描与图标（纯逻辑 + 适配层）**

- `desktop/scan.ts`（纯）：`collectDesktopItems(roots, user, common)` 合并去重——同名用户桌面优先（shell 命名空间遮蔽语义）、hidden/system 滤除（desktop.ini 不入池）、`isAppEntry` 谓词归类（lnk/url→应用区，folder/file→文档区）、显示名剥 .lnk/.url（explorer 对这两类永远隐藏扩展）、iconKey=`path|mtime`（lnk 改指向自然换图标）、FNV 指纹。
- `desktop/icons.ts`（纯）：IconCache——并发同键去重、成功即缓存、失败按尝试上限（3）退避后缓存 null（毒键不每拍重提取）。
- `desktop/adapter.ts`：readdir+stat+GetFileAttributesW（koffi，kernel32 不是 user32）与 Electron `app.getFileIcon('large')`/`shell.openPath` 真源，一律延迟加载（vitest 假源不触原生件）。
- `services/desktop.ts`：1Hz 随桥接 tick 扫描（构造即首扫，dock 随窗口首绘就位）；**扫描失败沿用上一轮条目**（桌面闪空比慢半拍更伤，与会话「失败给空表」之别有意为之）；launch 校验 path 必在当前扫描池内（拒绝任意路径执行）。

**桥接契约扩展（只扩表不开新通道）**：`PanelSnapshot += desktop{fingerprint,items}`；`desktop/icon {key}→{dataUrl|null}`（渲染层本地缓存按指纹 diff，1Hz 快照不重取）；`desktop/launch {path}→{ok,error?}`。

**渲染层**：底部居中 dock（应用区）+ 左中条带文档区（DOCS 极小标签；条目自上而下满 8 行折右列——Python zones 先例 DOC_MAX_ROWS 预演）；单击选中（.sel 高亮）、双击经 `desktop/launch` 启动；图标 40px 实色（真机实拍为真实提取的彩色图标）；热区 = 条目包围盒 ∩ 容器可见盒（溢出条目不占热区，不留点击死区——评审收编）。

**逐条验收证据（电池输出 `app/accept/evidence/03-battery.log.txt`，40/40 PASS 连跑四轮：3 轮收编前 + 1 轮收编后）**

- **图标隐藏无两套桌面**：P1 面板启动后 SysListView32 不可见 + 实拍 `05-icons-hidden.png`（原生图标隐藏、dock/文档区自绘承载）。
- **杀进程自动还原**：taskkill /F 面板 pid → 守卫 `icons-restored`（reason=panel-exit）→ SysListView32 恢复可见 + 守卫自行退出 + 实拍 `05-icons-restored.png`；随后完整链重拉面板继续后续探针。
- **条目集合一致（含公共桌面）**：电池侧 PowerShell 重扫两桌面（UTF-8 输出锁码页）对照渲染层 desktop-rendered 条目集——15 项全等（用户 9 + 公共桌面独有 6，本机公共桌面有真实 lnk 实证）。
- **探针 lnk 双击启动**：临时 ps1 造唯一名 lnk（目标 hidden powershell 写标记文件）→ 1Hz 重扫描自动入池（同步出现存证）→ SendInput 双击 → `desktop/launch ok=true` → 10s 内标记文件落盘 → 清理后条目同步消失。
- **单击选中**：dock 首条目单击 → desktop-selected 存证 + `05-dock-selected.png` 高亮实拍。
- **vitest 110/110**：新增扫描 8（合并去重/遮蔽/滤除/归类/显示名/iconKey 可逆/指纹稳定性与翻转）、图标缓存 6（缓存/并发去重/失败退避/同步抛错/空图标/多键）、服务 5（状态机/失败沿用/预热/launch 校验/迟到键）、适配层 1（attrib 置隐藏属性实测）、契约扩展 2（快照含桌面/launch 双路）。

**真机踩坑记录（后续工单注意）**

1. **WM_COMMAND = 0x0111 不是 0x0112**（0x0112 是 WM_SYSCOMMAND）：投递「成功」（返回 true）但 explorer 静默忽略，表象是 toggle 无效——bisect 到同进程内联声明可用、编译模块无效，最后发现是常量笔误。教训：FFI「成功」只证明送达，不证明语义。
2. **Electron 主进程 spawn 的子进程随本进程退出被连杀**（Chromium job kill-on-close；detached+stdio:ignore 可逃逸但丢控制台）——需要「父死子活」的守护结构时让守卫常驻（本票设计），别让 spawn 者先退。
3. **本机 PowerShell**：中文文件名输出必须 `[Console]::OutputEncoding=UTF8`（默认 GBK 管道乱码）；COM CreateShortcut 带引号参数经内联 `-Command` 会挂起/静默失败——一律 ASCII 临时 ps1 走 `-File`（03 踩坑 1 的强化）。
4. 电池 `waitPanelWindow` 中途重启面板必须传 `sinceMs`：事件文件留着旧 boot，不传会盯死 pid 的窗口 20s（本轮实测踩中）。

**Code-review 收编（两轴并行）**：isAppEntry 谓词收口 zoneOf/displayOf 重复；collectDesktopItems 改 roots 对象签名（Data Clumps）；文档区改列流布局满 8 行折右列（一个不漏的承载上限从 ~20 提到 ~104，超限仍在池中待 06 编排）；热区包围盒与可见容器求交（不留点击死区）；还原前核视图事实（防用户手动重显后二次翻转）；psRun/psRunFile 共享 psSpawn；合并重复 import。**有意保留**：--icon-restore 与 dev:panel 为「绝不留空桌面」自救与调试通道（超出票面文字但电池依赖）；entry() 测试助手在两个 spec 重复（测试夹具不成库）；index.ts 四分支模式级联（模式分发集中一处，再拆反而散）。

**移交 06 的注意**：① 文档组（按扩展名聚合列）与分区几何/dock 尺寸/标签位进 config 属 06「归类/编排/Python 先例移植」（zones_plan.py 的 doc_group/_doc_placements）；② 05 的 1Hz 重扫描事实上已交付「新建自动入池、删除同步消失」（电池已断言），06 的「监听增删」只剩 fs.watch 化与归类入区；③ 06 拖拽摆位落地时 renderer 的 desktop-rendered 条目矩形（电池已用其定位探针）可复用为拖放源坐标。

**残留物**：无（电池清场：探针 lnk/标记文件/临时 ps1 删除、托盘 IsPromoted 还原、图标状态回电池前 visible=true、无残留 electron 进程、光标归位）。
