'use strict';
/**
 * 面板控制模块（工单112，spec #109 seam②）：从主电池主流程闭包抽出的面板进程控制件。
 * 进程杀灭 / 存活探询 / 窗口枚举全经注入接口——决策逻辑零 koffi 零 Report 依赖，可脱离真机单测。
 *
 * 强退序列（#107 双面板级联的斩断点）：优雅终止 → 整树强杀 → 有界等待并**验证进程确实消失**
 * → 仍存活则返回「需重启清障」决策，由调用方入环境降责账并中止后续段。现状（stopPanel）缺的
 * 正是验证这一环：taskkill /F 后不确认消失就放行重启，停摆面板存活 → 新面板被单实例守卫拒收
 * → 缓存互锁/托盘竞争/成片失真，污染后续每一轮。验证消失后放行重启，验证失败就不让污染继续。
 *
 * 决策与后果分离（模块边界的中止信号语义）：本模块只返回决策（outcome/gone/pidsLeft），
 * 不记账、不重启、不抛——「需重启清障」的入账与中止是调用方（battery.js）的职责：
 *   - gone=false（outcome='restart-clear-required'）即中止信号，调用方必须
 *     ① rep.exclude(..., 'panel-forcekill') 入环境降责账；② 中止后续段（借主 try/catch 汇流）。
 *   - gone=true 可安全放行重启，调用方无需任何补账。
 */

/** 优雅退宽限（与既有 stopPanel 的 800ms 等价——行为不变量的基线值） */
const DEFAULT_GRACE_MS = 800;
/** 强杀后验证消失的有界等待上限（内核级钉子户不无限陪跑） */
const DEFAULT_VERIFY_MS = 5000;
/** 验证窗内存活轮询间隔 */
const DEFAULT_POLL_MS = 200;

/** 存活探询缺省实现：process.kill(pid,0) 存在性探测（Windows 下零副作用）。
 *  已知边界（评审 P3）：验证窗内 pid 被系统复用给无关进程时会误判存活（概率极低），
 *  后果是该轮报「需重启清障」入环境降责——宁可误停一轮，不放双面板污染后续。 */
function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** pid 表归一：数值化、去重、丢弃 0/负数/非数值（child.pid 缺位等形态不给强杀添乱） */
function normalizePids(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : (list ? [list] : [])) {
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

function posInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * @param {object} [deps] 注入接口（全部可缺省走真机实现）：
 *   isAlive(pid) → boolean            存活探询（缺省 process.kill(pid,0)）
 *   gracefulKill(child|null) → void   优雅终止（缺省 child.kill()，尽力不抛）
 *   forceKillTree(pid) → void         整树强杀（缺省 taskkill /PID <pid> /T /F）
 *   sleep(ms) → Promise               时钟推进（缺省 setTimeout；单测注入假时钟）
 *   now() → number                    墙钟（缺省 Date.now；单测与 sleep 同源整定）
 */
function createPanelControl(deps = {}) {
  const isAlive = deps.isAlive || defaultIsAlive;
  const gracefulKill = deps.gracefulKill || ((child) => { try { if (child) child.kill(); } catch { /* 尽力 */ } });
  const forceKillTree = deps.forceKillTree || ((pid) => {
    require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  });
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());

  /**
   * 强退序列：优雅终止 → 整树强杀 → 有界等待并验证消失。
   * @param {{pids: number[], child?: object|null, graceMs?: number, verifyMs?: number, pollMs?: number}} req
   *   pids：待终结进程表（面板主进程 + Electron 外壳等，去重由模块负责）；child：优雅终止对象。
   * @returns {Promise<{gone: boolean, graceful: boolean, forced: boolean, pidsLeft: number[], outcome: string}>}
   *   outcome='graceful-gone'          优雅退成功（未动强杀）
   *   outcome='forced-gone'            需强退且强杀后验证消失（可安全放行重启）
   *   outcome='restart-clear-required' 强退后仍存活——需重启清障，调用方中止后续段并入环境降责账
   */
  async function stop(req = {}) {
    const pids = normalizePids(req.pids);
    const child = req.child || null;
    const graceMs = posInt(req.graceMs, DEFAULT_GRACE_MS);
    const verifyMs = posInt(req.verifyMs, DEFAULT_VERIFY_MS);
    const pollMs = posInt(req.pollMs, DEFAULT_POLL_MS);
    // 无 pid 可验证：只做一次尽力优雅终止（child.pid 缺位形态），无从核验即视作已消失
    if (!pids.length) {
      gracefulKill(child);
      return { gone: true, graceful: true, forced: false, pidsLeft: [], outcome: 'graceful-gone' };
    }
    // 1) 优雅终止 → 宽限等待
    gracefulKill(child);
    await sleep(graceMs);
    if (!pids.some((p) => isAlive(p))) {
      return { gone: true, graceful: true, forced: false, pidsLeft: [], outcome: 'graceful-gone' };
    }
    // 2) 整树强杀（Electron 有 GPU/工具子进程：对每个已知 pid /T /F 各一次）
    for (const pid of pids) forceKillTree(pid);
    // 3) 有界等待并验证确实消失——现状缺失的一环，双面板级联的斩断点
    const deadline = now() + verifyMs;
    for (;;) {
      const left = pids.filter((p) => isAlive(p));
      if (!left.length) return { gone: true, graceful: false, forced: true, pidsLeft: [], outcome: 'forced-gone' };
      if (now() >= deadline) {
        return { gone: false, graceful: false, forced: true, pidsLeft: left, outcome: 'restart-clear-required' };
      }
      await sleep(pollMs);
    }
  }

  return { stop, isAlive };
}

/**
 * 遗留面板窗核验（收尾清场取证；#113 preflight 的双面板探测复用同一判别式）。
 * 面板本体 = Chrome_WidgetWin_1 + 标题 AGENT DECK（与 waitPanelWindow 同一甄别式；
 * 提示条刻意异名 AGENT DECK ACCEPT HINT、面板副窗标题 DECK-TASKBAR，均不入列）。
 * 控制器自身的同款窗经 selfPid 排除；selfPid 缺省不排除任何 pid。
 * 窗枚举本身经注入：调用方用 win32.topLevelWindows + 分类回调产出 rows，模块保持纯函数。
 * @param {{cls: string, title: string, pid: number, selfPid?: number}[]} classified
 * @returns {object[]} 仍在场的面板本体窗（pid 列表供取证）
 */
function findPanelWindows(classified) {
  const rows = Array.isArray(classified) ? classified : [];
  return rows.filter((c) => c && c.cls === 'Chrome_WidgetWin_1' && c.title === 'AGENT DECK'
    && Number.isFinite(Number(c.pid)) && Number(c.pid) !== Number(c.selfPid));
}

/**
 * preflight 环境体检分类（工单113）：四类已知污染源 → 警示条目。纯函数——探测
 * （窗枚举/可见性/cloaked/rect）由调用方产出后注入，本函数只做分类，可脱离真机单测。
 * 警示入账不拒跑：条目由调用方以 note 入报告账目，不影响 verdict（三态只看
 * fails/excluded——污染在场只作环境定责的证据链，不制造 FAIL-ENV）。
 *
 * 四类污染源（spec #109）：
 *   ① 计算机使用代理全屏光标覆盖层 → fullscreenForeign（壳层白名单外的全屏可见未 cloaked 窗）
 *   ② dwm 持有的全屏幽灵窗         → ghostWindows（Ghost 类窗，#107 取证所见形态）
 *   ③ 遗留提权面板进程             → panelWindows 恰一扇（电池未拉起任何面板时在场的遗孤）
 *   ④ 双面板并存                   → panelWindows ≥2 扇
 * @param {{panelWindows?: {pid:number, exeQueryable?:boolean}[], ghostWindows?: {cls:string,pid:number}[], fullscreenForeign?: {cls:string,pid:number,title?:string}[], rows?: object[]}} probes
 *   （rows 为第五类 classifyUserWindowActivity 消费的可见窗快照行，本函数不读）
 * @returns {{kind: 'double-panel'|'leftover-panel'|'dwm-ghost'|'fullscreen-overlay', detail: string}[]}
 */

// 壳层白名单（工单34 自 battery.js 迁入单点维护）：桌面宿主/任务栏/DefView 属 shell
// 常驻件，既不算全屏覆盖层候选、也不算用户窗口活跃度。
// 与 battery.js 的 CLEAR_DESKTOP_SKIP（清场跳过集）/DESKTOP_HIT_CLASSES（点即桌面集）同族异集
// ——各站点生效集刻意不同，勿顺手统一（差异指认见 battery.js 清单注）。
const PREFLIGHT_SHELL_CLASSES = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'SHELLDLL_DefView', 'SysListView32',
]);
// 电池自家窗标题（控制器提示条/面板本体/任务栏条带）：自家现场不算污染不算用户活动。
const PREFLIGHT_OWN_TITLES = new Set(['AGENT DECK', 'AGENT DECK ACCEPT HINT', 'DECK-TASKBAR']);

function classifyPreflight(probes = {}) {
  const entries = [];
  const panels = Array.isArray(probes.panelWindows) ? probes.panelWindows : [];
  const ghosts = Array.isArray(probes.ghostWindows) ? probes.ghostWindows : [];
  const overlays = Array.isArray(probes.fullscreenForeign) ? probes.fullscreenForeign : [];
  if (panels.length >= 2) {
    entries.push({ kind: 'double-panel', detail: `双面板并存：${panels.length} 扇面板本体窗（pid=${panels.map((p) => p.pid).join(', ')}）` });
  } else if (panels.length === 1) {
    const elev = panels[0].exeQueryable === false ? '；进程镜像不可查询——提权/僵尸嫌疑高' : '';
    entries.push({ kind: 'leftover-panel', detail: `遗留面板进程：pid=${panels[0].pid}（本电池未拉起任何面板）${elev}` });
  }
  for (const g of ghosts) {
    entries.push({ kind: 'dwm-ghost', detail: `dwm/OLE 幽灵窗：cls=${g.cls} pid=${g.pid}` });
  }
  for (const o of overlays) {
    entries.push({ kind: 'fullscreen-overlay', detail: `全屏覆盖层候选：cls=${o.cls} pid=${o.pid} title=${o.title || '(空)'}（全屏可见、未 cloaked、非壳层）` });
  }
  return entries;
}

/**
 * preflight 第五类污染源：用户窗口活跃度（工单34 方向3）。纯检查函数——输入与
 * classifyPreflight 同缝（整个 probes 对象；评审修正：两分类器入参形状统一，
 * 快照行取 probes.rows = battery.js preflightProbes 带出的可见窗行 + foreground 标记），
 * 输出=分类结论：检出 → 恰一条 user-window-activity；未检出 → 空数组。警示入账不拒跑、
 * 不进三路计数（ADR-0011：警示是 FAIL-ENV 证据链起点，不是断言）。
 *
 * 判据边界：前台被「普通用户应用窗」占据 = 用户在机的最强快照信号。壳层静态件
 * （桌面宿主/任务栏/DefView）、Ghost（归既有 dwm-ghost 类）、cloaked（不可见合成）、
 * 电池自家窗（selfPid/自家标题）在场均不算——它们不预示「轮中抬窗」这一遮挡根因。
 * 快照预测不了未来抬窗：本警示只证明「发起时刻机器有用户活动迹象」，供轮后定责对读。
 * @param {{rows?: {cls:string, title?:string, pid:number, selfPid?:number, visible?:boolean, cloaked?:boolean, foreground?:boolean}[]}} probes
 * @returns {{kind:'user-window-activity', detail:string}[]}
 */
function classifyUserWindowActivity(probes = {}) {
  const list = Array.isArray(probes.rows) ? probes.rows : [];
  const fg = list.find((r) => r && r.foreground);
  if (!fg) return [];
  const own = fg.selfPid != null && Number(fg.pid) === Number(fg.selfPid);
  if (PREFLIGHT_SHELL_CLASSES.has(fg.cls) || fg.cls === 'Ghost' || own
    || PREFLIGHT_OWN_TITLES.has(fg.title) || fg.cloaked || fg.visible === false) return [];
  return [{
    kind: 'user-window-activity',
    detail: `前台为用户应用窗：cls=${fg.cls} pid=${fg.pid}${fg.title ? ` title=${JSON.stringify(fg.title)}` : ''}——发起时刻机器有用户活动迹象，轮中抬窗风险在案`,
  }];
}

/**
 * preflight 第六类：托盘机器态（工单141，spec #145）。纯检查函数——入参同缝
 * （probes.trayMachine 由 battery 侧带出：本电池 exe 的 NotifyIconSettings 条目预告），
 * 输出=警示条目（不拒跑、不进三路计数）。它只预告：P8/P10 失败时的记账决定由
 * tray-machine-state.js 的严口径判定在断言位做出（tray-add 注册存证在场才入环境账）。
 * @param {{trayMachine?: {exe?:string, entryExists?:boolean, promoted?:number|null}|null}} probes
 * @returns {{kind:'tray-machine-state', detail:string}[]}
 */
function classifyTrayMachineState(probes = {}) {
  const tm = probes.trayMachine;
  if (!tm) return [];
  if (tm.entryExists === false) {
    return [{
      kind: 'tray-machine-state',
      detail: `NotifyIconSettings 无本电池 exe 条目（${tm.exe}）——新 exe 路径建档时序常态；P8/P10 托盘断言若失败将按严口径判定（tray-add 存证在场才入环境账，工单141）`,
    }];
  }
  if (tm.promoted !== 1) {
    return [{
      kind: 'tray-machine-state',
      detail: `托盘提升位未置（IsPromoted=${tm.promoted ?? '未设'}）——图标默认溢出层；P8 将自行提升，失败语将带机器态定向（工单141）`,
    }];
  }
  return [];
}

// —— 面板句柄（工单206，spec #202 决策1–6、12）——
// 面板生命周期的唯一原语面：发射（launch）→ 就绪（waitWindow）→ 重启（relaunch）
// → 清场（stop）→ 两套存活谓词（alive/responsive）。八块电池的「拉起样板 12 份、
// 重启样板 13 份、存活判据三套分散」由此收口。
//
// 状态所有权（#202 决策2）：发射子进程、面板自报 pid、主窗句柄、发射时点四件归句柄，
// 电池里的可变闭包总线随之消失。since 门默认＝上次发射时点（句柄记账）——
// 「忘给 sinceMs 致旧 boot 混入」那个坑由结构堵死，显式传值仍可覆盖（迁移期保持显式）。
//
// 三条纪律：
//   ① 强退序列沿用既有 createPanelControl（决策/后果分离、outcome 语义不变）；
//      本模块只做接线与状态记账，不记账、不抛、不重启。
//   ② heal 编排（停摆检出→排除窗→重启→健康闭窗）留电池层——生命周期模块不被报告记账依赖污染。
//   ③ 落点命中即健康那套属交互时序域，不归本模块（留给后续交互底座候选）。
//
// 就绪判据的三道承重件（工单206 独立审计必改项——各缺一道就会「拿错窗/拿旧窗」）：
//   ① boot 取本代次**最后**一条（.pop 口径，与 battery.js waitPanelWindow 同款）——
//      主电池 heal 路径故意把 since 门回溯 1.5 秒（battery.js「sinceMs 必给：事件文件里
//      还留着上一实例的 boot」），回溯门下同窗内可能同时存在「旧实例迟到的 boot」与
//      「新实例的 boot」：取首个会选中旧 boot → 拿旧 pid 寻窗 → 误报「重启后面板窗口未现」。
//      另有一族正典（通用事件等待 waitEvent('boot', pred) 取**首个**）——那族判据不用于寻窗；
//      两族并存不是笔误，勿「顺手统一」。
//   ② 标题是必填判据：空串/纯空白/缺省标题**不退化**为「任一可见窗即面板本体窗」（面板进程里
//      同在任务栏条带、菜单浮层窗——拿错窗＝把副窗当面板本体窗）。缺省时按「找不到窗」同形处置：
//      落可见 Chrome 窗诊断转储 + 立即返回 null（不抛——「不记账不抛」纪律不变，判负由调用方读）。
//   ③ 可见性是判据之一：不可见窗不认作就绪窗。
//
// 证据档分名（接线时按电池注入）：stdio=archive 的缺省去处是**单一共享文件**
// accept/evidence/panel-handle-child.log——八块电池共用会混批、红轮归因变难。
// 缺省值不改（保持既有语义），接线时用 deps.archivePath 注入各电池专属档名。
//
// 零 koffi 零 Report 依赖：窗口枚举/探活/时钟全经注入，注入式单测不碰真机；
// 真机默认实现走惰性 require（与既有模块同款形态——模块加载不拉原生模块）。

/** 发射形态 → 进程参数（#202 决策3：mode 只有 full/accept 两值；
 *  编排台账 §8 裁决 3：**扩枚举加 'tray-spike'**——母票的枚举漏了第五种发射形态
 *  （48-tray-spike 的 ['.','--tray-spike']，env 带 DECK_TRAY_CORPUS）。纯增量：
 *  既有两形态的参数逐字不变，六方法面不动，不加 extraArgs 键。 */
const PANEL_MODE_ARGS = {
  full: ['.'],
  accept: ['.', '--panel-accept'],
  'tray-spike': ['.', '--tray-spike'],
};
/** stdio 三形态（#202 决策4）：ignore=无管道 / drain=管道且排空 / archive=落证据档 */
const PANEL_STDIO_MODES = ['ignore', 'drain', 'archive'];
/** boot 存证轮询间隔（与既有 waitPanelWindow 的 60ms 同口径） */
const BOOT_POLL_MS = 60;
/** 就绪窗轮询间隔（与既有 waitPanelWindow 的 200ms 同口径） */
const WINDOW_POLL_MS = 200;
/** waitWindow 缺省超时（与既有 waitPanelWindow 的 20s 同口径） */
const DEFAULT_WAIT_WINDOW_MS = 20000;
/** WM_NULL 探活超时（与既有 battery.panelLiveness 的 2000ms 同口径） */
const PROBE_TIMEOUT_MS = 2000;
/** stderr 尾部长度（与既有 battery.js 的 4000 字符同口径） */
const STDERR_TAIL_CHARS = 4000;

/** 事件档读取缺省实现：JSONL 逐行解析（与既有 battery.js 的 readEvents 同形） */
function readEventLog(file) {
  if (!file) return [];
  try {
    return require('fs').readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** 窗标题缺省实现（win32.js 未导出标题读数；与 battery.js 的 windowTitle 同款 koffi 缓冲形态） */
function defaultWindowTitle(hwnd) {
  const user32 = require('koffi').load('user32.dll');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *buf, int nMax)');
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  if (n <= 0) return '';
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2));
  return s;
}

/** WM_NULL 探活缺省实现：窗还在 + 主线程在超时内应声（与既有 panelLiveness 同款口径）。
 *  结果指针必须给真缓冲：传 null 时 user32 可能不解引用而直接判失败，活着的面板会被误报假死。 */
function defaultResponsiveProbe(hwnd, timeoutMs) {
  const win32 = require('./win32');
  const h = Number(hwnd);
  if (!win32.IsWindow(h)) return false;
  try {
    const out = Buffer.alloc(16);
    return Boolean(win32.SendMessageTimeoutW(h, 0, 0, 0, 0x0002, timeoutMs, out));
  } catch { return false; }
}

/**
 * 面板句柄工厂（#202 决策3 的接口全集）。
 * @param {object} [deps] 注入接口（全部可缺省走真机实现）：
 *   spawn(cmd, args, opts) → child     发射器（缺省 child_process.spawn）
 *   execPath / appRoot / baseEnv        被拉起的可执行文件、工作目录、基础环境变量
 *   eventLogPath / readEvents()         事件档路径与读法（boot 自报 pid 的来源）
 *   isAlive(pid) / gracefulKill(child) / forceKillTree(pid) / sleep(ms) / now()  同面板控制模块
 *   topLevelWindows() / windowPid(h) / windowTitle(h) / windowClass(h) / isWindowVisible(h)  窗枚举与甄别
 *   responsiveProbe(h, timeoutMs)       WM_NULL 探活
 *   openArchive(file) / archivePath     stdio=archive 的证据档去处
 *   log(msg)                            日志出口（缺省 console.log）
 * @returns {{launch: Function, waitWindow: Function, relaunch: Function, stop: Function, alive: Function, responsive: Function}}
 */
function createPanelHandle(deps = {}) {
  const spawnFn = deps.spawn || ((cmd, args, opts) => require('child_process').spawn(cmd, args, opts));
  const execPath = deps.execPath || process.execPath;
  const appRoot = deps.appRoot || require('path').resolve(__dirname, '..', '..');
  const baseEnv = deps.baseEnv || process.env;
  const eventLogPath = deps.eventLogPath || '';
  const readEvents = deps.readEvents || (() => readEventLog(eventLogPath));
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const isAlive = deps.isAlive || defaultIsAlive;
  const gracefulKill = deps.gracefulKill || ((child) => { try { if (child) child.kill(); } catch { /* 尽力 */ } });
  const forceKillTree = deps.forceKillTree || ((pid) => {
    require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  });
  const topLevelWindows = deps.topLevelWindows || (() => require('./win32').topLevelWindows());
  const windowPid = deps.windowPid || ((h) => require('./win32').threadIdOf(h).pid);
  const windowTitle = deps.windowTitle || defaultWindowTitle;
  const windowClass = deps.windowClass || ((h) => require('./win32').className(h));
  const isWindowVisible = deps.isWindowVisible || ((h) => require('./win32').IsWindowVisible(h));
  const responsiveProbe = deps.responsiveProbe || defaultResponsiveProbe;
  const openArchive = deps.openArchive || ((file) => require('fs').openSync(file, 'a'));
  const archivePath = deps.archivePath || require('path').join(appRoot, 'accept', 'evidence', 'panel-handle-child.log');
  const log = deps.log || ((msg) => console.log(msg));

  // 强退序列复用既有面板控制模块（决策/后果分离、outcome 语义不变）
  const control = createPanelControl({ isAlive, gracefulKill, forceKillTree, sleep, now });

  // 句柄自持的四件状态（+ 末次发射配置与 stderr 尾，供 relaunch 复用与早亡留证）
  const state = {
    child: null,
    panelPid: null,
    hwnd: null,
    launchedAt: 0,
    sinceGate: 0,
    lastCfg: null,
    stderrTail: '',
  };

  /** 最新一条「本代次」的 boot 存证：since 门之后、自报 pid 可用的那一条 */
  function latestBoot(sinceMs) {
    const hits = (readEvents() || []).filter((e) => e && e.type === 'boot'
      && Number(e.t) >= Number(sinceMs) && Number(e.pid) > 0);
    return hits.length ? hits[hits.length - 1] : null;
  }

  /** 按 pid + 标题 + 类名 + 可见性甄别就绪窗（各电池传各自标题：面板本体／任务栏条带／浮层窗）。
   *  标题是必填判据，但**闸门只有一处**（waitWindow 入口）——这里不重复设防：
   *  设防点单一才测得到（重复设防会留下测不到的旁路，空标题照样从旁路漏成「任一可见窗」）。
   *  cls 缺省不做类名过滤（纯增量——不传 cls 时行为与原先逐字一致）。 */
  function findWindowByTitle(pid, title, cls) {
    const wins = topLevelWindows() || [];
    for (const h of wins) {
      if (Number(windowPid(h)) !== Number(pid)) continue;
      if (title && windowTitle(h) !== title) continue;
      if (cls && windowClass(h) !== cls) continue;
      if (!isWindowVisible(h)) continue;
      return h;
    }
    return null;
  }

  /** 就绪判据失败时的诊断转储：可见 Chrome 窗一览（红轮定位能力不降级） */
  function dumpChromeWindows(pid, title) {
    let rows = [];
    try {
      rows = (topLevelWindows() || []).slice(0, 12).map((h) => ({
        hwnd: h, pid: windowPid(h), cls: windowClass(h), title: windowTitle(h),
      }));
    } catch { rows = []; }
    const chrome = rows.filter((r) => String(r.cls || '').startsWith('Chrome'));
    const text = chrome.map((r) => `0x${Number(r.hwnd).toString(16)} pid=${r.pid} cls=${r.cls}`).join(' | ');
    log(`[panel-handle] pid=${pid == null ? '未知' : pid} 的窗口「${title}」未找到。controller.pid=${process.pid} 可见 Chrome 窗: ${text}`);
  }

  /** 排空纪律的结构保证（工单132 根因：管道无人读 → 64KB 写满 → 主线程同步写永久阻塞） */
  function attachDrain(child) {
    if (child && child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', () => {}); // 排空即全部：管道永不满，面板永不因 stdout 阻塞
    }
    if (child && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { // stderr 同排空，另截留尾部供早亡取证
        state.stderrTail = (state.stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
      });
    }
  }

  /**
   * 发射面板（配置差异全进参数；stdio 三形态单点化）。
   * @param {{mode: 'full'|'accept'|'tray-spike', cdpPort?: number|string, lagSentinel?: boolean, stdio?: 'ignore'|'drain'|'archive', extraEnv?: object}} cfg
   * @returns {{child: object, launchedAt: number, stderrTail: () => string}}
   */
  function launch(cfg = {}) {
    const mode = cfg.mode || 'full';
    const args = PANEL_MODE_ARGS[mode];
    if (!args) throw new Error(`面板句柄：未知发射形态 mode=${mode}（只认 full/accept/tray-spike）`);
    const stdio = cfg.stdio || 'ignore';
    if (!PANEL_STDIO_MODES.includes(stdio)) {
      throw new Error(`面板句柄：未知 stdio 形态 ${stdio}（只认 ignore/drain/archive）`);
    }

    const env = { ...baseEnv };
    if (eventLogPath) env.DECK_EVENT_LOG = eventLogPath;
    if (cfg.cdpPort !== undefined && cfg.cdpPort !== null && cfg.cdpPort !== '') env.DECK_CDP_PORT = String(cfg.cdpPort);
    if (cfg.lagSentinel) env.DECK_LAG_SENTINEL = '1';
    for (const [k, v] of Object.entries(cfg.extraEnv || {})) env[k] = v;

    const spawnOpts = { cwd: appRoot, env };
    if (stdio === 'ignore') spawnOpts.stdio = 'ignore';
    else if (stdio === 'drain') spawnOpts.stdio = ['ignore', 'pipe', 'pipe'];
    else {
      const fd = openArchive(archivePath);
      spawnOpts.stdio = ['ignore', fd, fd];
    }

    // 发射时点先记账后 spawn：面板 boot 存证的 t 必晚于此刻，since 门才有意义
    const launchedAt = now();
    const child = spawnFn(execPath, args, spawnOpts);
    state.child = child;
    state.launchedAt = launchedAt;
    state.sinceGate = launchedAt; // since 门默认＝本次发射时点
    state.panelPid = null;
    state.hwnd = null;
    state.stderrTail = '';
    // 末次发射配置快照：relaunch 逐字复现首发配置（extraEnv 一并快照——调用方事后改自己的
    // 对象不该改写重发配置）。「relaunch 静默退回 full 形态」会去撞单实例守卫，
    // 「新面板被拒收」正是母票要斩的形态——故配置保真由结构保证，不靠调用方记性。
    state.lastCfg = { ...cfg, extraEnv: cfg.extraEnv ? { ...cfg.extraEnv } : undefined };
    if (stdio === 'drain') attachDrain(child);
    return { child, launchedAt, stderrTail: () => state.stderrTail };
  }

  /**
   * 就绪判据（与生成分离）：先等本代次 boot 自报 pid，再按 pid + 标题（＋可选类名）找就绪窗。
   * 找不到窗时落可见 Chrome 窗诊断转储。
   *
   * 标题是就绪判据的**必填**件：空串/纯空白/缺省标题不退化为「任一可见窗即面板本体窗」（面板进程里
   * 同在任务栏条带、菜单浮层窗——拿错窗＝把副窗当面板本体窗）。缺省时按「找不到窗」同形处置：
   * 落可见 Chrome 窗诊断转储 + 立即返回 null（不抛：模块「不记账不抛」纪律不变，判负由调用方读）。
   * 标题按**原值**参与匹配（既有语义逐字不动）；「空白」只在闸门处判负（trim 后为空）。
   *
   * @param {{title: string, cls?: string, timeoutMs?: number}} req
   *   title：就绪窗标题（必填；空串/纯空白/缺省 → 判负返回 null）
   *   cls：可选类名过滤（缺省不做类名过滤——主电池现行判据的 Chrome_WidgetWin_1 一道）
   *   timeoutMs：超时 ms（缺省 20000）
   * @returns {Promise<object|null>} 就绪窗句柄；判负/超时返回 null
   */
  async function waitWindow(req = {}) {
    // 标题用**原值**参与匹配（既有语义逐字不动：调用方给什么就拿什么去比）；
    // 空白/缺省标题在闸门处判负——判负口径是「trim 后为空」，不改变任何非空标题的匹配结果。
    const title = typeof req.title === 'string' ? req.title : '';
    const cls = typeof req.cls === 'string' && req.cls ? req.cls : null;
    const timeoutMs = posInt(req.timeoutMs, DEFAULT_WAIT_WINDOW_MS);
    const gate = state.sinceGate;

    // 标题缺省/空白＝判据失准：按「找不到窗」同形处置——落诊断转储 + 立即返回 null
    // （不退化为「任一可见窗即面板本体窗」；不进轮询——判据已失准，等超时也只是白等）
    if (!title.trim()) {
      log('[panel-handle] waitWindow 缺省就绪窗标题——就绪判据失准（不退化为「任一可见窗即面板本体窗」），按找不到窗处置');
      dumpChromeWindows(state.panelPid, '(未指定)');
      return null;
    }

    // 1) boot 自报 pid：句柄解析（spawn 的 child.pid 在 Electron 父进程下不可靠——既有教训单点承载）
    const bootDeadline = now() + timeoutMs;
    let boot = null;
    while (now() < bootDeadline) {
      boot = latestBoot(gate);
      if (boot) break;
      await sleep(BOOT_POLL_MS);
    }
    if (!boot) {
      log(`[panel-handle] 未收到 boot 存证（since=${gate}）——面板未起来，或事件档路径与面板侧不一致`);
      return null;
    }
    state.panelPid = boot.pid;

    // 2) 按 pid + 标题甄别就绪窗
    const winDeadline = now() + timeoutMs;
    while (now() < winDeadline) {
      const hwnd = findWindowByTitle(boot.pid, title, cls);
      if (hwnd) { state.hwnd = hwnd; return hwnd; }
      await sleep(WINDOW_POLL_MS);
    }

    // 3) 超时：诊断转储（与既有 waitPanelWindow 的 dump 同款信息量）
    dumpChromeWindows(boot.pid, title);
    return null;
  }

  /**
   * 重启样板归一：强退 → 重发。强退失败（需重启清障）即中止信号——不重发，
   * 由调用方入环境降责账并中止后续段（句柄不记账不抛）。
   * @param {{sinceMs?: number}} [req] since 门显式覆盖（缺省＝新发射时点）
   * @returns {Promise<object>} 强退决策 + 是否真重发
   */
  async function relaunch(req = {}) {
    const stopped = await stop();
    if (!stopped.gone) {
      return { ...stopped, launched: false, child: state.child, launchedAt: state.launchedAt };
    }
    const receipt = launch(state.lastCfg || { mode: 'full' });
    if (req.sinceMs !== undefined && req.sinceMs !== null) state.sinceGate = Number(req.sinceMs);
    return { ...stopped, launched: true, child: receipt.child, launchedAt: receipt.launchedAt };
  }

  /**
   * 验证强退（沿用面板控制模块的强退序列：优雅终止→整树强杀→有界等待并验证消失）。
   * idle 短路语义保留；outcome 语义不变（'idle' | 'graceful-gone' | 'forced-gone' | 'restart-clear-required'）。
   * @returns {Promise<object>} 只返回决策，不记账、不重启、不抛
   */
  async function stop() {
    const child = state.child;
    const pids = [child && child.pid, state.panelPid].filter(Boolean);
    if (!child && !state.panelPid) {
      return { gone: true, graceful: true, forced: false, pidsLeft: [], outcome: 'idle' };
    }
    const res = await control.stop({ pids, child });
    state.child = null;
    state.panelPid = null;
    state.hwnd = null;
    return res;
  }

  /** 进程存在谓词（自报 pid 缺位时回落发射子进程 pid） */
  function alive() {
    const pid = state.panelPid || (state.child && state.child.pid);
    if (!pid) return false;
    return Boolean(isAlive(pid));
  }

  /** WM_NULL 探活谓词（主窗句柄缺位时无从探活） */
  function responsive() {
    if (!state.hwnd) return false;
    try { return Boolean(responsiveProbe(state.hwnd, PROBE_TIMEOUT_MS)); } catch { return false; }
  }

  return { launch, waitWindow, relaunch, stop, alive, responsive };
}

module.exports = { createPanelControl, createPanelHandle, findPanelWindows, classifyPreflight, classifyUserWindowActivity, classifyTrayMachineState, PREFLIGHT_SHELL_CLASSES, PREFLIGHT_OWN_TITLES, DEFAULT_GRACE_MS, DEFAULT_VERIFY_MS, DEFAULT_POLL_MS };
