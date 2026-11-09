# Hyprland dwindle 与 scrolling：平铺、屏外几何和焦点适配

- 检索日期：2026-11-05。
- 范围：只读 Hyprland 官方 wiki、官方 GitHub 源码/提交；不检查本地产品代码，不运行 Hyprland，不采用二手博客作核心证据。
- 固定版本：Hyprland `main` 为 [`f389f008228d51fa48bdd69a4c9e2b91f24bb2da`](https://github.com/hyprwm/Hyprland/commit/f389f008228d51fa48bdd69a4c9e2b91f24bb2da)（2026-11-05 09:57:29 UTC）；wiki 为 [`06365065fb9ebd86bb2e5a3f0bdaa63d7f1b987a`](https://github.com/hyprwm/hyprland-wiki/commit/06365065fb9ebd86bb2e5a3f0bdaa63d7f1b987a)（2026-11-03）。当时最新 release 为 [`v0.57.1`](https://github.com/hyprwm/Hyprland/releases/tag/v0.57.1)。当前源码与旧 release 不可混为一谈。
- 证据标记：**[源码]** 为固定提交实现；**[文档]** 为官方 wiki；**[迁移推断]** 为面向 Windows/Electron 的设计推论，不是 Hyprland 承诺。

## 0. 结论速览

1. **dwindle 是增量 BSP 二叉树，不是自动平衡树。** 新窗把选中的叶子替换为“含旧叶与新叶”的父节点；关闭叶则让兄弟顶替父节点。它没有窗口数上限，也不保证多窗后的最小可用尺寸。[源码：`SDwindleNodeData` 与增删/递归实现](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/dwindle/DwindleAlgorithm.cpp)
2. **dwindle 的分裂目标默认跟焦点，方向默认跟容器宽高比，child 顺序还跟鼠标或配置。** 因而只给定“窗口打开序列”并不总能重建同一棵树；必须同时固定焦点、指针/落点与配置。[源码：`addTarget`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/dwindle/DwindleAlgorithm.cpp)、[文档：Quirks/Config](https://wiki.hypr.land/configuring/layouts/dwindle-layout/)
3. **当前 scrolling 是官方核心布局。** 它用有序列向量，每列还可纵向包含多个窗口；不是 dwindle 到容量后的自动溢出模式。[源码：核心布局注册](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/supplementary/WorkspaceAlgoMatcher.cpp)、[源码：数据模型](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.hpp)
4. **滚动带不是纯绘制变换。** 控制器的 offset 进入每个 target 的全局 `CBox`，再逐窗 `setPositionGlobal()`；屏外窗的几何目标确实移出显示器。输出端裁剪与焦点后适配是后续环节，不能拿“有个 camera 变量”误读成只移动画面。[源码：`recalculate`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)、[源码：`calculateStripBox`/`calculateTargetBox`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.cpp)
5. **默认焦点适配是 fit，不是永远居中。** `fitStrip` 只在目标列尚未完整可见时把 offset 推到最近合法边界；但 `follow_focus=1` 会按输入原因过滤，并非任意焦点事件都移动视图。[源码：`fitStrip`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.cpp)、[源码：`focusOnInput`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)
6. **自由平移与手势存在，但都是显式能力。** `layout("move …")` 可移动视图；`scroll_move` 是 v0.55.0 加入的可配置触摸板手势，带速度投影、松手吸附和焦点更新。普通滚轮不是布局自动接管的自由平移入口。[源码：`layoutMsg`/`moveTape`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)、[源码：`ScrollMoveGesture`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/managers/input/trackpad/gestures/ScrollMoveGesture.cpp)、[文档：Gestures](https://wiki.hypr.land/configuring/core/binds/gestures/)
7. 对本地“屏内平衡树最多 8 窗，第 9 窗入带、32px 露边、仅激活后 fit”的方案，**可借 fit 公式和有序列账，不能把 Hyprland 当成这些容量/露边/输入规则的现成实现**。[迁移推断；依据为下述各自源码]

## 1. dwindle：具体如何分裂和收缩

### 1.1 分裂目标不是固定的“最深叶”或“最后窗口”

`SDwindleNodeData` 同时表示内部节点与叶子：保存 `pParent`、两个 `children`、叶子的 `pTarget`、`box`、`splitTop` 和 `splitRatio`；所有节点另存于 `m_dwindleNodesData`，根通过“无父节点”找到。[源码：结构定义](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/dwindle/DwindleAlgorithm.hpp)

`addTarget` 的选择顺序可概括为：

- 当前工作区且 `use_active_for_splits=false`：先取鼠标下的窗口；落在保留区时再找最近节点。
- 默认 `use_active_for_splits=true`：优先同工作区、已映射、非浮动的活动窗；失败则找距鼠标最近节点。
- 移动窗口提供的 `m_overrideFocalPoint` 会改为距该落点最近节点；非活动工作区等其余路径可退回首节点。
- 之后用 `force_split`、鼠标位于哪一半、`smart_split` 的四三角形判定或一次性 `preselect` 决定新旧叶的次序和方向。[源码：`addTarget` 全路径](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/dwindle/DwindleAlgorithm.cpp)、[文档：相关默认值](https://github.com/hyprwm/hyprland-wiki/blob/06365065fb9ebd86bb2e5a3f0bdaa63d7f1b987a/content/configuring/layouts/dwindle-layout.md)

**算法含义**：不存在“每次找当前最小叶以保持平衡”的步骤。若焦点/落点持续落在同一区域，树可以继续向该区域加深；空间是否均衡取决于这些外部输入和既有树形。[源码；由无再平衡操作及上述选择路径直接得出]

### 1.2 递归维护的是几何，不是平衡性

新增时创建 `NEWPARENT`，复制旧叶的 box 和父链接，让旧叶与新叶成为其两个孩子，再接回祖父。首窗直接占满 work area。`calculateWorkspace()` 每次把根 box 重设为当前 work area，再由 `recalcSizePosRecursive()` 向下分派：

```text
splitRatio = r 时（默认 r=1）：
左右分裂：child0.w = parent.w / 2 * r；child1 得余量
上下分裂：child0.h = parent.h / 2 * r；child1 得余量
```

`r` 被钳在 `0.1–1.9`，所以比例限制不是像素级最小尺寸。默认未启用 `preserve_split`/`smart_split` 等时，递归还会按 `box.h * split_width_multiplier > box.w` 重新决定上下或左右分裂；官方文档明确称 split **不是永久的**。[源码：`recalcSizePosRecursive`、`calculateWorkspace`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/dwindle/DwindleAlgorithm.cpp)、[文档：Quirks](https://wiki.hypr.land/configuring/layouts/dwindle-layout/)

删除叶时，兄弟接管被删叶的父链接并顶替父节点，再擦除叶和旧父、全树重算；兄弟子树因此吸收空位。移动则 remove 后按新落点 add，不是原地改一个矩形。[源码：`removeTarget`、`movedTarget`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/dwindle/DwindleAlgorithm.cpp)

### 1.3 最小/可用尺寸：没有本地所需的容量保障

- 新增入口会把 `target->maxSize()` 与**分裂前**目标 box（无目标时为显示器尺寸）比较，任一轴太小就把新窗转浮动；这不是对分裂后每个叶子的最小像素验收。[源码：`addTarget` 的 max-size 分支](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/dwindle/DwindleAlgorithm.cpp)
- dwindle 算法本身不以 `minSize()` 决定“不再分裂”。最终 `WindowTarget::updatePos()` 另受 `misc:size_limits_tiled` 控制；启用后才 clamp 尺寸并调整位置，而该选项目前默认 `false`。[源码：`WindowTarget::updatePos`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/target/WindowTarget.cpp)、[文档：配置表](https://github.com/hyprwm/hyprland-wiki/blob/06365065fb9ebd86bb2e5a3f0bdaa63d7f1b987a/content/configuring/core/config-options.md)
- 因而“窗口变多后仍可操作”不能仅靠这套递归算法推出；本地最小窗格约束和容量阈值必须是另一层显式规则。[迁移推断]

## 2. scrolling：带、视口与实际窗口几何

### 2.1 数据模型：有序列，不是屏内/屏外两套成员

`SScrollingData` 持有 `columns` 与 `CScrollTapeController`。每个 `SColumnData` 持有有序 `targetDatas`、列内最后焦点；控制器的每个 `SStripData` 另存主轴尺寸 `size`、每个目标的次轴比例 `targetSizes`，并回指对应列。也就是说默认横向模式是“列沿 x 排列，列内窗口沿 y 分配”；`direction` 也可把主轴切成纵向。[源码：`ScrollingAlgorithm.hpp`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.hpp)、[源码：`ScrollTapeController.hpp`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.hpp)

列内加入窗口时，旧高度比例乘 `n/(n+1)`，新窗为 `1/(n+1)`；删除后剩余比例重新归一。空列同时从 `columns` 和 controller 删除对应 strip。[源码：`SColumnData::add/remove`、`SScrollingData::remove`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)

### 2.2 新增与溢出：没有第 N 窗容量闸

普通新增在当前焦点列之后创建新列，无焦点列可参照时追加到末尾，随后**在该入口内无条件 `fitCol(newCol)`** 并重算。拖放是另一分支：落点在目标中间区域可并入该列，靠近前后 30% 边缘则新建列。[源码：`newTarget`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)

总带长为 `Σ(usablePrimary * strip.size)`，列起点是此前各列宽度之和。公开配置 `column_width` 默认 `0.5`、范围 `0.1–1.0`；单列时 `fullscreen_on_one_column=true` 让其占满可用区。因此默认两列可恰好一屏，第三列起形成溢出，但源码没有“第 3 窗”这样的通用规则：列宽可变，一列还可含多窗。[源码：`calculateMaxExtent`/`calculateStripStart`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.cpp)、[文档：配置默认值](https://wiki.hypr.land/configuring/layouts/scrolling-layout/)

### 2.3 三种机制必须分开

| 机制 | 当前源码事实 |
| --- | --- |
| **窗口几何移出屏幕** | `calculateStripBox()` 以列起点减去 camera offset；`calculateTargetBox()` 再安排列内次轴几何。`SScrollingData::recalculate()` 对每个 target 调用 `setPositionGlobal()`，最终 `CWindowTarget` 写 `m_window->setBox()` 并向 client configure。不是只让某个 DOM/绘制容器移动。[几何计算](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.cpp)、[逐窗写入](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)、[client 写入](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/target/WindowTarget.cpp) |
| **视口/裁剪** | controller 的 `m_offset` 是当前工作区滚动带的视口账，不是工作区切换动画本身。总内容小于视口时会把内容居中；fit 模式下已扩展内容的负 offset 会归零。本文没有把输出渲染器中的具体裁剪/屏外 surface 生命周期一并当作已验证事实。[源码：`calculateCameraOffset`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.cpp) |
| **焦点后适配** | center 直接把目标列中心放到视口中心；fit 用区间钳制实现最小滑动。焦点事件是否调用它另受 `follow_focus`、输入方式和可见比例控制。[源码：`centerStrip`/`fitStrip`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.cpp) |

设视口主轴长 `V`，目标列无偏移起点 `s`、宽 `w`，则 fit 的合法 offset 区间为 `[s - V + w, s]`，实现就是 `newOffset = clamp(oldOffset, lo, hi)`；目标比视口还宽时退化为 center。这已经完整可见时不移动，也不会为了固定“32px 露边”额外滑动。[源码：`fitStrip`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollTapeController.cpp)

### 2.4 焦点切换：soft / click / hard 不等价

当前默认是 `focus_fit_method=1`（fit）、`follow_focus=1`、`follow_min_visible=0.4`。实现要点：

- `FOCUS_REASON_CLICK_DOWN` 不移动视图；mouse release 在 `follow_focus!=0` 时走 click/soft 路径。
- soft 输入受 `follow_min_visible` 过滤；非 hard 输入在目标列已完整可见时不再适配；click 还要求光标实际落在目标上。
- hard 输入绕过上述 soft 可见比例门槛，随后按 fit/center 重算。部分明确 dispatcher 焦点原因被直接归为 hard。
- `follow_focus=0` 的源码仍给 hard focus reason 留了路径，不能把 wiki 的简写扩大成“任何 hard 命令也绝不可能移动”。
- 常规 `recalculate(reason)` 遇到 hard recalculate reason 且当前焦点列未完整可见，也会走 hard 适配。[源码：构造器中的焦点/鼠标监听与 `focusOnInput`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)、[文档：配置语义](https://wiki.hypr.land/configuring/layouts/scrolling-layout/)

**新增适配与焦点适配是两条路径**：`newTarget` 自行 fit 新列，不能仅用 `follow_focus=0` 推断“后台新窗绝不动视图”；该函数本身没有本地产品那种前台/后台分支。[源码：`newTarget` 与上述监听器]

### 2.5 关闭和移动

- 关闭列内窗口：删除 target、重归一剩余次轴比例；空列删除。若删的是末尾单列，先按列宽反移 offset；列消失后再把 offset 收拢到剩余范围。[源码：`removeTarget`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)
- 关闭后的布局候选窗是距旧窗中心最近的现存 target；最终焦点还受通用 `input:focus_on_close` 策略影响，不应简化成“永远右列补焦点”。[源码：`getNextCandidate`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)、[文档：`focus_on_close`](https://github.com/hyprwm/hyprland-wiki/blob/06365065fb9ebd86bb2e5a3f0bdaa63d7f1b987a/content/configuring/core/config-options.md)
- 左右移动可并入邻列（按鼠标高度决定列内位置）或创建新列；上下移动交换列内顺序；`swapcol` 同时交换列向量和 controller strip。相关路径随后 fit/center 涉及列并重算。[源码：`moveTargetTo`、`layoutMsg`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)

### 2.6 平移、触摸板与滚轮

- **命令式平移**：`layout("move +col"/"-col")` 适配相邻列、更新焦点并可 warp 光标；`layout("move +200"/"-200")` 直接调 offset，再把视口中心列作为焦点候选。`moveTape(delta)` 本身只 `adjustOffset(-delta)` 后重算，没有在此函数做端点 clamp。[源码：`layoutMsg`、`moveTape`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)
- **触摸板 1:1 手势**：显式配置 `hl.gesture({ fingers=…, direction=…, action="scroll_move" })`。更新时把 swipe delta 除以视口主轴长度后调用 `moveTapeNormalized`；结束时用平滑速度做有界投影，默认 `move_snap_to_grid=true`，选最近的 fit/center 落点并更新列焦点，默认还可把光标移到新焦点。[文档：手势语法](https://wiki.hypr.land/configuring/core/binds/gestures/)、[源码：`ScrollMoveGesture.cpp`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/managers/input/trackpad/gestures/ScrollMoveGesture.cpp)、[源码：吸附及同级 tie-break](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)
- **滚轮**：通用 keybind manager 只把 `WL_POINTER_AXIS_SOURCE_WHEEL` 的垂直/水平事件映射成 `mouse_up/down`、`mouse_left/right`，用户可再把它们绑定到 layout 命令；还受 `binds:scroll_event_delay` 节流。scrolling 的自由手势实现位于 trackpad swipe 类，不是 `onMouseWheel` 自动平移。[源码：`CKeybindManager::onAxisEvent`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/keybinds/Manager.cpp)、[源码：`ScrollMoveGesture.cpp`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/managers/input/trackpad/gestures/ScrollMoveGesture.cpp)
- **不要把示例当默认手势**：官方当前示例配置把三指横滑设为 `workspace`，并另演示 `SUPER + mouse_up/down` 切换工作区，没有默认启用 `scroll_move`。下游发行版可能覆盖这些绑定。[源码：官方 `example/hyprland.lua`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/example/hyprland.lua)

## 3. 核心归属、配置关键词与版本

核心 matcher 直接注册 `"scrolling"` 工厂，当前选择方式是 `general.layout = "scrolling"`；当前 wiki 使用 Lua 配置，例如 `hl.config({ general = { layout = "scrolling" } })`。[源码：`WorkspaceAlgoMatcher`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/layout/supplementary/WorkspaceAlgoMatcher.cpp)、[文档：通用 `layout` 选项](https://github.com/hyprwm/hyprland-wiki/blob/06365065fb9ebd86bb2e5a3f0bdaa63d7f1b987a/content/configuring/core/config-options.md)

| 关键词 | 当前默认/用途 |
| --- | --- |
| `scrolling:column_width` | `0.5`；新列默认主轴比例 |
| `scrolling:fullscreen_on_one_column` | `true`；单列占满 |
| `scrolling:focus_fit_method` | `1`；`0=center`、`1=fit` |
| `scrolling:follow_focus` | `1`；焦点是否/如何带动视图 |
| `scrolling:follow_min_visible` | `0.4`；soft focus 的可见比例门槛 |
| `scrolling:direction` | `right`；也支持 `left/down/up`，并有 workspace rule |
| `gestures:scrolling:move_snap_to_grid` / `move_snap_cursor` | 均默认 `true`；手势松手吸附/光标跟随 |

[文档：完整 scrolling 配置表与 layout messages](https://wiki.hypr.land/configuring/layouts/scrolling-layout/)、[源码：当前配置值注册](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/config/values/ConfigValues.cpp)

版本边界：

- PR [#12890](https://github.com/hyprwm/Hyprland/pull/12890) 明写“Migrate scroll into core”，并把旧 `plugin:hyprscrolling:` 变量迁到 `scrolling:`；合并提交为 [`723870337f299d4c80aa0048144f3a1ca1c885bd`](https://github.com/hyprwm/Hyprland/commit/723870337f299d4c80aa0048144f3a1ca1c885bd)（2026-02-21）。该实现包含在 [`v0.54.0`](https://github.com/hyprwm/Hyprland/blob/v0.54.0/src/layout/algorithm/tiled/scrolling/ScrollingAlgorithm.cpp)（[release](https://github.com/hyprwm/Hyprland/releases/tag/v0.54.0)，2026-02-27）。
- `scroll_move` 由 PR [#14063](https://github.com/hyprwm/Hyprland/pull/14063) / 提交 [`4c8c45d754c9956d611bbe373b3e33a7d5957d68`](https://github.com/hyprwm/Hyprland/commit/4c8c45d754c9956d611bbe373b3e33a7d5957d68) 加入，[`v0.55.0` release notes](https://github.com/hyprwm/Hyprland/releases/tag/v0.55.0) 明列 `gestures: add scroll_move`。不能据当前 wiki 反推 v0.54 已有此手势或全部当前选项。
- 当前官方插件仓库的固定[插件清单](https://github.com/hyprwm/hyprland-plugins/blob/d2427d4d15b36df40468f5a58bbd67cdba19835d/README.md)也不再列 hyprscrolling。Omarchy 的快捷键、默认手势或下游配置不是核心行为证据；尤其不能把旧 `plugin:hyprscrolling:*` 或其他第三方 `hyprscroller` 配置照搬到当前核心。

## 4. 对 Windows/Electron/`SetWindowPos` 托管模型的可迁移性

| 点 | 可借鉴 | 不能直接照搬的 compositor 前提 |
| --- | --- | --- |
| **容量阈值** | 把有序成员、几何规划和实际写窗分账；溢出队列保持明确顺序。 | Hyprland 没有 8 窗上限，dwindle 与 scrolling 也不是自动拼接的混合布局。“屏内 8 窗、第 9 窗入带”必须由本地规划器显式实现。 |
| **默认焦点与 fit** | 直接复用 `clamp(oldOffset, s-V+w, s)` 的最小适配思想；已完整可见则不动。 | Hyprland 有 compositor 内部的 focus reason、click down/up、hard recalculate 分类；外部面板不能把每个 Win32 激活事件都视作等价原因。本地“普通激活 fit、后台新窗不动”应明确写成产品规则，而非套用 `follow_focus` 名称。 |
| **露边** | fit 后可根据相邻列几何得到自然露边。 | Hyprland fit 不承诺固定 32px；本地 32px 需单独验收。 |
| **动画与真实几何** | 规划值、视觉值、client 目标分层；必要时提供 instant/warp 路径。 | Hyprland 的 `GEOMETRIC_GOAL` 与 `GEOMETRIC_CURRENT` 分离，`setBox()` 写动画变量目标，`finishAnimation()` 才 warp；Windows 验收应回读真实 HWND 矩形，而不能以规划成功或 DOM 画面代替。[源码：`GeometricMovableAnimated.cpp`](https://github.com/hyprwm/Hyprland/blob/f389f008228d51fa48bdd69a4c9e2b91f24bb2da/src/desktop/view/types/GeometricMovableAnimated.cpp) |
| **窗口所有权/屏外** | 外部窗口可用真实屏外几何表达带的位置，再按 fit 写回。 | Hyprland 同时掌控 client configure、输入、渲染和输出裁剪；Electron 面板不是其他进程窗口的 compositor。不能假设仅改一个视图偏移就会移动 HWND，也不能假设所有应用对离屏、缩放和捕获的表现相同。 |
| **确定性** | scrolling 的列序、列内最后焦点、删除收拢、snap 的显式 tie-break 都值得借鉴。 | dwindle 的分裂目标依赖焦点/鼠标和配置；若本地契约是“同一窗口事件序列必得同树”，就不能悄悄引入未入账的指针状态。 |
| **最小尺寸** | 分裂前按应用/窗格最小尺寸做容量预判；不可分裂时进入明确的屏外或异常路径。 | dwindle 递归本身不提供这种保障，`size_limits_tiled` 默认也关闭；简单把最终窗口 clamp 回去不等于布局仍合法。 |
| **输入手势** | 首版继续只提供点击/激活后的 fit，范围小而可测；未来若加手势，可复用 begin/update/end、速度投影、松手 snap 的状态机。 | `scroll_move` 是 compositor 全局匹配并消费的显式手势，不是 Electron 自动获得的能力；滚轮/触摸板消息与应用自身滚动、系统手势存在竞争。 |

以上迁移项均为 **[迁移推断]**，不是对本地实现已正确或已实机的声明。

## 5. 未能从一手资料确认 / 本文不声称

- **未做 Hyprland 实机运行**：屏外窗口的逐帧画面、输入命中、screencopy/toplevel capture、不同 client 对屏外 configure 的实际反应均未验证；本文只证明源码中的几何与事件路径。
- **未逐版本回溯全部配置项**：确认的是核心 scrolling 已进入 v0.54.0、`scroll_move` 已进入 v0.55.0，以及固定 main/wiki 的当前值；其他选项各自的最早 release 未逐项考据。
- **未审计 Omarchy 或第三方插件当前源码**：因此不对其默认快捷键、手势、包版本或兼容性下结论，只明确它们不是核心行为的替代证据。
- **未完整追踪多显示器、layout-handled fullscreen 的所有分支**：本文不声称覆盖这些场景；相关 handler 存在且有独立状态，不应从单屏普通平铺路径外推。
- **未确认每个输入设备的 swipe/axis 上报方式**：源码证明的是 swipe 手势和 wheel 绑定链；具体触摸板/TrackPoint 的驱动事件类型仍需设备级验证。
