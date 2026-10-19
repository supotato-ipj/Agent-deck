# 08: 设置浮层与透明度

**What to build:** 面板内设置浮层：模块底色透明度全局滑杆——经桥接契约写 config、各信息卡底色即时反映、文字始终保持实色清晰、重启保持；恢复出厂布局从设置浮层触达（动作本体属 06，此处只接入入口）。设置浮层自身为交互热区、ESC 或失焦关闭。

**Blocked by:** 06 编排与推荐

**Status:** ready-for-human

- [x] 滑杆调节即时反映在各信息卡底色，文字实色不变
- [x] 透明度经 config 持久化，重启面板后保持
- [x] 恢复出厂布局可从设置浮层触达
- [x] 浮层热区点击开启、ESC/失焦关闭
- [x] 真机截图存证于工单评论

## Comments

**2026-09-28 实现落地 + 验收电池 63/63 全绿（P8S 设置段 8 探针）+ vitest 284/284 + typecheck 干净**

**架构：数据面收口内核 SettingsService，渲染层只画 CSS 变量**

- `services/settings.ts`（新 cordis 插件）：`settings/set-card-opacity` 到这里——clamp 0..1（非有限数字按契约违规拒绝）、**tmp+rename 原子整份回写 config.json**（writeStoreText 先例；config 收口几何/端口/透明度，坏写不碰原文件）、`settings/changed` 即时回推（不等 1Hz 快照）；先写盘后提交内存态，写失败三者（内存/config 引用/磁盘）保持一致。
- config 新 `appearance.cardOpacity` 段（0..1，默认 0.55 = 现 rgba(0,0,0,0.55) 生产值固化；越界/非数回退默认并告警，老 config.json 缺段静默合并默认）；`saveConfig` 导出为持久化通道。
- 契约只扩不增通道：`PanelSnapshot.settings` 随快照下发（boot 初值来源）+ `settings/set-card-opacity` 方法 + `settings/changed` 事件；panel-ipc 转发表加 settings/changed。
- 渲染层：`:root { --card-alpha }` CSS 变量只喂 `.card` 与 `#dock-zone` 的**底色** alpha——全部文字颜色是实色字面量，「底色随时可调、文字始终实色清晰」是结构性保证，无一处动态改文字。滑杆 input 即时改变量（拖拽中滑杆持焦点，内核回推不抢滑杆位）+ invoke 落内核；boot/滑杆/回推三路共用幂等的 `applyCardAlpha`。
- 设置浮层 `#settings-card`（class=card：底色随滑杆、矩形自动进热区）+ 右下角 `⚙ SETTINGS` 入口（位置沿用 06 恢复按钮经验值 bottom:64）；开层存证带滑杆矩形与当前值（电池拖拽定位，desktop-rendered rects 同法）。关闭语义：ESC（keydown 冒泡到浮层）/ 失焦（focusout 且焦点未落回浮层内——面板穿透之下「点外部」到不了渲染层，与 07 失焦退待机同一语义边界）/ 入口再点 toggle；入口 mousedown preventDefault 防 focusout 误关。**恢复出厂布局按钮迁入浮层**（06 的右下角独立按钮退役），动作本体不变（`desktop/reset-layout`），存证 notify 名沿用 06 电池契约。
- 浮层内复位按钮自带 `settings-reset` 热区矩形（随浮层显隐）；关层零尺寸矩形一律不进热区（不留点击死区）。

**逐条验收证据（电池 P8S + 06-d，输出原文 `app/accept/evidence/03-battery.log.txt`，63/63）**

- 入口点击开启 + 浮层矩形进热区 300x125（截图 `08-settings-open.png`：右下角 SETTINGS 浮层，滑杆 055%）。
- 初值同源：开层滑杆值 55% = config.appearance.cardOpacity 0.55。
- 滑杆拖至 1%：applied 存证同值、config 同步落盘 0.01（截图 `08-opacity-low.png`：底色全透、壁纸直透，文字全实色清晰）。
- 拖回 99%：config 0.99（截图 `08-opacity-high.png`）；ESC 收层（reason=esc）、点时钟卡失焦收层（reason=blur）均过。
- 重启保持：0.91 落盘 → 重启面板 → boot applied 91% 回灌渲染层（截图 `08-opacity-persisted.png`，滑杆与底色同值）。
- 恢复出厂经浮层触达：设置入口 → 浮层内 RESET LAYOUT → 清 1 处摆位、手钉保留在前段（06-d 探针改走浮层后复验通过）。

**真机踩坑记录（后续工单注意）**

1. **电池事件断言必须取终值而非首匹配**：拖拽产生连续 input/set 事件流，`waitEvent`（首匹配）拿到的是拖拽中途值（如 25%），而 config 读数是落定终值（1%）——恒假阴。改 `lastEvent`（since 后取最后一条）+ 拖拽后 settle 500ms，断言「滑杆终值 = 内核响应 = applied = config 落盘」四链一致。
2. **读 config 断言要带 loadConfig 合并语义**：生产 config.json 早于 appearance 段时盘上无此键，内核按默认 0.55 合并——电池读盘按 `?? 0.55` 兜底，不能拿 null 对比。
3. **浮层内的按钮要独立热区矩形**：整层一条热区电池无法按 id 定位按钮落点（首轮 06 复位探针实证 settings-reset 未进热区）；复位按钮按旧独立按钮同法自报矩形。

**Code-review 收编（双轴并行评审）**：① spec 轴——saveConfig 改 tmp+rename 原子写（config 现收口几何/端口/透明度，坏写会整体回退默认，writeStoreText 先例）+ setCardOpacity 先写盘后提交内存态（原实现写失败会把新值泄漏进 config 引用），均补测试（落盘失败拒绝且三态不污染）；② standards 轴——词汇归族：「模块底色」→「卡片底色/信息卡底色」（CONTEXT.md 避免「信息模块」，spec US2 用「信息卡」）；电池 06/P8S/P6 三处重复的 latestZoneOf/occludedClick/ptOfZone/config 备份还原收敛为电池级共用件；渲染层 input 处理器改走 applyCardAlpha（消重复，注释与实现一致）；**有意保留**：`--card-alpha` 首帧用 CSS 默认 0.55、首拍快照即 reconcile（渲染层无配置通道，闪帧 <1s 属快照架构固有）；`settings/set-card-opacity` 单方法而非通用 config 写（spec「配置读写」的工单 08 子集，通用化等有第二个设置项再收）；searchPumpMs→searchIntervalMs 契约测试选项名收编（07 评审改名漏改测试，泵定时器在契约测试中被默认安装——与本票无关的既有 bug，已修并在此声明）。

**残留物**：无（电池清场：config.json 备份还原无 appearance 残留、layout.json 清场、探针目录已删、图标状态还原、无残留 electron、光标归位）。
