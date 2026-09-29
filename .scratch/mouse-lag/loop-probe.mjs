// 主进程事件循环阻塞探针：经 Node inspector 连进 Electron 主进程，
// 装 50ms 心跳（纯全局 API，全局作用域无 require），等待 N 秒后回收停顿统计。
// 用法: node loop-probe.mjs --seconds 140
const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf('--seconds') + 1] || 120);

async function getTargetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9229/json/list');
      const targets = await res.json();
      const t = targets.find((t) => t.type === 'node') || targets[0];
      if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('inspector not reachable after 60s');
}

const ws = new WebSocket(await getTargetWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
function call(method, params) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
  }
};

await call('Runtime.enable');

async function evaluate(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) console.log('EVAL-EXCEPTION ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r;
}

const install = `(() => {
  if (globalThis.__probe) return 'already';
  const p = { t0: Date.now(), beats: [Date.now()] };
  p.timer = setInterval(() => p.beats.push(Date.now()), 50);
  globalThis.__probe = p;
  return 'installed@' + new Date().toISOString();
})()`;
const inst = await evaluate(install);
console.log('PROBE ' + inst.result.value);

const keepAlive = setInterval(() => {
  call('Runtime.evaluate', { expression: '0', returnByValue: true }).catch(() => {});
}, 10000);

await new Promise((r) => setTimeout(r, seconds * 1000));

const collect = `(() => {
  const p = globalThis.__probe;
  if (!p) return 'missing';
  clearInterval(p.timer);
  const gaps = [];
  for (let i = 1; i < p.beats.length; i++) gaps.push(p.beats[i] - p.beats[i - 1]);
  gaps.sort((a, b) => a - b);
  const q = (x) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * x))] : 0);
  const over = (ms) => gaps.filter((g) => g >= ms).length;
  const stalls = [];
  for (let i = 1; i < p.beats.length; i++) {
    const g = p.beats[i] - p.beats[i - 1];
    if (g >= 150) stalls.push({ t: new Date(p.beats[i]).toISOString(), gapMs: g });
  }
  return JSON.stringify({
    installedAt: new Date(p.t0).toISOString(),
    durationMs: Date.now() - p.t0,
    beats: p.beats.length,
    gapMs: { p50: q(0.5), p90: q(0.9), p99: q(0.99), max: gaps[gaps.length - 1] || 0 },
    gapsOver: { '20ms': over(20), '50ms': over(50), '150ms': over(150) },
    stallsOver150ms: stalls.slice(0, 50),
  });
})()`;
const out = await evaluate(collect);
console.log('RESULT ' + out.result.value);
clearInterval(keepAlive);
ws.close();
