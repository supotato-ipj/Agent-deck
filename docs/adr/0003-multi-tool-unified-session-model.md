# 多工具会话以统一四态模型接入，kimi work 接受无标题降级

壁纸要同时展示五个 AI 工具（Qoder、kimi work、kimi code、zcode、hermes）的会话状态，但五家本地存储格式互异：JSONL 事件流、JSON 状态 map、两套不同 schema 的 SQLite，且"进行中/已结束"信号强弱悬殊——hermes 有显式 ended_at 与活跃租约文件，kimi code 只有文件 mtime，kimi work 的会话正文锁在 LevelDB 里、明文只有 `{会话uuid: 状态}` map。我们决定**不为任何工具改造上游格式或引入中间存储，而是每工具一个严格只读的扫描器，全部归一化进 Qoder 既有的四态模型（RUN/CONFIRM/DONE/IDLE）与统一时间窗（90 秒 RUNNING / 10 分钟活跃池）**；kimi work 接受"工具名 + 状态"的无标题降级展示。

## Considered Options

- **解析 kimi work 的 LevelDB 拿标题** — 否决：需要逆向 Electron 存储格式，成本高且随对方版本升级随时失效；换来的只是一行标题，状态展示本身不依赖它。留作演进路径：若日后确有需要再单独破解。
- **每个工具用自己的状态词汇，前端分别渲染** — 否决：五套视觉语言违背"一屏总览"的作战面板初衷，前端分叉也让每次新增工具都要动渲染层。
- **非 Qoder 工具简化为两态（RUNNING/IDLE）** — 否决：与统一四态相比节省不了什么，反而让同一列表里两种粒度并存，DONE 与 IDLE 的区分对"要不要去看一眼"这个判断有实际价值。
- **信号弱的工具（kimi code）等其官方提供状态接口** — 否决：mtime 启发式与 Qoder 现行判定同源，90 秒窗已在生产验证过足够稳。

## Consequences

- CONFIRM 态（等待用户确认工具调用）实际上只有 Qoder 能产生——其他工具没有对等信号；列表中非 Qoder 行永远不会显示 CONFIRM，这是接受的失真。
- 判活信号强弱不一导致精度分层：hermes 最准（租约 + ended_at 交叉验证），zcode 次之（显式时间戳 + archived），kimi code 最粗（纯 mtime）。某工具若因写入节奏稀疏频繁"闪现即消失"，对策是单独放宽其窗口，而不是推翻统一模型。
- 所有扫描器对源存储严格只读（SQLite 用只读 URI），任一工具源不可用时静默跳过、仅记服务端日志——壁纸可用性优先于故障可见性。
- 会话唯一键必须带工具前缀（tool + id），否则不同工具的 id 撞车会互相覆盖前端 DOM。
