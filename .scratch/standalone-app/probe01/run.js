'use strict';
const { app } = require('electron');
const path = require('path');

const probeName = process.argv[2] || 'a';

app.whenReady().then(async () => {
  let report = null;
  try {
    const mod = require(path.join(__dirname, 'probes', probeName));
    report = await mod();
  } catch (e) {
    console.error('PROBE CRASH:', e && e.stack || e);
    process.exitCode = 2;
  } finally {
    try {
      const { cleanupAll } = require('./lib/harness');
      await cleanupAll();
    } catch { /* 尽力清理 */ }
  }
  if (report && report.fails > 0) process.exitCode = 1;
  app.quit();
}).catch(e => {
  console.error('APP READY FAILED:', e && e.stack || e);
  process.exitCode = 2;
  app.quit();
});

app.on('window-all-closed', () => { /* 由探针自行收尾后退出 */ });
