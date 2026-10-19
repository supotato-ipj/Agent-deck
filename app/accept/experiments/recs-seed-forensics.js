// 工单160 P16 红轮取证（2026-10-13 首轮 49-taskbar：P16 探针未占满推荐位，几何=真实条目 top-5）。
// 复现「种入 → 打分 → 推荐位」全链路（内核本地装配，与数据面子进程同一套纯函数与
// 读盘口径）。**取证结论（已据此修复 taskbar.js seedRecsProbes）**：os.tmpdir() 给 8.3
// 短名（C:\Users\ANW~1\AppData\Local\Temp），lnk 经 Electron readShortcutLink 解析回
// 长名（C:\Users\An W\AppData\Local\Temp）——种子事件 exe 与 byTarget 键形差不归一，
// mapScoresToItems 整段映射不上（探针显示分 undefined，红轮实证见下）。修法 = lnk 落地
// 后经 shell.readShortcutLinkSync 读回面板视角形态再种分。实验本身已带同款读回，可复跑
// 验证。只跑计算与磁盘，不建任何窗口；结束按行摘除 usage 种子、删除夹具。
// 运行：npx electron accept/experiments/recs-seed-forensics.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

function psRun(args) {
  const r = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`powershell 失败: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function createLnk(lnkPath, targetPath) {
  const script = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($args[0])',
    '$s.TargetPath = $args[1]',
    '$s.Save()',
    "Write-Output ('exists=' + (Test-Path -LiteralPath $args[0]))",
  ].join('\n');
  const scriptFile = path.join(os.tmpdir(), 'deck-exp-lnk.ps1');
  fs.writeFileSync(scriptFile, script, 'utf8');
  try {
    return psRun(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, lnkPath, targetPath]);
  } finally {
    try { fs.unlinkSync(scriptFile); } catch { /* 尽力 */ }
  }
}

app.whenReady().then(async () => {
  const desktopRoot = psRun(['-NoProfile', '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Environment]::GetFolderPath("Desktop")']);
  // 面板 userData：裸 electron 进程的 app 名是 Electron——与面板（package.json name =
  // agent-deck-panel）不同源；实验按面板同款口径解析（APPDATA\agent-deck-panel）。
  const panelUserData = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'agent-deck-panel')
    : app.getPath('userData');
  console.log('[exp] 桌面根 =', desktopRoot);
  console.log('[exp] 面板 userData =', panelUserData, '（本进程默认 =', app.getPath('userData'), '）');

  const t = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'deck-exp-p16-'));
  let target = path.join(tmpDir, 'deck-exp-probe.exe');
  fs.writeFileSync(target, 'deck-exp placeholder', 'utf8');
  const name = `DECK-EXP-${t}.lnk`;
  const lnkPath = path.join(desktopRoot, name);
  console.log('[exp] lnk 创建 →', createLnk(lnkPath, target));
  // 种子 exe 与面板解析同形（短名→长名读回；readShortcutLink 无 Sync 后缀）
  try {
    const resolved = require('electron').shell.readShortcutLink(lnkPath);
    if (resolved && resolved.target) {
      console.log('[exp] 短名 →', target, '→ 长名 →', resolved.target);
      target = resolved.target; // eslint-disable-line
    }
  } catch { /* 读回失败保底 */ }

  // usage 种子（与电池同口径：UTC 日文件、秒精度 ts、2000 条；目录 = 面板 userData）
  const usageDir = path.join(panelUserData, 'usage');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const usageFile = path.join(usageDir, `start-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.jsonl`);
  const ts = new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  let blob = '';
  for (let i = 0; i < 2000; i++) blob += JSON.stringify({ ts, exe: target }) + '\n';
  fs.mkdirSync(usageDir, { recursive: true });
  fs.appendFileSync(usageFile, blob, 'utf8');
  console.log('[exp] usage 种子 →', usageFile, `(+2000 行, ${blob.length}B)`);

  const { createKernel } = require(path.join(__dirname, '..', '..', 'dist', 'main', 'kernel.js'));
  const ctx = createKernel({
    tickIntervalMs: 0, hardwareIntervalMs: 0, usageIntervalMs: 0, searchIntervalMs: 0,
    usage: { dir: usageDir },
    taskbar: { enabled: false, storeFile: path.join(tmpDir, 'taskbar-layout.json'), legacyLayoutFile: path.join(tmpDir, 'layout.json') },
  });
  await ctx.start();
  try {
    ctx.desktop.refresh();
    const items = ctx.desktop.state().items;
    const probeItem = items.find((i) => i.name === name);
    console.log('[exp] 池内夹具条目 =', probeItem ? JSON.stringify(probeItem) : '不在池内！');
    // 目标解析直查（desktop 服务同款真源 electronShortcutTarget）
    const adapter = require(path.join(__dirname, '..', '..', 'dist', 'main', 'desktop', 'adapter.js'));
    let resolved = null;
    try { resolved = adapter.electronShortcutTarget(lnkPath); } catch (err) { resolved = `THROW: ${err.message}`; }
    console.log('[exp] electronShortcutTarget(lnk) =', JSON.stringify(resolved));
    console.log('[exp] 种子 exe =', JSON.stringify(target));
    console.log('[exp] 归一相等 =', resolved === null ? 'n/a' : String(resolved.toLowerCase()) === target.toLowerCase());
    const scores = ctx.desktop.usageScores();
    const probeScore = probeItem ? scores.get(probeItem.display) : undefined;
    console.log('[exp] 探针显示分 =', probeScore);
    const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log('[exp] 分数 top8 =', JSON.stringify(top));
    const recs = require(path.join(__dirname, '..', '..', 'dist', 'main', 'taskbar', 'plan.js')).planTaskbarRecommendations(items, scores);
    console.log('[exp] 推荐位 =', JSON.stringify(recs.map((r) => ({ name: r.name, exe: r.exe })), null, 1));
  } finally {
    await ctx.stop();
    // 清理：夹具 + usage 按行摘除 + 临时目录
    try { fs.unlinkSync(lnkPath); } catch { /* 尽力 */ }
    try {
      const probeExes = new Set([target.toLowerCase()]);
      const text = fs.readFileSync(usageFile, 'utf8');
      const kept = text.split('\n').filter((l) => {
        if (!l.trim()) return false;
        try { return !probeExes.has(String(JSON.parse(l).exe || '').toLowerCase()); } catch { return true; }
      });
      fs.writeFileSync(usageFile, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    } catch { /* 尽力 */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
    app.exit(0);
  }
}).catch((err) => {
  console.error('[exp] 失败:', err);
  app.exit(1);
});
