'use strict';
/*
 * rc-deepseek-coder-web — backend Node (zero deps).
 * Servidor HTTP que:
 *  - serve a UI em public/
 *  - expoe POST /api/chat  -> roda o loop do agente contra o proxy DeepSeek Web
 *    usando tool_calls NATIVO (OpenAI), e faz stream dos eventos via SSE.
 *
 * Vars de ambiente:
 *   DS_API_BASE   base do proxy (default http://172.22.0.1:9655)
 *   DS_API_KEY    qualquer string (proxy nao valida)
 *   DS_MODEL      modelo (default deepseek-reasoner)
 *   DS_WORKDIR    pasta de trabalho (default ./workspace)
 *   PORT          porta do servidor web (default 8080)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const API_BASE = (process.env.DS_API_BASE || 'http://172.22.0.1:9655').replace(/\/$/, '');
const API_KEY = process.env.DS_API_KEY || 'sk-local';
const WORKDIR = path.resolve(process.env.DS_WORKDIR || './workspace');
const PORT = Number(process.env.PORT || 8080);
const MAX_TURNS = Number(process.env.DS_MAX_TURNS || 40);

fs.mkdirSync(WORKDIR, { recursive: true });

// ---------------------------------------------------------------------------
// Ferramentas (schema OpenAI + implementacao FS sandbox)
// ---------------------------------------------------------------------------
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file or list a directory inside the workspace. Relative path.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Create/overwrite a file inside the workspace with the given content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Replace an exact substring in a file (old_string -> new_string).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list',
      description: 'List files under a path (or workspace root).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern inside the workspace.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  },
];

function resolveRel(rel) {
  const p = path.resolve(WORKDIR, rel || '');
  if (p !== WORKDIR && !p.startsWith(WORKDIR + path.sep)) {
    throw new Error('path escapes workspace: ' + rel);
  }
  return p;
}

function runTool(name, args) {
  try {
    if (name === 'read') {
      const p = resolveRel(args.path);
      if (fs.statSync(p).isDirectory()) {
        const items = fs.readdirSync(p).sort();
        return 'DIR ' + path.relative(WORKDIR, p) + ':\n' + items.map((i) => {
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
      return `wrote ${path.relative(WORKDIR, p)} (${String(args.content || '').length} chars)`;
    }
    if (name === 'edit') {
      const p = resolveRel(args.path);
      let text = fs.readFileSync(p, 'utf-8');
      if (!text.includes(args.old_string)) return 'ERROR: old_string not found (exact match required).';
      text = text.replace(args.old_string, args.new_string || '', 1);
      fs.writeFileSync(p, text, 'utf-8');
      return `edited ${path.relative(WORKDIR, p)}`;
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
      const hits = globSync(WORKDIR, args.pattern || '**/*');
      return hits.map((h) => path.relative(WORKDIR, h)).join('\n') || '(no matches)';
    }
    return 'ERROR: unknown tool ' + name;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// glob minimo (sem dep)
function globSync(root, pattern) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else results.push(full);
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

// ---------------------------------------------------------------------------
// Cliente OpenAI-compatible (http nativo)
// ---------------------------------------------------------------------------
function chatCompletions(messages) {
  const model = process.env.DS_MODEL || 'deepseek-reasoner';
  const body = JSON.stringify({
    model, messages, tools: TOOL_DEFS, tool_choice: 'auto', stream: false,
  });
  const attempt = (n) => new Promise((resolve, reject) => {
    const u = new URL(API_BASE + '/v1/chat/completions');
    const req = http.request(
      u,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + API_KEY,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 180000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) return reject(Object.assign(new Error(json.error.message), { status: res.statusCode }));
            resolve(json);
          } catch (e) {
            reject(new Error('resposta invalida do proxy: ' + data.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout do proxy')));
    req.write(body);
    req.end();
  });
  return attempt().catch((e) => {
    if (String(e.message).includes('fetch failed') && model) return attempt(); // 1 retry de rede
    throw e;
  });
}

// ---------------------------------------------------------------------------
// Loop do agente com stream SSE
// ---------------------------------------------------------------------------
function runAgent(userMsg, send) {
  const messages = [
    {
      role: 'system',
      content:
        `You are a coding agent inside the workspace: ${WORKDIR}\n` +
        `Use the tools (read/write/edit/list/glob) to accomplish the request. ` +
        `Use RELATIVE paths. When done, reply with a short final summary (no tool calls).`,
    },
    { role: 'user', content: userMsg },
  ];

  let turns = 0;
  const step = async () => {
    if (turns >= MAX_TURNS) {
      send({ type: 'error', text: 'Limite de turnos atingido.' });
      return;
    }
    turns++;
    let resp;
    try {
      resp = await chatCompletions(messages);
    } catch (e) {
      if (e.status === 413) {
        send({ type: 'info', text: '413 contexto cheio — comprimindo historico...' });
        messages = compressHistory(messages);
        return step();
      }
      send({ type: 'error', text: `Erro ${e.status || ''}: ${e.message}` });
      return;
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
      return step(); // continua o ciclo
    } else {
      send({ type: 'assistant', text: msg.content || '' });
      return;
    }
  };
  step();
}

function compressHistory(messages) {
  const kept = [messages[0]];
  for (const m of messages.slice(1)) {
    if (m.role === 'tool' && (m.content || '').length > 1500) {
      kept.push({ role: 'tool', tool_call_id: m.tool_call_id, content: '(resultado truncado apos limite 413)' });
    } else kept.push(m);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/chat' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let userMsg = '';
      try { userMsg = JSON.parse(raw).message || ''; } catch {}
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ type: 'start' });
      runAgent(userMsg, send);
    });
    return;
  }

  if (u.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workdir: WORKDIR, model: process.env.DS_MODEL || 'deepseek-reasoner' }));
    return;
  }

  // arquivos estaticos
  let filePath = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : u.pathname);
  filePath = path.resolve(filePath);
  if (!filePath.startsWith(path.resolve(__dirname, 'public'))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`[rc-deepseek-coder-web] http://localhost:${PORT}`);
  console.log(`  proxy=${API_BASE}  workdir=${WORKDIR}  model=${process.env.DS_MODEL || 'deepseek-reasoner'}`);
});
