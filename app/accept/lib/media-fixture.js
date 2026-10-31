'use strict';
/**
 * 工单336 C6 媒体夹具（真机 SMTC 会话源；配方 = spec326-notes/t329-gsmtc 探针收窄）：
 * 本地 http 服务（5 秒 440Hz 正弦 wav 循环 + artwork PNG + mediaSession metadata）+
 * 隔离 profile Edge 播放（autoplay 免手势）。媒体纪律：音量 0.04 低音量、小文件循环、
 * stop() = taskkill /T /F 进程树 + 临时 profile 删除 + 服务关停（播完即停、进程用完即杀）。
 */
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 16x16 纯红 PNG（SMTC artwork；Chromium 侧自行缩放——探针实测喂什么尺寸都缩到 150x150） */
const ART_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGP4z8BAEiJN9aiGUQ0MQ0kDAJD5/wGaM2eTAAAAAElFTkSuQmCC';

function toneWav() {
  const sampleRate = 8000;
  const seconds = 5;
  const n = sampleRate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function pageHtml(artDataUrl) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>t336-fixture</title></head><body>\n' +
    '<audio id="a" src="/tone.wav" loop></audio>\n' +
    '<script>\n' +
    'const art = "' + artDataUrl + '";\n' +
    'function setMeta() {\n' +
    '  if (!("mediaSession" in navigator)) return;\n' +
    '  navigator.mediaSession.metadata = new MediaMetadata({ title: "T336 Accept Track", artist: "Deck Accept Artist", album: "T336", artwork: [{ src: art, sizes: "256x256", type: "image/png" }] });\n' +
    '}\n' +
    'const a = document.getElementById("a");\n' +
    'a.volume = 0.04;\n' +
    'a.play().catch(() => {});\n' +
    'setMeta();\n' +
    'a.addEventListener("playing", setMeta);\n' +
    'document.title = "t336-fixture-playing";\n' +
    '</script></body></html>';
}

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of candidates) {
    try { fs.accessSync(c); return c; } catch { /* 试下一个 */ }
  }
  return null;
}

async function startMediaFixture() {
  const wav = toneWav();
  const artBuf = Buffer.from(ART_B64, 'base64');
  const artUrl = 'data:image/png;base64,' + ART_B64;
  const server = http.createServer((req, res) => {
    if (req.url === '/tone.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav); return; }
    if (req.url === '/art.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(artBuf); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(artUrl));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const url = 'http://127.0.0.1:' + addr.port + '/t336.html';
  const edge = findEdge();
  if (!edge) {
    server.close();
    throw new Error('Edge 未找到（媒体夹具需要 Edge 播本地页面注册 SMTC 会话）');
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t336-edge-'));
  const child = spawn(edge, [
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=320,220',
    url,
  ], { stdio: 'ignore' });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
      });
    } catch { /* 进程可能已退 */ }
    await new Promise((r) => setTimeout(r, 800));
    try { server.close(); } catch { /* 尽力 */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 尽力 */ }
  };
  return { url, pid: child.pid, edge, stop };
}

module.exports = { startMediaFixture, findEdge };
