# 03: 结果操作集——Enter 打开、Ctrl+Enter 定位、键盘导航

**What to build:** 活动态结果列表上的完整操作集：↑/↓ 移动选中项（列表随之滚动保证可见）；Enter 打开选中的文件；Ctrl+Enter 在资源管理器中打开所在文件夹并定位该文件；鼠标单击某条结果等同 Enter；继续打字时保持活动态并刷新结果。打开与定位动作由数据服务以无窗口方式执行子进程（不闪现控制台）。「按键 → 动作」的映射进入 02 建立的纯逻辑并离线测试。

**Blocked by:** 02（引擎与结果渲染——需要有真实结果可操作）

**Status:** ready-for-human

- [x] ↑/↓ 在结果间移动选中，首尾行为明确，选中项始终可见
- [x] Enter 打开选中的文件（验收用临时探针文件，验后清理）
- [x] Ctrl+Enter 在资源管理器中打开所在文件夹并定位该文件
- [x] 单击结果等同 Enter
- [x] 打字期间操作集持续可用，结果刷新后选中项处理明确（如重置到首项）
- [x] 打开/定位动作全程不闪现控制台窗口
- [x] 按键→动作映射的离线测试全绿

## Comments

**2026-09-25 ticket 03 实现完成（ready-for-human）**

实现：`listary_engine.py` 增 `decide_action`（up/down/return(+ctrl) → prev/next/
open/reveal，面板唯一的键派发出口）与 `SelectionModel`（首尾 clamp 不环绕、结果刷新
重置回首项、空列表无选中）；`search_panel.py` 增选中渲染（反白样式同壁纸 st-CONFIRM
/OFFLINE 语言）、↑/↓/Enter/Ctrl+Enter/行单击绑定、动作执行（`os.startfile` 打开、
`explorer /select,` 定位并按仓库先例带 `CREATE_NO_WINDOW`）、动作完成即走 ESC 同款
待机转移。选中项可见性由结构保证：列表恒 ≤8 行、窗口随行数展开，无滚动需求。

评审回改：键映射最初在面板内联、纯逻辑成了死代码（双真相源）——已改为绑定统一走
`engine.decide_action` 并真机复验 Enter 链路；`subprocess` 补 `CREATE_NO_WINDOW`；
消 `(expr,"break")[1]` 惯用法与 0x0004 魔法数；测试色值改引模块常量；顺手修复既有
测试里的 `\f`/`\d` 字面量残留（转义层级事故，见 02 评论的 PS/heredoc 教训）。

验收证据（`evidence/` + trace）：
- ↑↓ 高亮（15/16）：反白条带自 row0 移至 row1，像素测量下移 19px（ROW_H=22 量级）；
  首尾 clamp、刷新重置、空列表为离线单测覆盖。
- Ctrl+Enter 定位（17-reveal-explorer + trace `reveal`）：探针目录内文件在资源
  管理器中打开其所在文件夹（窗口标题 zzdeck03dir - File Explorer）。
- Enter 打开（18-open-folder + trace `open`）：目录结果打开 explorer，探针目录与
  文件验后全部清理，无残留窗口（窗口检测经 CabinetWClass 枚举 + WM_CLOSE）。
- 单击行等同 Enter（19-rowclick-open + trace `open`）：真实鼠标点击结果行直接打开。
- 全程无控制台闪现；动作后面板收起回待机（trace esc/blur 序列）。

ready-for-human 项：与 01/02 共同的中文输入法人工目验（操作集其余部分全自动验证）。
