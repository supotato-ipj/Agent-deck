'use strict';
/**
 * 工单336 C6 媒体夹具（真机 SMTC 会话源）＝原生 MediaPlayer 源 exe（resources/smtc-fixture/
 * fixture-smtc.exe，源码+build.cmd 同目录随库入库）：
 *   - Windows.Media.Playback.MediaPlayer + CommandManager 自动注册 SMTC（Electron 网页播放
 *     不注册 SMTC——t329 探针负结果；本路正例全链定谳 v6）。
 *   - 选型史（真机排障全记录 spec326-notes/t336-media/）：隔离 profile Edge 的首跑态压制 SMTC
 *     （媒体在播但系统无会话，多旗标+CDP 清场均无效）、用户 Edge 自动播被策略挡（运行实例不吃
 *     命令行旗标）、.NET IInspectable 裸 vtable interop 编组 NRE——MediaPlayer 路全通。
 * 媒体纪律：wav 本身低振幅 5s 循环、stop() = stdin "stop" 优雅停 + 临时文件清理，进程用完即杀。
 */
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 16x16 纯红 PNG（SMTC artwork 缩略图源） */
const ART_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGElEQVR4nGP4z8BAEiJN9aiGUQ0MQ0kDAJD5/wGaM2eTAAAAAElFTkSuQmCC';

/** 5 秒 440Hz 正弦 wav（合法头：blockAlign=2/16bit 单声道） */
function toneWav() {
  const sampleRate = 8000;
  const seconds = 5;
  const n = sampleRate * seconds;
  const data = Buffer.alloc(n * 2);
  // 振幅 8/32767（≈-72dB，人耳不可闻）：SMTC 注册只要求媒体管道在走，不需要可听音——
  // 早期 12000 振幅的 440Hz 循环音刺耳（用户投诉实证），改近静音。
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8), i * 2);
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

function fixtureExe() {
  const p = path.join(__dirname, '..', '..', 'resources', 'smtc-fixture', 'fixture-smtc.exe');
  try { fs.accessSync(p); return p; } catch { return null; }
}

async function startMediaFixture() {
  const exe = fixtureExe();
  if (!exe) throw new Error('SMTC 源夹具缺席（resources/smtc-fixture/fixture-smtc.exe 未入库）');
  const wavPath = path.join(os.tmpdir(), `t336-tone-${process.pid}.wav`);
  const artPath = path.join(os.tmpdir(), `t336-art-${process.pid}.png`);
  fs.writeFileSync(wavPath, toneWav());
  fs.writeFileSync(artPath, Buffer.from(ART_B64, 'base64'));
  const child = spawn(exe, [wavPath, artPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => { /* 运营噪声留盘即可 */ });
  // 等 ready 行（stdio 协议）
  let ready = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SMTC 源夹具 ready 超时（5s）')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (String(d).includes('"ready"')) { ready = true; clearTimeout(timer); resolve(); }
    });
    child.on('exit', (c) => { if (!ready) { clearTimeout(timer); reject(new Error(`SMTC 源夹具早退（code=${c}）`)); } });
  });
  const stop = async () => {
    try { child.stdin.write('stop\n'); } catch { /* 可能已退 */ }
    await new Promise((r) => setTimeout(r, 1200));
    try {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve());
      });
    } catch { /* 进程可能已退 */ }
    for (const f of [wavPath, artPath]) {
      try { fs.rmSync(f, { force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* 尽力 */ }
    }
  };
  return { pid: child.pid, stop, wavPath, artPath };
}

module.exports = { startMediaFixture };
