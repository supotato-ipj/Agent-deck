// probe-t328 测量 harness：0/1/5/10 个执行上下文 × 3 轮，冷启动拉起独立 Electron 实例，
// 收集 ready→全部 did-finish-load 时延、app.getAppMetrics() 汇总内存与进程数，输出中位数表格。
// 用法：node measure-run.mjs <rawOutputDir>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WORKTREE = 'D:/test-folder/wallpaperengine-research--spec326-t328/app';
const ELECTRON = path.join(WORKTREE, 'node_modules/electron/dist/electron.exe');
const PROBE = path.join(WORKTREE, 'probe-t328');
const OUT_DIR = process.argv[2] || path.join(os.tmpdir(), 'probe-t328-raw');
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
for (const n of [0, 1, 5, 10]) {
  for (let r = 1; r <= 3; r++) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'probe-t328-run-'));
    const resFile = path.join(tmp, 'res.json');
    const t = Date.now();
    const code = await new Promise((resolve) => {
      const p = spawn(ELECTRON, [PROBE], {
        env: { ...process.env, PROBE_MODE: 'measure', PROBE_N: String(n), PROBE_RESULT: resFile },
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      const to = setTimeout(() => { try { p.kill(); } catch {} resolve('timeout'); }, 60000);
      p.on('exit', (c) => { clearTimeout(to); resolve(c === 0 ? 0 : `exit${c}:${err.slice(-300)}`); });
    });
    let data = null;
    try { data = JSON.parse(readFileSync(resFile, 'utf8')); } catch {}
    results.push({ n, round: r, code, wall_ms: Date.now() - t, data });
    console.log(`N=${n} round=${r} code=${code} loaded_in=${data ? data.ready_to_loaded_ms : '?'}ms`);
  }
}
writeFileSync(path.join(OUT_DIR, 'raw-measure.json'), JSON.stringify(results, null, 2));

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rows = [];
for (const n of [0, 1, 5, 10]) {
  const rs = results.filter((x) => x.n === n && x.data);
  if (!rs.length) { rows.push({ n, error: 'no data' }); continue; }
  rows.push({
    n,
    ready_to_loaded_ms_median: median(rs.map((x) => x.data.ready_to_loaded_ms)),
    ready_to_loaded_ms_all: rs.map((x) => x.data.ready_to_loaded_ms),
    t0_to_ready_ms_median: median(rs.map((x) => x.data.t0_to_ready_ms)),
    rss_main_mb_median: +(median(rs.map((x) => x.data.rss_main_bytes)) / 1048576).toFixed(1),
    process_count_median: median(rs.map((x) => x.data.process_count)),
    processes_by_type: rs[rs.length - 1].data.processes_by_type,
    workingSet_total_mb_median: +(median(rs.map((x) => x.data.workingSet_total_kb)) / 1024).toFixed(1),
    private_total_mb_median: +(median(rs.map((x) => x.data.private_total_kb)) / 1024).toFixed(1)
  });
}
writeFileSync(path.join(OUT_DIR, 'summary-measure.json'), JSON.stringify(rows, null, 2));
console.log('\n| N 上下文 | ready→全部加载 (ms, 3轮中位) | 模块→ready (ms) | 主进程 RSS (MB) | 进程数 | 进程分布 | 全进程 workingSet (MB) | 全进程 private (MB) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  if (row.error) { console.log(`| ${row.n} | ${row.error} | | | | | | |`); continue; }
  console.log(`| ${row.n} | ${row.ready_to_loaded_ms_median} ( ${row.ready_to_loaded_ms_all.join(', ')} ) | ${row.t0_to_ready_ms_median} | ${row.rss_main_mb_median} | ${row.process_count_median} | ${JSON.stringify(row.processes_by_type)} | ${row.workingSet_total_mb_median} | ${row.private_total_mb_median} |`);
}
