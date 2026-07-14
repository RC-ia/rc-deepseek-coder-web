'use strict';
/*
 * rc-deepseek-coder-web — backend Node (zero deps).
 *  - UI em public/ (chat + tool calls ao vivo + sidebar de workspaces)
 *  - POST /api/chat  -> loop do agente via tool_calls NATIVO (OpenAI) + SSE
 *  - workspaces dinamicos: criar/switch em qualquer caminho (persistido)
 *
 * Env: DS_API_BASE, DS_API_KEY, DS_MODEL, DS_WORKDIR, PORT
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');

// ---- carrega .env (zero-dep) ANTES de ler as configs ----
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
const WS_FILE = path.join(os.homedir(), '.rc-coder-workspaces.json');

const MODELS = ['deepseek-reasoner', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-v3'];

// ---- workspaces persistentes ----
let workspaces = [];
try { workspaces = JSON.parse(fs.readFileSync(WS_FILE, 'utf-8')); } catch {}
if (!Array.isArray(workspaces) || !workspaces.length) {
  const def = path.resolve(process.env.DS_WORKDIR || './workspace');
  workspaces = [{ name: 'default', path: def, model: process.env.DS_MODEL || 'deepseek-reasoner' }];
  fs.mkdirSync(def, { recursive: true });
  saveWs();
}
let activeWs = 0;
function saveWs() { fs.writeFileSync(WS_FILE, JSON.stringify(workspaces, null, 2)); }
function ws() { return workspaces[activeWs]; }
function wsRoot() { const r = path.resolve(ws().path); fs.mkdirSync(r, { recursive: true }); return r; }

// ---------------------------------------------------------------------------
// Ferramentas (schema OpenAI + implementacao FS sandbox)
// ---------------------------------------------------------------------------
const TOOL_DEFS = [
  { type: 'function', function: { name: 'read', description: 'Read a file or list a directory inside the workspace. Relative path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write', description: 'Create/overwrite a file inside the workspace with the given content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Replace an exact substring in a file (old_string -> new_string).', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'list', description: 'List files under a path (or workspace root).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files matching a glob pattern inside the workspace.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
];

function resolveRel(rel) {
  const root = wsRoot();
  const p = path.resolve(root, rel || '');
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('path escapes workspace: ' + rel);
  return p;
}

function runTool(name, args) {
  const root = wsRoot();
  try {
    if (name === 'read') {
      const p = resolveRel(args.path);
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
      const p = resolveRel(args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content || '', 'utf-8');
      return `wrote ${path.relative(root, p)} (${String(args.content || '').length} chars)`;
    }
    if (name === 'edit') {
      const p = resolveRel(args.path);
      let text = fs.readFileSync(p, 'utf-8');
      if (!text.includes(args.old_string)) return 'ERROR: old_string not found (exact match required).';
      text = text.replace(args.old_string, args.new_string || '', 1);
      fs.writeFileSync(p, text, 'utf-8');
      return `edited ${path.relative(root, p)}`;
    }
    if (name === 'list') {
      const base = resolveRel(args.path || '');
      const out = [];
      for (const e of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        out.push((e.isDirectory() ? '[d] ' : '[f] ') + e.name);
      }
      return out.join('\n') || '(empty)';
    }
    if (name === 'glob') {
      const hits = globSync(root, args.pattern || '**/*');
      return hits.map((h) => path.relative(root, h)).join('\n') || '(no matches)';
    }
    return 'ERROR: unknown tool ' + name;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function globSync(root, pattern) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full); else results.push(full);
    }
  };
  walk(root);
  const re = patternToRegExp(pattern);
  return results.filter((f) => re.test(path.relative(root, f).replace(/\\/g, '/')));
}
function patternToRegExp(pat) {
  let rx = '^';
  for (const c of pat.split('')) {
    if (c === '*') rx += '[^/]*';
    else if (c === '?') rx += '[^/]';
    else rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(rx + '$');
}

// arvore de arquivos (para a UI)
function buildTree(dir, base, depth) {
  if (depth > 4) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') && e.name !== '.git') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: rel, type: 'dir', children: buildTree(full, base, depth + 1) });
    } else {
      out.push({ name: e.name, path: rel, type: 'file' });
    }
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
    const req = http.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY, 'Content-Length': Buffer.byteLength(body) },
      timeout: 180000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(Object.assign(new Error(json.error.message), { status: res.statusCode }));
          resolve(json);
        } catch (e) { reject(new Error('resposta invalida do proxy: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout do proxy')));
    req.write(body); req.end();
  });
  return attempt().catch((e) => (String(e.message).includes('fetch failed') ? attempt() : Promise.reject(e)));
}

// ---------------------------------------------------------------------------
// Loop do agente (SSE)
// ---------------------------------------------------------------------------
function runAgent(userMsg, model, send) {
  const root = wsRoot();
  const messages = [
    { role: 'system', content: `You are a coding agent inside the workspace: ${root}\nUse the tools (read/write/edit/list/glob) to accomplish the request. Use RELATIVE paths. When done, reply with a short final summary (no tool calls).` },
    { role: 'user', content: userMsg },
  ];
  let turns = 0;
  const step = async () => {
    if (turns >= MAX_TURNS) { send({ type: 'error', text: 'Limite de turnos atingido.' }); return; }
    turns++;
    let resp;
    try { resp = await chatCompletions(messages, model); }
    catch (e) {
      if (e.status === 413) { send({ type: 'info', text: '413 contexto cheio — comprimindo historico...' }); messages = compressHistory(messages); return step(); }
      send({ type: 'error', text: `Erro ${e.status || ''}: ${e.message}` }); return;
    }
    const choice = resp.choices[0];
    const msg = choice.message;
    messages.push(msg);
    if (choice.finish_reason === 'tool_calls' || (msg.tool_calls && msg.tool_calls.length)) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        send({ type: 'tool', name: tc.function.name, args });
        const result = runTool(tc.function.name, args);
        send({ type: 'tool_result', name: tc.function.name, result });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      if (turns % 2 === 0) send({ type: 'tree', tree: buildTree(root, root, 0) }); // atualiza arvore
      return step();
    } else {
      send({ type: 'assistant', text: msg.content || '' });
      send({ type: 'tree', tree: buildTree(root, root, 0) });
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

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function sendJson(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  const readBody = (cb) => { let r = ''; req.on('data', (c) => (r += c)); req.on('end', () => { let j = {}; try { j = JSON.parse(r); } catch {} cb(j); }); };

  // ---- API ----
  if (u.pathname === '/api/chat' && req.method === 'POST') {
    return readBody((j) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ type: 'start' });
      runAgent(j.message || '', ws().model, send);
    });
  }
  if (u.pathname === '/api/health') return sendJson(res, { ok: true, workdir: ws().path, model: ws().model, api_base: API_BASE, workspaces });
  if (u.pathname === '/api/workspaces' && req.method === 'GET') return sendJson(res, { workspaces, active: activeWs });
  if (u.pathname === '/api/workspaces' && req.method === 'POST') {
    return readBody((j) => {
      const p = path.resolve(j.path || '');
      if (!fs.existsSync(p)) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) { return sendJson(res, { error: e.message }, 400); } }
      if (j.switchTo !== undefined) { activeWs = Math.max(0, Math.min(workspaces.length - 1, Number(j.switchTo))); return sendJson(res, { workspaces, active: activeWs }); }
      const name = j.name || path.basename(p);
      if (workspaces.some((w) => w.path === p)) return sendJson(res, { error: 'workspace ja existe' }, 400);
      workspaces.push({ name, path: p, model: j.model || 'deepseek-reasoner' });
      activeWs = workspaces.length - 1; saveWs();
      return sendJson(res, { workspaces, active: activeWs });
    });
  }
  if (u.pathname === '/api/model' && req.method === 'POST') {
    return readBody((j) => { if (MODELS.includes(j.model)) { ws().model = j.model; saveWs(); } sendJson(res, { model: ws().model }); });
  }
  if (u.pathname === '/api/tree' && req.method === 'GET') {
    const root = wsRoot();
    return sendJson(res, { tree: buildTree(root, root, 0) });
  }

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
  console.log(`  proxy=${API_BASE}  workspaces=${workspaces.length}  ativo=${ws().name} (${ws().path})  model=${ws().model}`);
});
