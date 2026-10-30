// Generates test media assets for the GSMTC probe (t329):
// - quiet.wav: 40s, 22050 Hz mono 16-bit PCM sine @ 440Hz, amplitude 0.03 (quiet)
// - art.png: 256x256 RGBA pattern (pure Node, zlib-based PNG writer)
// - page.html: served over http://localhost, autoplays audio quietly and
//   sets navigator.mediaSession metadata with artwork so Edge exposes a thumbnail.
// Usage: node generate-media.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- quiet.wav ----------
const sampleRate = 22050;
const seconds = 40;
const amplitude = 0.03; // quiet on purpose
const freq = 440;
const numSamples = sampleRate * seconds;
const dataSize = numSamples * 2; // 16-bit mono
const buf = Buffer.alloc(44 + dataSize);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataSize, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
buf.writeUInt16LE(2, 32); // block align
buf.writeUInt16LE(16, 34); // bits
buf.write("data", 36);
buf.writeUInt32LE(dataSize, 40);
for (let i = 0; i < numSamples; i++) {
  const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * 32767);
  buf.writeInt16LE(v, 44 + i * 2);
}
writeFileSync(path.join(dir, "quiet.wav"), buf);
console.log("quiet.wav", (44 + dataSize), "bytes,", seconds, "s");

// ---------- art.png (minimal PNG encoder) ----------
const W = 256, H = 256;
function crc32(data) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter none
  for (let x = 0; x < W; x++) {
    const o = y * (1 + W * 4) + 1 + x * 4;
    raw[o] = 30 + Math.floor((x / W) * 120);       // R gradient
    raw[o + 1] = 60 + Math.floor((y / H) * 140);   // G gradient
    raw[o + 2] = 200;                              // B
    raw[o + 3] = 255;
  }
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(path.join(dir, "art.png"), png);
console.log("art.png", png.length, "bytes,", W + "x" + H);

// ---------- page.html ----------
const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>t329 probe media</title></head>
<body style="background:#222;color:#eee;font-family:sans-serif">
  <h3>t329 GSMTC probe session</h3>
  <audio id="a" src="/quiet.wav" autoplay loop></audio>
  <p>state: <span id="s">?</span></p>
  <script>
    const a = document.getElementById('a');
    a.volume = 0.05; // quiet
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 't329 Probe Track',
        artist: 'GSMTC Probe Artist',
        album: 't329 Probe Album',
        artwork: [ { src: '/art.png', sizes: '256x256', type: 'image/png' } ],
      });
      navigator.mediaSession.setActionHandler('play', () => a.play());
      navigator.mediaSession.setActionHandler('pause', () => a.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => { a.currentTime = 0; });
      navigator.mediaSession.setActionHandler('nexttrack', () => { a.currentTime = 0; });
    }
    setInterval(() => { document.getElementById('s').textContent =
      a.paused ? 'paused' : (a.currentTime.toFixed(1) + 's'); }, 200);
  </script>
</body></html>`;
writeFileSync(path.join(dir, "page.html"), page);
console.log("page.html written");
