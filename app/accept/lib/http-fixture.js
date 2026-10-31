'use strict';
/**
 * 工单338 C8 联网夹具：两台本地 HTTP 服务（127.0.0.1 随机端口），**无公网依赖**。
 *
 * - 主 origin（= manifest 声明并获批的那个）：
 *     /data.json  200 application/json（组件真取来上卡的数据）
 *     /redirect   302 → 另一台 origin 的 /secret（跨 origin 重定向：必须不自动跟随）
 *     /big        4KB text/plain（有界响应面备用）
 * - 另一台 origin（**未授权**）：
 *     /secret     200 text/plain（未授权 origin 默认拒绝；重定向目标也在这里）
 *
 * 进程内服务，测完 stop() 全部关停；不落盘、不出声。
 */
const http = require('node:http');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function startHttpFixture() {
  let otherOrigin = '';
  let hits = 0;

  const main = http.createServer((req, res) => {
    const pathname = String(req.url || '/').split('?')[0];
    hits += 1;
    if (pathname === '/data.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ hello: 'deck-net-fixture', value: 42 }));
      return;
    }
    if (pathname === '/redirect') {
      res.writeHead(302, { location: `${otherOrigin}/secret` });
      res.end();
      return;
    }
    if (pathname === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(4096));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const other = http.createServer((req, res) => {
    const pathname = String(req.url || '/').split('?')[0];
    hits += 1;
    if (pathname === '/secret') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('TOP-SECRET-PAYLOAD');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const origin = await listen(main);
  otherOrigin = await listen(other);
  const sockets = new Set();
  for (const s of [main, other]) s.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });

  return {
    origin,
    otherOrigin,
    hits: () => hits,
    stop: () => new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch { /* 尽力 */ } }
      let left = 2;
      const done = () => { if (--left === 0) resolve(); };
      main.close(done);
      other.close(done);
    }),
  };
}

module.exports = { startHttpFixture };
