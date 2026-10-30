// t329 Electron 44 identity + bridge experiment (main process).
// Opens a small window playing quiet audio (Chromium media session -> SMTC),
// watches GSMTC via bridge.exe child, records the Electron session identity,
// exercises pause/play on it, writes results, exits.
// Usage: npx electron probe.mjs <out.json> [aumid]
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outJson = process.argv[2] || path.join(here, "..", "out", "electron-identity.json");
const aumidArg = process.argv[3] || null;
const enableFeatures = process.argv[4] || null;
if (enableFeatures) {
  app.commandLine.appendSwitch("enable-features", enableFeatures);
  console.log("enable-features =", enableFeatures);
}

const bridge = spawn(path.join(here, "..", "bridge", "bridge.exe"), [], { stdio: ["pipe", "pipe", "pipe"] });
const transcript = [];
let buf = "";
bridge.stdout.setEncoding("utf8");
bridge.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { transcript.push(JSON.parse(line)); } catch {}
  }
});
const send = (o) => bridge.stdin.write(JSON.stringify(o) + "\n");

const results = {
  electronVersions: process.versions.electron,
  isPackaged: app.isPackaged,
  defaultAumidReported: app.getName(),
  appliedAumid: aumidArg,
  executableName: path.basename(process.execPath),
  execPath: process.execPath,
};

app.whenReady().then(async () => {
  if (aumidArg) app.setAppUserModelId(aumidArg);
  const win = new BrowserWindow({ width: 320, height: 200, show: true, title: "t329 electron smtc probe" });
  await win.loadURL("http://127.0.0.1:8329/electron-page.html");

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // media-state diagnostics: is the <audio> element actually advancing?
  results.mediaState = [];
  for (let i = 0; i < 5; i++) {
    await wait(1000);
    try {
      const st = await win.webContents.executeJavaScript("({paused:document.getElementById('a').paused, t:document.getElementById('a').currentTime.toFixed(2), vol:document.getElementById('a').volume})");
      results.mediaState.push(st);
    } catch (e) { results.mediaState.push({ err: String(e).slice(0, 100) }); }
  }
  results.smtcMeta = await win.webContents.executeJavaScript("navigator.mediaSession.metadata ? navigator.mediaSession.metadata.title : null");

  send({ id: "1", cmd: "list" });
  await wait(1200);
  const list = transcript.find((m) => m.type === "result" && m.id === "1");
  results.sessions = list && list.data;

  // find the Electron-originated session: anything not MSEdge
  const mine = (list && list.data && list.data.sessions || []).find((s) => !/edge/i.test(s.aumid)) || null;
  results.electronSessionAumid = mine && mine.aumid;

  if (mine) {
    send({ id: "2", cmd: "snap", key: mine.key });
    send({ id: "3", cmd: "thumb", key: mine.key });
    send({ id: "4", cmd: "control", key: mine.key, action: "pause" });
    await wait(1500);
    send({ id: "5", cmd: "control", key: mine.key, action: "play" });
    await wait(1500);
    results.snap = transcript.find((m) => m.type === "result" && m.id === "2");
    results.thumb = transcript.find((m) => m.type === "result" && m.id === "3");
    results.pause = transcript.find((m) => m.type === "result" && m.id === "4");
    results.play = transcript.find((m) => m.type === "result" && m.id === "5");
    // restore quiet
    send({ id: "6", cmd: "control", key: mine.key, action: "pause" });
    await wait(600);
  }

  writeFileSync(outJson, JSON.stringify({ results, transcript }, null, 1));
  console.log("t329 electron probe done:", JSON.stringify(results.sessions));
  app.exit(0);
});
