'use strict';
/**
 * 管理型会话验收观察口（工单333，--accept-chat + DECK_MANAGED_PROBE=1 门控；taskbar-burst
 * 同款 accept 树先例）：本地回环内存 HTTP 端点，把在册会话凭证向电池控制器转交——
 * 驱动「旧 bearer 复用被拒 401」「投影外未知工具」「宿主回收」三条真机断言。
 *
 * 红线对账：凭证本体**绝不落盘**——本端点仅在面板进程内存里应答，无文件、无日志、
 * 无事件档痕迹；端口号（非凭证）写 evidence/*.json 供控制器寻址，轮末电池自删。
 * 生产装配不启用（门控双条件缺一即无端点）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const EVIDENCE_PORT_FILE = path.join(__dirname, '..', 'evidence', '333-managed-probe-port.json');

/**
 * 起观察口：GET /bearer?sessionId=<id> → { bearer } | { bearer: null }。
 * 返回 { port, close() }；close 负责清端口文件与关监听（轮末清场）。
 */
function startManagedProbe(registry, log) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/bearer') { res.writeHead(404).end(); return; }
    const sessionId = String(url.searchParams.get('sessionId') ?? '');
    const bearer = registry.bearerOf(sessionId);
    const body = JSON.stringify({ bearer: bearer ?? null });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      try {
        fs.writeFileSync(EVIDENCE_PORT_FILE, JSON.stringify({ port }), 'utf8');
      } catch (err) {
        log?.append({ type: 'managed-probe-port-file-failed', message: err instanceof Error ? err.message : String(err) });
      }
      log?.append({ type: 'managed-probe-started', port });
      resolve({
        port,
        close: () => new Promise((done) => {
          try { fs.rmSync(EVIDENCE_PORT_FILE, { force: true }); } catch { /* 尽力 */ }
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { startManagedProbe, EVIDENCE_PORT_FILE };
