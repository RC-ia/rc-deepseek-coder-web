'use strict';
/*
 * rc-deepseek-coder-web — backend Node (zero deps).
 *  - UI estilo OpenCode: sessions persistentes (arquivos JSON), chat, tool calls ao vivo
 *  - POST /api/sessions/:id/messages -> roda o agente via tool_calls NATIVO (OpenAI) + SSE
 *
 * Env: DS_API_BASE, DS_API_KEY, DS_MODEL, PORT
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

// ---- carrega .env (zero-dep) ----
function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv();

const API_BASE = (process.env.DS_API_BASE || 'http://172.22.0.1:9655').replace(/\/$/, '');
const API_KEY = process.env.DS_API_KEY || 'sk-local';
const PORT = Number(process.env.PORT || 8080);
const MAX_TURNS = Number(process.env.DS_MAX_TURNS || 40);
const SESS_DIR = path.join(os.homedir(), '.rc-coder', 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

const MODELS = ['deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-v3'];

// ---------------------------------------------------------------------------
// Sessoes (persistencia em arquivo)
// ---------------------------------------------------------------------------
function listSessions() {
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf-8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function getSession(id) {
  const p = path.join(SESS_DIR, id + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}
function saveSession(s) {
  s.updatedAt = Date.now();
  fs.writeFileSync(path.join(SESS_DIR, s.id + '.json'), JSON.stringify(s, null, 2));
}
function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'Nova conversa';
  const t = String(firstUser.content || '').trim().split('\n')[0];
  return (t.length > 42 ? t.slice(0, 42) + '…' : t) || 'Nova conversa';
}
function previewOf(s) {
  const last = [...(s.messages || [])].reverse().find((m) => m.role === 'assistant' && m.content);
  return last ? (String(last.content).slice(0, 80)) : 'Sem mensagens';
}

// ---------------------------------------------------------------------------
// Ferramentas (schema OpenAI + FS sandbox por workspace da sessao)
// ---------------------------------------------------------------------------
const TOOL_DEFS = [
  { type: 'function', function: { name: 'read', description: 'Read a file or list a directory inside the workspace. Relative path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write', description: 'Create/overwrite a file inside the workspace with the given content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Replace an exact substring in a file (old_string -> new_string).', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'list', description: 'List files under a path (or workspace root).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files matching a glob pattern inside the workspace.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
];

function wsRootOf(s) {
  const root = path.resolve(s.workspace || './workspace');
  fs.mkdirSync(root, { recursive: true });
  return root;
}
function resolveRel(root, rel) {
  const p = path.resolve(root, rel || '');
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('path escapes workspace: ' + rel);
  return p;
}
function runTool(root, name, args) {
  try {
    if (name === 'read') {
      const p = resolveRel(root, args.path);
      if (fs.statSync(p).isDirectory()) {
        const items = fs.readdirSync(p).sort();
        return 'DIR ' + path.relative(root, p) + ':\n' + items.map((i) => {
          const full = path.join(p, i);
          return fs.statSync(full).isDirectory() ? i + '/' : i;
        }).join('\n');
      }
      return fs.readFileSync(p, 'utf-8');
    }
    if (name === 'write') {
      const p = resolveRel(root, args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content || '', 'utf-8');
      return `wrote ${path.relative(root, p)} (${String(args.content || '').length} chars)`;
    }
    if (name === 'edit') {
      const p = resolveRel(root, args.path);
      let text = fs.readFileSync(p, 'utf-8');
      if (!text.includes(args.old_string)) return 'ERROR: old_string not found (exact match required).';
      text = text.replace(args.old_string, args.new_string || '', 1);
      fs.writeFileSync(p, text, 'utf-8');
      return `edited ${path.relative(root, p)}`;
    }
    if (name === 'list') {
      const base = resolveRel(root, args.path || '');
      const out = [];
      for (const e of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) out.push((e.isDirectory() ? '[d] ' : '[f] ') + e.name);
      return out.join('\n') || '(empty)';
    }
    if (name === 'glob') {
      const hits = globSync(root, args.pattern || '**/*');
      return hits.map((h) => path.relative(root, h)).join('\n') || '(no matches)';
    }
    return 'ERROR: unknown tool ' + name;
  } catch (e) { return `ERROR: ${e.message}`; }
}
function globSync(root, pattern) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const full = path.join(dir, e.name); if (e.isDirectory()) walk(full); else results.push(full); }
  };
  walk(root);
  const re = patternToRegExp(pattern);
  return results.filter((f) => re.test(path.relative(root, f).replace(/\\/g, '/')));
}
function patternToRegExp(pat) {
  let rx = '^';
  for (const c of pat.split('')) { if (c === '*') rx += '[^/]*'; else if (c === '?') rx += '[^/]'; else rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }
  return new RegExp(rx + '$');
}
function buildTree(dir, base, depth) {
  if (depth > 4) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') && e.name !== '.git') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) out.push({ name: e.name, path: rel, type: 'dir', children: buildTree(full, base, depth + 1) });
    else out.push({ name: e.name, path: rel, type: 'file' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cliente OpenAI-compatible
// ---------------------------------------------------------------------------
function chatCompletions(messages, model) {
  const body = JSON.stringify({ model, messages, tools: TOOL_DEFS, tool_choice: 'auto', stream: false });
  const attempt = () => new Promise((resolve, reject) => {
    const u = new URL(API_BASE + '/v1/chat/completions');
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY, 'Content-Length': Buffer.byteLength(body) }, timeout: 180000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { const json = JSON.parse(data); if (json.error) return reject(Object.assign(new Error(json.error.message), { status: res.statusCode })); resolve(json); }
        catch (e) { reject(new Error('resposta invalida do proxy: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout do proxy')));
    req.write(body); req.end();
  });
  return attempt().catch((e) => (String(e.message).includes('fetch failed') ? attempt() : Promise.reject(e)));
}

// ---------------------------------------------------------------------------
// Loop do agente (SSE) — roda dentro de uma sessao
// ---------------------------------------------------------------------------
function runAgent(session, userMsg, model, send) {
  const root = wsRootOf(session);
  const messages = session.messages.map((m) => ({ role: m.role, content: m.content, tool_calls: m.tool_calls }));
  messages.push({ role: 'user', content: userMsg });
  session.messages.push({ role: 'user', content: userMsg, ts: Date.now() });

  let turns = 0;
  const step = async () => {
    if (turns >= MAX_TURNS) { send({ type: 'error', text: 'Limite de turnos atingido.' }); send({ type: 'done' }); return; }
    turns++;
    let resp;
    try { resp = await chatCompletions(messages, model); }
    catch (e) {
      if (e.status === 413) { send({ type: 'info', text: '413 contexto cheio — comprimindo historico...' }); messages = compressHistory(messages); return step(); }
      send({ type: 'error', text: `Erro ${e.status || ''}: ${e.message}` }); send({ type: 'done' }); return;
    }
    const choice = resp.choices[0];
    const msg = choice.message;
    messages.push(msg);
    const stored = { role: 'assistant', content: msg.content || '', tool_calls: (msg.tool_calls || []).map((t) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })), ts: Date.now() };
    session.messages.push(stored);
    if (choice.finish_reason === 'tool_calls' || (msg.tool_calls && msg.tool_calls.length)) {
      if (msg.content && msg.content.trim()) send({ type: 'assistant', text: msg.content });
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        send({ type: 'tool', name: tc.function.name, args });
        const result = runTool(root, tc.function.name, args);
        send({ type: 'tool_result', name: tc.function.name, result });
        stored.tools = stored.tools || [];
        stored.tools.push({ name: tc.function.name, args, result });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      if (turns % 2 === 0) send({ type: 'tree', tree: buildTree(root, root, 0) });
      return step();
    } else {
      send({ type: 'assistant', text: msg.content || '' });
      send({ type: 'tree', tree: buildTree(root, root, 0) });
      session.title = deriveTitle(session.messages);
      saveSession(session);
      send({ type: 'session', session: publicSession(session) });
      send({ type: 'done' });
    }
  };
  step();
}
function compressHistory(messages) {
  const kept = [messages[0]];
  for (const m of messages.slice(1)) {
    if (m.role === 'tool' && (m.content || '').length > 1500) kept.push({ role: 'tool', tool_call_id: m.tool_call_id, content: '(resultado truncado apos limite 413)' });
    else kept.push(m);
  }
  return kept;
}
function publicSession(s) {
  return { id: s.id, title: s.title, workspace: s.workspace, model: s.model, preview: previewOf(s), updatedAt: s.updatedAt, createdAt: s.createdAt, messageCount: (s.messages || []).length };
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function sendJson(res, obj, code) { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const readBody = (cb) => { let r = ''; req.on('data', (c) => (r += c)); req.on('end', () => { let j = {}; try { j = JSON.parse(r); } catch {} cb(j); }); };

  // ---- sessions ----
  if (u.pathname === '/api/sessions' && req.method === 'GET') {
    return sendJson(res, { sessions: listSessions().map(publicSession), models: MODELS, api_base: API_BASE });
  }
  if (u.pathname === '/api/sessions' && req.method === 'POST') {
    return readBody((j) => {
      const s = { id: newId(), title: j.title || 'Nova conversa', workspace: j.workspace || './workspace', model: j.model || process.env.DS_MODEL || 'deepseek-reasoner', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
      saveSession(s);
      return sendJson(res, { session: publicSession(s) });
    });
  }
  const m = u.pathname.match(/^\/api\/sessions\/([\w-]+)(\/messages)?$/);
  if (m) {
    const id = m[1];
    const s = getSession(id);
    if (!s) { res.writeHead(404); res.end('session not found'); return; }
    if (req.method === 'GET') return sendJson(res, { session: s, tree: buildTree(wsRootOf(s), wsRootOf(s), 0) });
    if (req.method === 'DELETE') { fs.unlinkSync(path.join(SESS_DIR, id + '.json')); return sendJson(res, { ok: true }); }
    if (req.method === 'POST' && m[2] === '/messages') {
      return readBody((j) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const send = (o) => { res.write(`data: ${JSON.stringify(o)}\n\n`); if (o.type === 'done') res.end(); };
        send({ type: 'start' });
        runAgent(s, j.message || '', j.model || s.model, send);
      });
    }
  }
  if (u.pathname === '/api/health') return sendJson(res, { ok: true, api_base: API_BASE });

  // ---- estaticos ----
  let filePath = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  filePath = path.resolve(filePath);
  if (!filePath.startsWith(path.resolve(__dirname, 'public'))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[rc-deepseek-coder-web] http://localhost:${PORT}`);
  console.log(`  proxy=${API_BASE}  sessions=${listSessions().length}  dir=${SESS_DIR}`);
});
