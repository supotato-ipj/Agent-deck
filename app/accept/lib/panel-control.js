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
 * @param {{panelWindows?: {pid:number, exeQueryable?:boolean}[], ghostWindows?: {cls:string,pid:number}[], fullscreenForeign?: {cls:string,pid:number,title?:string}[]}} probes
 * @returns {{kind: 'double-panel'|'leftover-panel'|'dwm-ghost'|'fullscreen-overlay', detail: string}[]}
 */

// 壳层白名单（工单34 自 battery.js 迁入单点维护）：桌面宿主/任务栏/DefView 属 shell
// 常驻件，既不算全屏覆盖层候选、也不算用户窗口活跃度。
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
 * preflight 第五类污染源：用户窗口活跃度（工单34 方向3）。纯检查函数——输入=窗口
 * 枚举快照行（battery.js 的 preflightProbes 行 + foreground 标记），输出=分类结论：
 * 检出 → 恰一条 user-window-activity；未检出 → 空数组。警示入账不拒跑、不进三路
 * 计数（ADR-0011：警示是 FAIL-ENV 证据链起点，不是断言）。
 *
 * 判据边界：前台被「普通用户应用窗」占据 = 用户在机的最强快照信号。壳层静态件
 * （桌面宿主/任务栏/DefView）、Ghost（归既有 dwm-ghost 类）、cloaked（不可见合成）、
 * 电池自家窗（selfPid/自家标题）在场均不算——它们不预示「轮中抬窗」这一遮挡根因。
 * 快照预测不了未来抬窗：本警示只证明「发起时刻机器有用户活动迹象」，供轮后定责对读。
 * @param {{cls:string, title?:string, pid:number, selfPid?:number, visible?:boolean, cloaked?:boolean, foreground?:boolean}[]} rows
 * @returns {{kind:'user-window-activity', detail:string}[]}
 */
function classifyUserWindowActivity(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
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

module.exports = { createPanelControl, findPanelWindows, classifyPreflight, classifyUserWindowActivity, PREFLIGHT_SHELL_CLASSES, PREFLIGHT_OWN_TITLES, DEFAULT_GRACE_MS, DEFAULT_VERIFY_MS, DEFAULT_POLL_MS };
