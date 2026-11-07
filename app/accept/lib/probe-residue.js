'use strict';
/**
 * 栏布局存储的 P16 探针残留判别（工单255，纯逻辑）。
 *
 * 49-taskbar 的清场（cleanupRecsProbes）按「本轮探针身份」精确过滤 taskbar-layout.json
 * 的 pinned/recommended/excluded 三段，但有一个跨轮盲区：轮中途被硬杀（guard 超时/
 * 崩溃，P26 finally 不执行）时，P15B/P17 各臂 rec-remove 落账的排除条目随存储落盘
 * 存活到下一轮；下一轮清场的 probeExes 只含本轮身份，旧轮条目永不在集合内 ⇒ 每轮
 * P17②「excluded清空=false」自持红链（2026-10-27 三连红实证，红形态 = 回池=true 而
 * 名单非空；产品面 restoreEntry 只移除归一命中项，语义无责）。
 *
 * 本模块把「电池探针条目」按与轮次无关的落盘签名判别出来，供轮起笔扫除（面板拉起前
 * 读存储的任何进程都从干净名单起跑）。签名锚两处用户真实条目不可能携带的形态：
 * - label / name：探针桌面项名 `DECK-P16-<毫秒时戳>-<A..G>`（display 名 = 扩展名隐藏
 *   的 stem，scan.ts displayOf 同款口径；recommended 段存的是含 .lnk 的原始名）；
 * - exe：探针目标路径（`deck-p16-cmd.exe` 副本 / `deck-p16-probe-<A..G>.exe` 占位体，
 *   盘符分隔符两侧归一）与 usage 种子合成路径（`deck-p16-usage-seed` 目录）。
 * 纯字符串判别，无 IO 无 Electron 依赖。
 */

/** 探针 display 名（excluded/pinned 条目的 label）：DECK-P16-<时戳>-<A..G> */
const PROBE_LABEL_RE = /^DECK-P16-\d+-[A-G]$/i;
/** 探针目标 exe：deck-p16-cmd.exe（首条真启动臂副本）/ deck-p16-probe-X.exe（占位体） */
const PROBE_EXE_RE = /(^|[\\/])deck-p16-(cmd|probe-[a-g])\.exe$/i;
/** usage 种子合成路径（byStem 通道的假 exe，落在 deck-p16-usage-seed 目录下） */
const SEED_EXE_RE = /(^|[\\/])deck-p16-usage-seed([\\/]|$)/i;
/** 推荐位显式序条目（recommended 段存桌面项原始名，含扩展名） */
const PROBE_NAME_RE = /^DECK-P16-\d+-[A-G]\.lnk$/i;

/** pinned/excluded 条目形态 { exe, label, iconKey? } 是否电池探针残留 */
function isResidueEntry(entry) {
  const exe = String((entry && entry.exe) || '');
  const label = String((entry && entry.label) || '');
  return PROBE_EXE_RE.test(exe) || SEED_EXE_RE.test(exe) || PROBE_LABEL_RE.test(label);
}

/** recommended 显式序条目（桌面项名）是否电池探针残留 */
function isResidueName(name) {
  return PROBE_NAME_RE.test(String(name || ''));
}

/**
 * 三段扫除（纯函数，不改入参）：pinned/recommended/excluded 各自滤除电池签名条目，
 * 其余内容原样保留。removed 逐条记「段:身份」（label 优先，缺则 exe/name）供清场
 * note 留痕——静默改存储不算处置完成（章法定责留痕同款纪律）。
 */
function stripBatteryResidue(store) {
  const removed = [];
  const next = { ...store };
  if (Array.isArray(store.pinned)) {
    next.pinned = store.pinned.filter((e) => {
      const hit = isResidueEntry(e);
      if (hit) removed.push(`pinned:${(e && e.label) || (e && e.exe) || ''}`);
      return !hit;
    });
  }
  if (Array.isArray(store.recommended)) {
    next.recommended = store.recommended.filter((n) => {
      const hit = isResidueName(n);
      if (hit) removed.push(`recommended:${n}`);
      return !hit;
    });
  }
  if (Array.isArray(store.excluded)) {
    next.excluded = store.excluded.filter((e) => {
      const hit = isResidueEntry(e);
      if (hit) removed.push(`excluded:${(e && e.label) || (e && e.exe) || ''}`);
      return !hit;
    });
  }
  return { store: next, removed };
}

module.exports = { PROBE_LABEL_RE, PROBE_EXE_RE, SEED_EXE_RE, PROBE_NAME_RE, isResidueEntry, isResidueName, stripBatteryResidue };
