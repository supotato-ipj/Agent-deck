// t329 negative cases: session exits mid-watch, and no-player state.
// Usage: node run-exit-test.mjs <bridge.exe> <edge-root-pid> <out.json>
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const bridgeExe = process.argv[2];
const edgePid = process.argv[3];
const outFile = process.argv[4] || "out/exit-test.json";

const transcript = [];
const child = spawn(bridgeExe, [], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const events = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    transcript.push(m);
    if (m.type === "event") events.push(m);
  }
});
const t0 = Date.now();
let readyReqMs = null;
await new Promise((resolve) => {
  const on = (d) => {
    buf += d;
    if (buf.includes('"type":"ready"')) { child.stdout.removeListener("data", on); resolve(); }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", on);
});
const readyLine = transcript.find((m) => m.type === "ready");
readyReqMs = readyLine && readyLine.requestMs;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

// watch on
send({ id: "w", cmd: "watch", on: true });
await new Promise((r) => setTimeout(r, 700));

// kill Edge tree mid-session
const killAt = Date.now();
try { execSync(`taskkill /PID ${edgePid} /T /F`, { stdio: "pipe" }); } catch (e) { console.log("taskkill rc!=0 (maybe already gone)"); }

// wait for session-removed (up to 10s)
let removed = null;
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  const m = events.find((e) => e.event === "session-removed");
  if (m) { removed = { ...m, killToEventMs: Math.round(((m.ts - transcript[0].ts) - 0) * 1) }; break; }
  await new Promise((r) => setTimeout(r, 100));
}
// list after exit (no-player state)
send({ id: "l", cmd: "list" });
await new Promise((r) => setTimeout(r, 800));
const listLine = transcript.find((m) => m.type === "result" && m.id === "l");

const rel = (m) => Math.round(m.ts - transcript[0].ts);
console.log("ready requestMs:", readyReqMs);
console.log("edge killed at ~", killAt - t0, "ms");
console.log("session-removed event:", removed ? `at +${rel(removed)}ms after bridge start` : "NOT OBSERVED");
console.log("post-exit list:", JSON.stringify(listLine && listLine.data));
console.log("event log:", events.map((e) => `${rel(e)}ms ${e.event}${e.key ? ":" + e.key : ""}${e.what ? ":" + e.what : ""}`).join("\n  "));

writeFileSync(outFile, JSON.stringify({ readyReqMs, killAtRel: killAt - t0, removed: removed && rel(removed), postExitList: listLine && listLine.data, events, transcript }, null, 1));
child.kill();
process.exit(0);
