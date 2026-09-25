/* AGENT DECK 界面逻辑：1s 轮询 /deck，DOM-diff 渲染会话列表，聚焦详情 + 预览流，
   底栏仪表与曲线；WE 属性仅一个 perspective 开关（HUD 透视，默认开）。
   数据服务挂掉时保留上一帧、显示 OFFLINE 角标（spec 故事 10）。 */
"use strict";

const API = "http://127.0.0.1:5000/deck";
const POLL_MS = 1000;
const STREAM_CAP = 8;
const TOOL_LABELS = { qoder: "QD", kimicode: "KC", kimiwork: "KW", zcode: "ZC", hermes: "HM" };
const TOOL_NAMES = { qoder: "QODER", kimicode: "KIMI CODE", kimiwork: "KIMI WORK", zcode: "ZCODE", hermes: "HERMES" };

const els = {
  clock: document.getElementById("clock"),
  count: document.getElementById("session-count"),
  offline: document.getElementById("offline-badge"),
  list: document.getElementById("session-list"),
  standby: document.getElementById("standby"),
  focusBody: document.getElementById("focus-body"),
  gaugesRow: document.getElementById("gauges-row"),
  curves: document.getElementById("curves"),
};

let hudOn = true;
let focusedKey = null;
const streams = new Map();   // key -> [{role, text}, ...] 客户端累积，上限 STREAM_CAP
let lastDeck = null;

/* ---- 小工具 ---- */

const pad3 = (n) => String(n).padStart(3, "0");

function bar(pct, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "[" + "#".repeat(filled) + "-".repeat(width - filled) + "]";
}

function fmtSpeed(bytes) {
  if (bytes == null || isNaN(bytes)) return "---";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + "MB/s";
  if (bytes >= 1024) return Math.round(bytes / 1024) + "KB/s";
  return Math.round(bytes) + "B/s";
}

function sessionName(s) {
  return s.title || s.project || "";
}

function keyOf(s) {
  return s.tool + "+" + s.id;
}

/* ---- 时钟（本地走秒，与数据服务无关） ---- */

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
}
setInterval(tickClock, 250);
tickClock();

/* ---- 会话列表：按 tool+id 做 DOM-diff，保住 hover/focused 类与展开态 ---- */

function buildRow(s) {
  const li = document.createElement("li");
  li.className = "session-row";
  li.dataset.key = keyOf(s);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = TOOL_LABELS[s.tool] || s.tool.toUpperCase();
  li.appendChild(label);

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = sessionName(s);
  li.appendChild(name);

  const prog = document.createElement("span");
  prog.className = "progress";
  if (s.tasks_total != null) {
    const pct = s.tasks_total ? (s.tasks_done / s.tasks_total) * 100 : 0;
    prog.textContent = s.tasks_done + "/" + s.tasks_total + " " + bar(pct);
  }
  li.appendChild(prog);

  const preview = document.createElement("span");
  preview.className = "preview";
  li.appendChild(preview);

  li.addEventListener("mouseenter", () => li.classList.add("hover"));
  li.addEventListener("mouseleave", () => li.classList.remove("hover"));
  li.addEventListener("click", () => { focusedKey = keyOf(s); renderFocus(); });
  return li;
}

function updateRow(li, s) {
  li.querySelector(".name").textContent = sessionName(s);
  const prog = li.querySelector(".progress");
  if (s.tasks_total != null) {
    const pct = s.tasks_total ? (s.tasks_done / s.tasks_total) * 100 : 0;
    prog.textContent = s.tasks_done + "/" + s.tasks_total + " " + bar(pct);
  } else {
    prog.textContent = "";
  }
  li.querySelector(".preview").textContent = s.preview || "";
  li.classList.toggle("focused", keyOf(s) === focusedKey);
}

function renderList(sessions) {
  els.count.textContent = pad3(sessions.length);
  const list = els.list;

  // 待机态 ↔ 列表切换：两边都要清干净（当年验收修过空→非空残留占位的 bug）
  if (!sessions.length) {
    Array.from(list.children).forEach((li) => {
      if (!li.classList.contains("standby")) li.remove();
    });
    if (els.standby.parentNode !== list) list.appendChild(els.standby);
    return;
  }
  if (els.standby.parentNode === list) list.removeChild(els.standby);

  const seen = new Set(sessions.map(keyOf));
  Array.from(list.children).forEach((li) => {
    if (!li.classList.contains("standby") && !seen.has(li.dataset.key)) li.remove();
  });

  // 期望顺序 = 现有节点复用（保住 hover/focused 类），缺的现建；顺序变了按序重挂
  const desired = sessions.map((s) => {
    return (
      list.querySelector(`[data-key="${CSS.escape(keyOf(s))}"]`) || buildRow(s)
    );
  });
  const current = Array.from(list.children).filter((li) => !li.classList.contains("standby"));
  const inOrder =
    current.length === desired.length && current.every((li, i) => li === desired[i]);
  if (!inOrder) desired.forEach((li) => list.appendChild(li));
  sessions.forEach((s, i) => updateRow(desired[i], s));
}

/* ---- 聚焦详情 ---- */

function pushStream(s) {
  if (!s.preview) return;
  const key = keyOf(s);
  let arr = streams.get(key);
  if (!arr) { arr = []; streams.set(key, arr); }
  if (!arr.length || arr[0].text !== s.preview) {
    arr.unshift({ role: s.preview_role || "", text: s.preview });
    if (arr.length > STREAM_CAP) arr.length = STREAM_CAP;
  }
}

function renderFocus() {
  const sessions = (lastDeck && lastDeck.sessions) || [];
  let s = sessions.find((x) => keyOf(x) === focusedKey);
  if (!s) s = sessions[0] || null;   // 聚焦会话消失后落到最新一行
  if (focusedKey && s) focusedKey = keyOf(s);

  if (!s) {
    els.focusBody.className = "focus-standby";
    els.focusBody.textContent = "NO ACTIVE SESSIONS";
    return;
  }

  els.focusBody.className = "";
  els.focusBody.innerHTML = "";

  const head = document.createElement("div");
  head.className = "head";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = (TOOL_LABELS[s.tool] || "") + " " + sessionName(s);
  const state = document.createElement("span");
  state.className = "state state-" + s.state;
  state.textContent = s.state;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = TOOL_NAMES[s.tool] + " · AGE " + s.age + "S";
  head.append(name, state, meta);
  els.focusBody.appendChild(head);

  if (s.current_task) {
    const now = document.createElement("div");
    now.className = "now";
    now.innerHTML = '<span class="dim">NOW</span> ';
    now.appendChild(document.createTextNode(s.current_task));
    els.focusBody.appendChild(now);
  }

  if (s.tasks && s.tasks.length) {
    const ul = document.createElement("ul");
    ul.className = "task-list";
    for (const t of s.tasks) {
      const li = document.createElement("li");
      if (t.status === "completed") li.classList.add("completed");
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = t.status === "completed" ? "×" : t.status === "in_progress" ? "›" : "·";
      const txt = document.createElement("span");
      txt.textContent = t.subject;
      li.append(mark, txt);
      ul.appendChild(li);
    }
    els.focusBody.appendChild(ul);
  } else if (s.tasks_total != null) {
    const cnt = document.createElement("div");
    cnt.className = "now";
    cnt.innerHTML = '<span class="dim">TASKS</span> ' + s.tasks_done + "/" + s.tasks_total + " " + bar(s.tasks_total ? (s.tasks_done / s.tasks_total) * 100 : 0);
    els.focusBody.appendChild(cnt);
  }

  const stream = streams.get(keyOf(s)) || [];
  if (stream.length) {
    const ul = document.createElement("ul");
    ul.className = "stream";
    for (const item of stream) {
      const li = document.createElement("li");
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = (item.role || "?").toUpperCase().slice(0, 4);
      li.appendChild(who);
      li.appendChild(document.createTextNode(item.text));
      ul.appendChild(li);
    }
    els.focusBody.appendChild(ul);
  }
}

/* ---- 底栏仪表与曲线 ---- */

const GAUGE_DEFS = [
  { key: "cpu",         label: "CPU",  fmt: (v) => (v == null ? "---" : Math.round(v) + "%"), bar: (g) => g.cpu },
  { key: "memory",      label: "MEM",  fmt: (v) => (v == null ? "---" : Math.round(v) + "%"), bar: (g) => g.memory },
  { key: "gpu_usage",   label: "GPU",  fmt: (v) => (v == null ? "---" : Math.round(v) + "%"), bar: (g) => g.gpu_usage },
  { key: "vram_usage",  label: "VRAM", fmt: (v) => (v == null ? "---" : Math.round(v) + "%"), bar: (g) => g.vram_usage },
  { key: "download_speed", label: "DL", fmt: (v) => fmtSpeed(v), bar: null },
  { key: "upload_speed",   label: "UL", fmt: (v) => fmtSpeed(v), bar: null },
];

function renderGauges(gauges, offline) {
  els.gaugesRow.innerHTML = "";
  for (const def of GAUGE_DEFS) {
    const v = offline ? null : gauges[def.key];
    const span = document.createElement("span");
    span.className = "gauge" + ((v == null) ? " na" : "");
    const label = document.createElement("span");
    label.className = "unit";
    label.textContent = def.label;
    const val = document.createElement("span");
    val.className = "bar";
    val.textContent = def.fmt(v) + (def.bar && v != null ? " " + bar(def.bar(gauges)) : "");
    span.append(label, val);
    els.gaugesRow.appendChild(span);
  }
}

function renderCurves(history) {
  const cvs = els.curves;
  const ctx = cvs.getContext("2d");
  if (cvs.width !== cvs.clientWidth) cvs.width = cvs.clientWidth;
  const w = cvs.width, h = cvs.height;
  ctx.clearRect(0, 0, w, h);

  const draw = (series, max, color, dash) => {
    if (!series || !series.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    series.forEach((v, i) => {
      const x = (i / Math.max(1, series.length - 1)) * w;
      const y = h - (max ? Math.min(1, Math.max(0, v / max)) : 0) * (h - 6) - 3;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };

  draw(history.cpu, 100, "rgba(225,225,225,0.8)");
  const netMax = Math.max(1024, ...(history.dl || []), ...(history.up || []));
  draw(history.dl, netMax, "rgba(225,225,225,0.5)");
  draw(history.up, netMax, "rgba(225,225,225,0.3)", [4, 4]);
}

/* ---- 轮询主循环 ---- */

async function poll() {
  let deck = null;
  try {
    const resp = await fetch(API, { cache: "no-store" });
    if (resp.ok) deck = await resp.json();
  } catch (e) {
    // 服务不在：离线角标 + 仪表 ---，画面保留上一帧
  }
  const offline = deck === null;
  els.offline.classList.toggle("hidden", !offline);
  if (offline) {
    renderGauges({}, true);
    return;
  }
  lastDeck = deck;
  for (const s of deck.sessions) pushStream(s);
  renderList(deck.sessions);
  renderFocus();
  renderGauges(deck.gauges || {}, false);
  renderCurves(deck.history || {});
}

setInterval(poll, POLL_MS);
poll();

/* ---- Wallpaper Engine 属性：HUD 透视开关（默认开） ---- */

window.wallpaperPropertyListener = {
  applyUserProperties(properties) {
    if (properties.perspective) {
      hudOn = !!properties.perspective.value;
      document.body.classList.toggle("hud-off", !hudOn);
    }
  },
};
