// performance.layout.user.js — 用户定制布局（覆盖 performance.layout.js）
// 硬件精简 4 行 + QODER 状态区块；右栏风格：值在前、.name 标签在后

function buildPerformanceHTML({ metric, spaces, qoder }) {
  const BR = `<p><br /></p>`;
  const L = (text) => `<span class="name">${text}</span>`;
  const row = (...args) => `<p>${args.join("")}</p>`;
  const pad = (v, n) => String(v).padStart(n, "0");

  const dispWidth = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
  const clip = (s, max) => {
    let w = 0;
    let out = "";
    for (const ch of s) {
      w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
      if (w > max) return out + "…";
      out += ch;
    }
    return out;
  };

  const CPU_USAGE = [{ source: "psutil", key: "cpu", unit: "%" }];
  const RAM_USAGE = [{ source: "psutil", key: "memory", unit: "%" }];
  const RAM_CAPACITY = [{ source: "psutil", key: "memory_gb" }];
  const GPU_USAGE = [{ source: "psutil", key: "gpu_usage", unit: "%" }];
  const GPU_TEMP = [{ source: "psutil", key: "gpu_temp", unit: "°C" }];
  const VRAM_USAGE = [{ source: "psutil", key: "vram_usage", unit: "%" }];
  const NET_DL = [{ source: "psutil", key: "download_speed" }];
  const NET_UP = [{ source: "psutil", key: "upload_speed" }];

  const lines = [
    row(metric({ sources: CPU_USAGE, format: "fixed" }), spaces(4), L("CPU")),
    BR,

    row(
      metric({ sources: RAM_USAGE, format: "fixed" }),
      spaces(2),
      metric({ sources: RAM_CAPACITY, format: "capacity-text", name: true }),
      spaces(2),
      L("RAM"),
    ),
    BR,

    row(
      metric({ sources: GPU_USAGE, format: "fixed" }),
      spaces(1),
      metric({ sources: GPU_TEMP, format: "fixed", alert: { max: 75 }, name: true }),
      spaces(2),
      L("GPU"),
      spaces(3),
      metric({ sources: VRAM_USAGE, format: "fixed" }),
      spaces(1),
      L("VRAM"),
    ),
    BR,

    row(
      metric({ sources: NET_DL, format: "net" }),
      spaces(2),
      L("DL"),
      spaces(3),
      metric({ sources: NET_UP, format: "net" }),
      spaces(2),
      L("UP"),
    ),
  ];

  // ====== QODER ======
  const session = qoder && qoder.session;
  lines.push(BR);

  if (!session) {
    lines.push(row(`OFFLINE`, spaces(4), L(`SESSIONS ${pad(qoder ? qoder.active_sessions : 0, 3)}`), spaces(3), L("QODER")));
  } else {
    const state = session.running ? `<span class="data-indicator">RUNNING</span>` : `IDLE${"\u00A0".repeat(4)}`;
    lines.push(
      row(state, spaces(3), L(`SESSIONS ${pad(qoder.active_sessions, 3)}`), spaces(3), L("QODER")),
    );
    lines.push(BR);
    lines.push(row(clip(session.project || "?", 24), spaces(3), L("PROJ")));
    lines.push(BR);

    if (session.tasks_total > 0) {
      const done = Math.min(session.tasks_done, session.tasks_total);
      const filled = Math.round((done / session.tasks_total) * 10);
      const bar = `[${"#".repeat(filled)}${"-".repeat(10 - filled)}]`;
      lines.push(row(`${pad(done, 3)}/${pad(session.tasks_total, 3)}`, spaces(1), bar, spaces(2), L("TASKS")));
    } else {
      lines.push(row(`NO${"\u00A0"}TASKS`, spaces(2), L("TASKS")));
    }

    if (session.current_task) {
      lines.push(BR);
      lines.push(row(clip(session.current_task, 32), spaces(3), L("NOW")));
    }
  }

  return lines.join("");
}
