// t329 bridge driver: exercises list/snap/thumb/control/watch against bridge.exe.
// Usage: node run-bridge.mjs <path-to-bridge.exe> <out-json> [--full]
// Prints a compact summary; full raw JSONL transcript goes to <out-json>.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const bridgeExe = process.argv[2];
const outFile = process.argv[3] || "out/bridge-run.json";
const full = process.argv.includes("--full");

const transcript = [];
const child = spawn(bridgeExe, [], { stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
const pending = new Map();
const eventWaiters = [];
let readyResolve;
let readyInfo;

child.stdout.setEncoding("utf8");
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { transcript.push({ bad: line }); continue; }
    transcript.push(msg);
    if (msg.type === "ready") { readyInfo = msg; readyResolve(msg); }
    else if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    } else if (msg.type === "event") {
      for (let k = eventWaiters.length - 1; k >= 0; k--) {
        if (eventWaiters[k].match(msg)) { eventWaiters[k].resolve(msg); eventWaiters.splice(k, 1); break; }
      }
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write("[bridge-stderr] " + d));
const t0 = Date.now();
const cmd = (payload) =>
  new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("timeout cmd " + payload.cmd)); } }, 15000);
  });
const waitEvent = (match, ms = 6000) =>
  new Promise((resolve, reject) => {
    eventWaiters.push({ match, resolve });
    setTimeout(() => reject(new Error("timeout waiting event")), ms);
  });

await new Promise((r) => readyResolve = r);
console.log("ready in", Date.now() - t0, "ms, requestMs:", readyInfo.requestMs);

const summary = { readyRequestMs: readyInfo.requestMs };

// 1) list (all sessions)
const list = await cmd({ cmd: "list" });
summary.list = list.data;
console.log("list count:", list.data.count, JSON.stringify(list.data.sessions));

// 2) pick target: prefer a Playing session
const target = (list.data.sessions || []).find((s) => s.status === "Playing") || (list.data.sessions || [])[0];
if (!target) { console.log("NO SESSION — finishing (negative case evidence)"); }
summary.targetKey = target && target.key;

if (target) {
  // 3) full snap
  const snap = await cmd({ cmd: "snap", key: target.key });
  summary.snap = snap.data;
  console.log("snap media:", snap.data.media.title, "/", snap.data.media.artist, "/ album:", JSON.stringify(snap.data.media.albumTitle));
  console.log("snap timeline: pos", snap.data.timeline.positionMs.toFixed(1), "end", snap.data.timeline.endTimeMs.toFixed(1), "updated", snap.data.timeline.lastUpdatedTime);

  // 4) thumbnail bytes
  const thumb = await cmd({ cmd: "thumb", key: target.key });
  summary.thumb = thumb.data;
  if (thumb.ok && thumb.data && thumb.data.present) {
    console.log("thumb: contentType", thumb.data.contentType, "bytes", thumb.data.readBytes, "in", thumb.data.ms, "ms head", thumb.data.headHex);
    writeFileSync(resolve(process.cwd(), "out", "thumb-latest.bin"), Buffer.from(thumb.data.bytesBase64, "base64"));
  } else {
    console.log("thumb: no thumbnail present (or error)", JSON.stringify(thumb.data || thumb.error).slice(0, 200));
  }

  // 5) watch + control with event latency correlation
  await cmd({ cmd: "watch", on: true });
  const evSince = [];
  const evTap = (msg) => evSince.push({ t: Date.now(), msg });
  // passive collector via wrapping waitEvent usage below

  // pause (expected allowed: status Playing -> Paused)
  const pause = await cmd({ cmd: "control", key: target.key, action: "pause" });
  summary.pause = pause.data;
  let pauseEvMs = null;
  try {
    const ev = await waitEvent((m) => m.event === "session-updated" && m.key === target.key);
    pauseEvMs = Date.now() - (Date.now() - (ev.ts - (pause.data && pause.data.elapsedMs || 0))); // rough
    pauseEvMs = ev.ts - ((pause.ts || 0) - (pause.data && pause.data.elapsedMs || 0));
  } catch { pauseEvMs = null; }
  console.log("pause:", JSON.stringify(pause.data), "playback-event delta ms:", pauseEvMs);

  // play again (expected allowed: Paused -> Playing)
  await new Promise((r) => setTimeout(r, 400));
  const play = await cmd({ cmd: "control", key: target.key, action: "play" });
  summary.play = play.data;
  try { await waitEvent((m) => m.event === "session-updated" && m.key === target.key); } catch {}
  console.log("play:", JSON.stringify(play.data));

  // unsupported-command honesty: play while Playing (capability play=false now)
  await new Promise((r) => setTimeout(r, 400));
  const playAgain = await cmd({ cmd: "control", key: target.key, action: "play" });
  summary.playAgainWhilePlaying = playAgain.data;
  console.log("play-while-playing (should be refused by caps):", JSON.stringify(playAgain.data));

  // next/previous (page handler resets position to 0; observable via timeline)
  const before = await cmd({ cmd: "snap", key: target.key });
  const prevPos = before.data.timeline.positionMs;
  const next = await cmd({ cmd: "control", key: target.key, action: "next" });
  summary.next = next.data;
  await new Promise((r) => setTimeout(r, 700));
  const after = await cmd({ cmd: "snap", key: target.key });
  const afterPos = after.data.timeline.positionMs;
  summary.nextPositionJump = { beforeMs: prevPos, afterMs: afterPos };
  console.log("next:", JSON.stringify(next.data), "position", prevPos.toFixed(1), "->", afterPos.toFixed(1));

  const prev = await cmd({ cmd: "control", key: target.key, action: "previous" });
  summary.previous = prev.data;
  console.log("previous:", JSON.stringify(prev.data));
}

// 6) events already observed above; transcript has them all.

// restore state: make sure it ends paused (克制)
if (target) {
  try { await cmd({ cmd: "control", key: target.key, action: "pause" }); } catch {}
}

writeFileSync(outFile, JSON.stringify({ summary, transcript }, null, 1));
console.log("transcript lines:", transcript.length, "->", outFile);
child.kill();
process.exit(0);
