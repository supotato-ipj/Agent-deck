'use strict';
/**
 * 罐头 OpenAI 兼容 SSE LLM（工单332 真机验收段专用测试资产，配方源自工单330 探针
 * spec326-notes/t330-dsh-acp/mock-llm.mjs 的 CJS 移植收窄）：真实 DSH agent 回环
 * （工具调用、沙箱升级审批、取消、流式）在零用户凭证下确定性驱动。
 *
 * 行为按最后一条用户消息里的标记脚本化（扫描从尾向前、剥 system-reminder，探针原语义）：
 *   'PROBE OK'      → 文本 'PROBE OK'（两段流式）
 *   'Count slowly'  → 慢速流式（20 词 × 500ms，给取消留时间）
 *   'outside marker'→ 第一轮：workspace 外 write（沙箱拒绝）→ 第二轮：带
 *                     sandbox_permissions:'danger-full-access' + justification 的升级写
 *                     （触发 session/request_permission）→ 允许后落盘并回最终文本
 * 其余 → 'OK (fallback)'。
 *
 * 认证边界（ADR-0018「认证不归面板管」）：服务校验 Authorization 头存在即可（任意串），
 * 不持任何真实凭证；面板侧 provider 路由经 DSH profile patch 的 apiKeyEnv 引用环境变量。
 */

const { createServer } = require('node:http');

async function startCannedLlm({ port = 0, outsideFilePath } = {}) {
  const state = { requests: [] };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
      const record = {
        t: new Date().toISOString(),
        model: body.model,
        stream: body.stream,
        authPresent: Boolean(req.headers.authorization),
      };
      state.requests.push(record);

      // 从尾向前找带已知标记的用户消息（DSH 会把一轮输入拆成多条 user 消息，真实文本在前）
      const users = (body.messages || []).filter((m) => m.role === 'user');
      const MARKERS = ['PROBE OK', 'Count slowly', 'outside marker', 'MANAGED SNAPSHOT', 'MANAGED CATALOG', 'MANAGED INSTALL', 'MANAGED UPDATE', 'MANAGED NOCHANGE', 'MANAGED UNINSTALL', 'MANAGED MEDIA', 'MANAGED NET'];
      let cleanLastUser = '';
      for (let i = users.length - 1; i >= 0; i--) {
        const c = typeof users[i].content === 'string' ? users[i].content : JSON.stringify(users[i].content);
        const cleaned = c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
        if (MARKERS.some((mk) => cleaned.includes(mk))) { cleanLastUser = cleaned; break; }
      }
      const marker = (s) => cleanLastUser.includes(s);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const cid = 'chatcmpl-deck332-' + state.requests.length;
      const chunk = (delta, finish = null) => {
        res.write(`data: ${JSON.stringify({
          id: cid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: body.model || 'probe-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
      };
      const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

      // 本 turn（最后一条带标记的用户消息之后）的裁决：有没有 tool 结果、最后一次升级与否
      const msgsAll = body.messages || [];
      let markerIdx = -1;
      for (let i = msgsAll.length - 1; i >= 0; i--) {
        const m = msgsAll[i];
        if (m.role !== 'user') continue;
        const c = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
        if (MARKERS.some((mk) => c.includes(mk))) { markerIdx = i; break; }
      }
      const msgs = markerIdx >= 0 ? msgsAll.slice(markerIdx + 1) : msgsAll;
      const turnTool = [...msgs].reverse().find((m) => m.role === 'tool');
      const toolText = turnTool ? (typeof turnTool.content === 'string' ? turnTool.content : JSON.stringify(turnTool.content ?? '')) : '';

      let plan;
      if (marker('outside marker')) {
        const denied = /sandbox|denied|escalat/i.test(toolText);
        let alreadyEscalated = false;
        const lastToolIdx = (() => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'tool') return i; return -1; })();
        for (let i = lastToolIdx - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') { alreadyEscalated = JSON.stringify(msgs[i].tool_calls || '').includes('sandbox_permissions'); break; }
        }
        if (!turnTool) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: outsideFilePath, content: 'written by deck-332 accept OUTSIDE workspace' }) };
        } else if (denied && !alreadyEscalated) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: outsideFilePath, content: 'written by deck-332 accept OUTSIDE workspace', sandbox_permissions: 'danger-full-access', justification: 'deck-332 accept: verify request_permission reaches the conversation window' }) };
        } else if (denied) {
          plan = { kind: 'text', out: 'OUTSIDE_WRITE_DENIED_AFTER_ESCALATION (tool said: ' + toolText.slice(0, 140) + ')' };
        } else {
          plan = { kind: 'text', out: 'OUTSIDE_WRITE_DONE tool said: ' + toolText.slice(0, 140) };
        }
      } else if (marker('Count slowly')) {
        plan = { kind: 'slow', out: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty' };
      } else if (marker('MANAGED SNAPSHOT') || marker('MANAGED CATALOG')) {
        // 工单333：管理型只读工具真机链——第一轮调注入 MCP 的只读工具（名从 body.tools
        // 实测清单里找，不硬编码 mcp 服务名），第二轮把工具结果原样回显进最终文本
        const want = marker('MANAGED SNAPSHOT') ? 'panel_snapshot' : 'plugin_contract_catalog';
        if (!turnTool) {
          const mcpTool = (body.tools || []).map((t) => t.function && t.function.name).find((n) => typeof n === 'string' && n.includes(want));
          plan = mcpTool
            ? { kind: 'tool', name: mcpTool, args: JSON.stringify({}) }
            : { kind: 'text', out: 'MCP-TOOL-MISSING:' + want + ' (tools=' + JSON.stringify((body.tools || []).map((t) => t.function && t.function.name)) + ')' };
        } else {
          const echoTag = want === 'panel_snapshot' ? 'SNAPSHOT-TOOL-RESULT:' : 'CATALOG-TOOL-RESULT:';
          plan = { kind: 'text', out: echoTag + toolText.slice(0, 200) };
        }
      } else if (marker('MANAGED INSTALL')) {
        // 工单334 安装全链真机编排：包文件由 DSH 自身文件工具落盘（workspace 内写不触发审批），
        // 然后调 MCP plugin_install_submit 提交（prompt 里 PKGDIR=<abs> 由电池按会话 cwd 填）。
        // 轮次状态机按工具消息数走：0=写 plugin.json；1=写 card.js；2=提交；≥3=回显结果。
        // PKGDIR 从 marker 所在的用户消息取（cleanLastUser）——DSH 会把一轮输入拆成多条
        // user 消息，msgs 末尾的 user 未必是带 PKGDIR 的那条（2026-10-31 真机轮 2 实证）
        const um = cleanLastUser;
        // PKGDIR 在行尾整行捕获（路径含空格——\S+ 会在 'An W' 处截断，真机轮 3 实证）
        const pkgDir = ((um.match(/PKGDIR=(.+)/) || [])[1] || '').trim();
        // 拒绝路径用不同包 id（同 id 二次提交撞用户根在册 id → id_conflict，测不到拒绝）
        const pkgId = ((um.match(/PKGID=(\S+)/) || [])[1] || 'dsh-hello').trim();
        // BADMANIFEST 变体（工单334 坏包路径）：非法 JSON → 提交得 invalid_package 结构化错误
        const manifest = um.includes('BADMANIFEST') ? '{ "id": not json' : JSON.stringify({ id: pkgId, name: 'DSH HELLO', version: '1.0.0', entry: './card.js', hostApiVersion: 1, capabilities: ['clock'], permissions: [] }, null, 2);
        const cardJs = 'export default { mount(host) { host.el.textContent = "hello from dsh" } }\n';
        const toolCount = msgs.filter((m) => m.role === 'tool').length;
        if (!pkgDir) {
          plan = { kind: 'text', out: 'INSTALL-MISSING-PKGDIR' };
        } else if (toolCount === 0) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/plugin.json', content: manifest }) };
        } else if (toolCount === 1) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/card.js', content: cardJs }) };
        } else if (toolCount === 2) {
          const mcpTool = (body.tools || []).map((x) => x.function && x.function.name).find((n) => typeof n === 'string' && n.includes('plugin_install_submit'));
          plan = mcpTool
            ? { kind: 'tool', name: mcpTool, args: JSON.stringify({ sourceDir: pkgDir }) }
            : { kind: 'text', out: 'INSTALL-SUBMIT-MISSING (tools=' + JSON.stringify((body.tools || []).map((x) => x.function && x.function.name)) + ')' };
        } else {
          plan = { kind: 'text', out: 'INSTALL-SUBMITTED:' + toolText.slice(0, 260) };
        }
      } else if (marker('MANAGED UPDATE') || marker('MANAGED NOCHANGE')) {
        // 工单335 更新全链真机编排（与 MANAGED INSTALL 同族状态机）：
        // UPDATE：0=写 plugin.json（version 1.1.0）；1=写 card.js（v2 文本）；2=MCP
        //   plugin_update_submit{packageId,sourceDir}；≥3=回显结果（提案 pending 带 diff）。
        // NOCHANGE：同字节直提（上一轮 UPDATE 落盘的包目录已批准进用户根，字节完全一致）
        //   → 工具结果如实 no_change（不重载、不制造提案）。
        const um = cleanLastUser;
        const pkgDir = ((um.match(/PKGDIR=(.+)/) || [])[1] || '').trim();
        const pkgId = ((um.match(/PKGID=(\S+)/) || [])[1] || 'dsh-hello').trim();
        const nochange = marker('MANAGED NOCHANGE');
        const toolCountU = msgs.filter((m) => m.role === 'tool').length;
        const findMcpTool = (needle) => (body.tools || []).map((x) => x.function && x.function.name).find((n) => typeof n === 'string' && n.includes(needle));
        if (!pkgDir) {
          plan = { kind: 'text', out: 'UPDATE-MISSING-PKGDIR' };
        } else if (nochange) {
          if (toolCountU === 0) {
            const mcpTool = findMcpTool('plugin_update_submit');
            plan = mcpTool
              ? { kind: 'tool', name: mcpTool, args: JSON.stringify({ packageId: pkgId, sourceDir: pkgDir }) }
              : { kind: 'text', out: 'UPDATE-SUBMIT-MISSING (tools=' + JSON.stringify((body.tools || []).map((x) => x.function && x.function.name)) + ')' };
          } else {
            plan = { kind: 'text', out: 'UPDATE-SUBMITTED:' + toolText.slice(0, 260) };
          }
        } else if (toolCountU === 0) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/plugin.json', content: JSON.stringify({ id: pkgId, name: 'DSH HELLO', version: '1.1.0', entry: './card.js', hostApiVersion: 1, capabilities: ['clock'], permissions: [] }, null, 2) }) };
        } else if (toolCountU === 1) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/card.js', content: 'export default { mount(host) { host.el.textContent = "hello from dsh v2" } }\n' }) };
        } else if (toolCountU === 2) {
          const mcpTool = findMcpTool('plugin_update_submit');
          plan = mcpTool
            ? { kind: 'tool', name: mcpTool, args: JSON.stringify({ packageId: pkgId, sourceDir: pkgDir }) }
            : { kind: 'text', out: 'UPDATE-SUBMIT-MISSING (tools=' + JSON.stringify((body.tools || []).map((x) => x.function && x.function.name)) + ')' };
        } else {
          plan = { kind: 'text', out: 'UPDATE-SUBMITTED:' + toolText.slice(0, 260) };
        }
      } else if (marker('MANAGED UNINSTALL')) {
        // 工单335 卸载真机编排：0=MCP plugin_uninstall{packageId}；≥1=回显结果（回收站路径）
        const pkgIdU = ((cleanLastUser.match(/PKGID=(\S+)/) || [])[1] || 'dsh-hello').trim();
        if (!turnTool) {
          const mcpTool = (body.tools || []).map((x) => x.function && x.function.name).find((n) => typeof n === 'string' && n.includes('plugin_uninstall'));
          plan = mcpTool
            ? { kind: 'tool', name: mcpTool, args: JSON.stringify({ packageId: pkgIdU }) }
            : { kind: 'text', out: 'UNINSTALL-MISSING (tools=' + JSON.stringify((body.tools || []).map((x) => x.function && x.function.name)) + ')' };
        } else {
          plan = { kind: 'text', out: 'UNINSTALL-DONE:' + toolText.slice(0, 200) };
        }
      } else if (marker('MANAGED MEDIA')) {
        // 工单336 媒体卡全链真机编排（与 MANAGED INSTALL 同族状态机，首个敏感权限闭环）：
        // 0=写 plugin.json（permissions=['media.read'] + capabilities=['media']——敏感通路提交）；
        // 1=写 card.js（媒体信息卡：view.media 脱敏快照渲染 + deckHost.media.thumbnail 受控缩略图
        //   + 无会话/不可用明确态）；2=MCP plugin_install_submit{sourceDir}；≥3=回显结果。
        // PKGDIR/PKGID 语义同族（PKGDIR 行尾整行——路径含空格）。
        const um = cleanLastUser;
        const pkgDir = ((um.match(/PKGDIR=(.+)/) || [])[1] || '').trim();
        const pkgId = ((um.match(/PKGID=(\S+)/) || [])[1] || 'dsh-media').trim();
        const toolCountM = msgs.filter((m) => m.role === 'tool').length;
        // 卡片源码行（外层 JS 串内 \" = 卡源里的双引号 HTML 属性；卡源 JS 一律单引号串）
        const cardLines = [
          "const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))",
          "const fmt = (ms) => { if (!Number.isFinite(ms) || ms < 0) ms = 0; const sec = Math.floor(ms / 1000); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') }",
          "const thumbCache = {}",
          "function pick(media) {",
          "  if (!media || media.available === false) return { state: 'unavailable' }",
          "  if (!media.sessions || media.sessions.length === 0) return { state: 'empty' }",
          "  const sel = media.selectedKey ? media.sessions.find((x) => x.key === media.selectedKey) : null",
          "  return { state: 'live', s: sel || media.sessions[0] }",
          "}",
          "function applyThumb(el, out) {",
          "  if (!el) return",
          "  if (out && out.ok && out.dataUrl) el.innerHTML = '<img class=\"media-thumb-img\" src=\"' + out.dataUrl + '\" />'",
          "  else if (el) el.textContent = '缩略图不可用'",
          "}",
          "async function fetchThumb(key, el) {",
          "  if (thumbCache[key] === undefined) {",
          "    try { thumbCache[key] = await window.deckHost.media.thumbnail(key) } catch (err) { thumbCache[key] = { ok: false, code: 'thumbnail_error' } }",
          "  }",
          "  applyThumb(el, thumbCache[key])",
          "}",
          "function rowHtml(s, selectedKey, controlGranted) {",
          "  const tl = s.timeline || {}",
          "  const pos = Math.min(Math.max((tl.positionMs || 0) + (Date.now() - (tl.lastUpdatedTimeMs || Date.now())), 0), tl.endTimeMs || 0)",
          "  return '<div class=\"media-session' + (s.key === selectedKey ? ' media-selected' : '') + '\" data-key=\"' + esc(s.key) + '\">' +",
          "    '<span class=\"media-title\">' + esc((s.media && s.media.title) || '（无曲名）') + '</span>' +",
          "    '<span class=\"media-artist\">' + esc((s.media && s.media.artist) || '') + '</span>' +",
          "    '<span class=\"media-status\">' + esc(s.status) + '</span>' +",
          "    '<span class=\"media-position\">' + fmt(pos) + ' / ' + fmt(tl.endTimeMs || 0) + '</span>' +",
          "    '<div class=\"media-thumb\">…</div>' +",
          "    (controlGranted ? '<button class=\"media-control-btn\" data-act=\"pause\" data-key=\"' + esc(s.key) + '\">暂停</button>' +",
          "      '<button class=\"media-control-btn\" data-act=\"play\" data-key=\"' + esc(s.key) + '\">播放</button>' : '') +",
          "    '</div>'",
          "}",
          "export default {",
          "  mount(host) {",
          "    this._root = document.createElement('div')",
          "    this._root.className = 'media-card'",
          "    this._root.textContent = '媒体卡启动中'",
          "    host.el.textContent = ''",
          "    host.el.appendChild(this._root)",
          "    window.__mediaCardMounted = true",
          "    this.render(host.view)",
          "  },",
          "  update(host) { this.render(host.view) },",
          "  render(view) {",
          "    window.__mediaView = view && view.media ? { controlGranted: view.media.controlGranted, n: (view.media.sessions || []).length, keys: (view.media.sessions || []).map((x) => x.key) } : null",
          "    const root = this._root",
          "    const media = view && view.media",
          "    if (!media || media.available === false) { root.className = 'media-card media-unavailable'; root.textContent = '媒体不可用'; return }",
          "    if (!media.sessions || media.sessions.length === 0) { root.className = 'media-card media-empty'; root.textContent = '没有正在播放的媒体'; return }",
          "    root.className = 'media-card media-live'",
          "    root.innerHTML = media.sessions.map((s) => rowHtml(s, media.selectedKey, media.controlGranted)).join('')",
          "    root.querySelectorAll('.media-session').forEach((el) => {",
          "      const s = media.sessions.find((x) => x.key === el.getAttribute('data-key'))",
          "      if (s && s.media && s.media.thumbPresent) void fetchThumb(s.key, el.querySelector('.media-thumb'))",
          "    })",
          "    root.querySelectorAll('.media-control-btn').forEach((btn) => {",
          "      btn.addEventListener('click', () => {",
          "        void window.deckHost.media.control(btn.getAttribute('data-key'), btn.getAttribute('data-act'))",
          "      })",
          "    })",
          "  },",
          "}",
        ];
        const cardJs = cardLines.join('\n') + '\n';
        // WITHCONTROL 变体（工单337）：media.control 作为可选权限声明（批准面逐项授权）
        const manifestM = JSON.stringify(Object.assign({ id: pkgId, name: 'DSH MEDIA', version: '1.0.0', entry: './card.js', hostApiVersion: 1, capabilities: ['media'], permissions: ['media.read'] }, um.includes('WITHCONTROL') ? { optionalPermissions: ['media.control'] } : {}), null, 2);
        if (!pkgDir) {
          plan = { kind: 'text', out: 'MEDIA-MISSING-PKGDIR' };
        } else if (toolCountM === 0) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/plugin.json', content: manifestM }) };
        } else if (toolCountM === 1) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/card.js', content: cardJs }) };
        } else if (toolCountM === 2) {
          const mcpTool = (body.tools || []).map((x) => x.function && x.function.name).find((n) => typeof n === 'string' && n.includes('plugin_install_submit'));
          plan = mcpTool
            ? { kind: 'tool', name: mcpTool, args: JSON.stringify({ sourceDir: pkgDir }) }
            : { kind: 'text', out: 'MEDIA-SUBMIT-MISSING (tools=' + JSON.stringify((body.tools || []).map((x) => x.function && x.function.name)) + ')' };
        } else {
          plan = { kind: 'text', out: 'MEDIA-SUBMITTED:' + toolText.slice(0, 260) };
        }
      } else if (marker('MANAGED NET')) {
        // 工单338 联网组件全链真机编排（与 MANAGED MEDIA 同族状态机）：
        // 0=写 plugin.json（permissions=['network.request'] + networkOrigins=[ORIGIN]）；
        // 1=写 card.js（联网卡：包页直连必须被 CSP 拦 → 经 deckHost.network.request 取
        //   授权 origin 数据上卡 → 未授权 origin 拒绝 → 跨 origin 重定向被拒）；
        // 2=MCP plugin_install_submit{sourceDir}；≥3=回显结果。
        // PKGDIR/PKGID/ORIGIN/OTHERORIGIN 行尾整行（PKGDIR 路径含空格）。
        const um = cleanLastUser;
        const pkgDir = ((um.match(/PKGDIR=(.+)/) || [])[1] || '').trim();
        const pkgId = ((um.match(/PKGID=(\S+)/) || [])[1] || 'dsh-net').trim();
        const origin = ((um.match(/ORIGIN=(\S+)/) || [])[1] || '').trim();
        const otherOrigin = ((um.match(/OTHERORIGIN=(\S+)/) || [])[1] || '').trim();
        const toolCountN = msgs.filter((m) => m.role === 'tool').length;
        // 卡片源码行：lib 侧用双引号串，卡源一律单引号串（同上族约定，避免转义互踩）
        const cardLines = [
          "const ORIGIN = " + JSON.stringify(origin),
          "const OTHER = " + JSON.stringify(otherOrigin),
          "const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))",
          "function summarize(r) {",
          "  if (!r) return '…'",
          "  if (r.ok) return 'ok http=' + r.status + ' ' + String(r.text || '').slice(0, 120)",
          "  return 'err ' + r.code + (r.location ? ' -> ' + r.location : '')",
          "}",
          "function rowHtml(cls, label, detail) {",
          "  return '<div class=\"net-row ' + cls + '\"><span class=\"net-label\">' + esc(label) + '</span><span class=\"net-detail\">' + esc(detail) + '</span></div>'",
          "}",
          "export default {",
          "  mount(host) {",
          "    this._root = document.createElement('div')",
          "    this._root.className = 'net-card'",
          "    this._root.textContent = '联网卡启动中'",
          "    host.el.textContent = ''",
          "    host.el.appendChild(this._root)",
          "    window.__netCardMounted = true",
          "    window.__netView = { allowed: null, denied: null, redirect: null, direct: null }",
          "    void this.run()",
          "  },",
          "  render() {",
          "    const v = window.__netView || {}",
          "    window.__netRendered = (window.__netRendered || 0) + 1",
          "    this._root.className = 'net-card net-live'",
          "    this._root.innerHTML = rowHtml('net-allowed', '授权 origin', summarize(v.allowed)) +",
          "      rowHtml('net-denied', '未授权 origin', summarize(v.denied)) +",
          "      rowHtml('net-redirect', '跨域重定向', summarize(v.redirect)) +",
          "      rowHtml('net-direct', '包页直连', v.direct === null ? '…' : String(v.direct))",
          "  },",
          "  async run() {",
          "    try {",
          "      const res = await fetch(ORIGIN + '/data.json')",
          "      window.__netView.direct = 'unexpected-fetch-ok:' + res.status",
          "    } catch (err) {",
          "      window.__netView.direct = 'blocked'",
          "    }",
          "    window.__netView.allowed = await window.deckHost.network.request({ url: ORIGIN + '/data.json' })",
          "    this.render()",
          "    window.__netView.denied = await window.deckHost.network.request({ url: OTHER + '/secret' })",
          "    this.render()",
          "    window.__netView.redirect = await window.deckHost.network.request({ url: ORIGIN + '/redirect' })",
          "    this.render()",
          "  },",
          "}",
        ];
        const cardJs = cardLines.join('\n') + '\n';
        const manifestN = JSON.stringify({ id: pkgId, name: 'DSH NET', version: '1.0.0', entry: './card.js', hostApiVersion: 1, capabilities: [], permissions: ['network.request'], networkOrigins: origin ? [origin] : [] }, null, 2);
        if (!pkgDir || !origin) {
          plan = { kind: 'text', out: 'NET-MISSING-PKGDIR-OR-ORIGIN' };
        } else if (toolCountN === 0) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/plugin.json', content: manifestN }) };
        } else if (toolCountN === 1) {
          plan = { kind: 'tool', name: 'write', args: JSON.stringify({ file_path: pkgDir + '/card.js', content: cardJs }) };
        } else if (toolCountN === 2) {
          const mcpTool = (body.tools || []).map((x) => x.function && x.function.name).find((n) => typeof n === 'string' && n.includes('plugin_install_submit'));
          plan = mcpTool
            ? { kind: 'tool', name: mcpTool, args: JSON.stringify({ sourceDir: pkgDir }) }
            : { kind: 'text', out: 'NET-SUBMIT-MISSING (tools=' + JSON.stringify((body.tools || []).map((x) => x.function && x.function.name)) + ')' };
        } else {
          plan = { kind: 'text', out: 'NET-SUBMITTED:' + toolText.slice(0, 260) };
        }
      } else if (marker('PROBE OK')) {
        plan = { kind: 'text', out: 'PROBE OK' };
      } else {
        plan = { kind: 'text', out: 'OK (fallback)' };
      }

      // 决策诊断（工单334 真机排障）：record 是同一对象引用，事后挂 diag 即随 requests() 出
      record.diag = {
        marker: MARKERS.find((mk) => cleanLastUser.includes(mk)) ?? null,
        planKind: plan.kind,
        planName: plan.name ?? null,
        toolCount: msgs.filter((m) => m.role === 'tool').length,
        out: (plan.out ?? '').slice(0, 90),
      };
      if (body.stream === false) {
        const msg = { role: 'assistant', content: plan.kind === 'text' ? plan.out : null };
        if (plan.kind === 'tool') msg.tool_calls = [{ id: 'call_deck332_1', type: 'function', function: { name: plan.name, arguments: plan.args } }];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: cid, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || 'probe-model', choices: [{ index: 0, message: msg, finish_reason: plan.kind === 'tool' ? 'tool_calls' : 'stop' }] }));
        return;
      }

      chunk({ role: 'assistant' });
      if (plan.kind === 'slow') {
        const words = plan.out.split(' ');
        let i = 0;
        const timer = setInterval(() => {
          if (i < words.length) { chunk({ content: words[i] + ' ' }); i++; }
          else { clearInterval(timer); chunk({}, 'stop'); done(); }
        }, 500);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (plan.kind === 'text') {
        const mid = Math.ceil(plan.out.length / 2);
        chunk({ content: plan.out.slice(0, mid) });
        setTimeout(() => { chunk({ content: plan.out.slice(mid) }); chunk({}, 'stop'); done(); }, 150);
        return;
      }
      chunk({ tool_calls: [{ index: 0, id: 'call_deck332_1', type: 'function', function: { name: plan.name, arguments: '' } }] });
      setTimeout(() => {
        chunk({ tool_calls: [{ index: 0, function: { arguments: plan.args } }] });
        chunk({}, 'tool_calls');
        done();
      }, 150);
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    server,
    requests: () => state.requests.slice(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startCannedLlm };
