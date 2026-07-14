'use strict';
const $ = (s) => document.querySelector(s);
const chatEl = $('#chat');
const toolLogEl = $('#toollog');
const inputEl = $('#input');
const sendBtn = $('#send');
const statusEl = $('#status');
const wsSelect = $('#wsSelect');
const wsPathEl = $('#wsPath');
const modelSelect = $('#modelSelect');
const treeEl = $('#tree');

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}
function addTool(name, args, result) {
  const d = document.createElement('div');
  d.className = 'tool';
  const argStr = Object.entries(args || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ');
  const isErr = String(result || '').startsWith('ERROR');
  d.innerHTML = `<div class="name">🔧 ${name}</div><div class="args">${esc(argStr)}</div><div class="result ${isErr ? 'err' : ''}">${esc(result || '')}</div>`;
  toolLogEl.appendChild(d);
  toolLogEl.scrollTop = toolLogEl.scrollHeight;
}
function updateLastToolResult(result) {
  const tools = toolLogEl.querySelectorAll('.tool');
  if (!tools.length) return;
  const last = tools[tools.length - 1];
  const r = last.querySelector('.result');
  r.textContent = result || '';
  if (String(result || '').startsWith('ERROR')) r.classList.add('err');
}

// ---- tree render ----
function renderTree(tree) {
  if (!tree || !tree.length) { treeEl.innerHTML = '<div class="node">— vazio —</div>'; return; }
  const walk = (nodes, depth = 0) => {
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      const node = document.createElement('div');
      node.className = 'node ' + n.type;
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = (n.type === 'dir' ? '📁 ' : '📄 ') + n.name;
      node.appendChild(label);
      if (n.type === 'dir' && n.children && n.children.length) {
        const kids = document.createElement('div');
        kids.className = 'children';
        kids.appendChild(walk(n.children, depth + 1));
        node.appendChild(kids);
      }
      frag.appendChild(node);
    }
    return frag;
  };
  treeEl.innerHTML = '';
  treeEl.appendChild(walk(tree));
}

// ---- state ----
async function refreshWs() {
  const d = await (await fetch('/api/workspaces')).json();
  wsSelect.innerHTML = '';
  d.workspaces.forEach((w, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = w.name;
    if (i === d.active) o.selected = true;
    wsSelect.appendChild(o);
  });
  wsPathEl.textContent = d.workspaces[d.active].path;
  modelSelect.value = d.workspaces[d.active].model;
  return d;
}
async function refreshTree() {
  const d = await (await fetch('/api/tree')).json();
  renderTree(d.tree);
}

// ---- chat stream ----
async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  addMsg('user', text);
  sendBtn.disabled = true;
  await streamChat(text);
  sendBtn.disabled = false;
  refreshTree();
}
function streamChat(text) {
  return fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) })
    .then((res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      return new Promise((resolve) => {
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) return resolve();
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            const line = part.replace(/^data: /, '').trim();
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            handleEvent(ev);
          }
          pump();
        });
        pump();
      });
    });
}
function handleEvent(ev) {
  switch (ev.type) {
    case 'tool': addTool(ev.name, ev.args, '…'); break;
    case 'tool_result': updateLastToolResult(ev.result); break;
    case 'assistant': addMsg('assistant', ev.text); break;
    case 'info': addMsg('info', ev.text); break;
    case 'error': addMsg('error', ev.text); break;
    case 'tree': renderTree(ev.tree); break;
  }
}

// ---- events ----
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
wsSelect.addEventListener('change', async () => {
  await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ switchTo: Number(wsSelect.value) }) });
  await refreshWs(); await refreshTree();
  chatEl.innerHTML = ''; addMsg('info', 'Workspace trocado para ' + wsSelect.options[wsSelect.selectedIndex].text);
});
modelSelect.addEventListener('change', async () => {
  await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelSelect.value }) });
  addMsg('info', 'Modelo -> ' + modelSelect.value);
});
$('#themeBtn').addEventListener('click', () => {
  document.body.classList.toggle('light');
  const light = document.body.classList.contains('light');
  $('#themeBtn').textContent = light ? '☀️ Tema' : '🌙 Tema';
  try { localStorage.setItem('rc-theme', light ? 'light' : 'dark'); } catch {}
});

// ---- modal ----
$('#newWsBtn').addEventListener('click', () => { $('#modal').classList.remove('hidden'); $('#wsName').value = ''; $('#wsPathInput').value = ''; $('#wsName').focus(); });
$('#wsCancel').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#wsCreate').addEventListener('click', async () => {
  const name = $('#wsName').value.trim();
  const p = $('#wsPathInput').value.trim();
  if (!p) { alert('Informe um caminho.'); return; }
  const d = await (await fetch('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, path: p, model: modelSelect.value }) })).json();
  if (d.error) { alert(d.error); return; }
  $('#modal').classList.add('hidden');
  await refreshWs(); await refreshTree();
  chatEl.innerHTML = ''; addMsg('info', 'Workspace criado: ' + name);
});

// ---- init ----
try { if (localStorage.getItem('rc-theme') === 'light') { document.body.classList.add('light'); $('#themeBtn').textContent = '☀️ Tema'; } } catch {}
fetch('/api/health').then((r) => r.json()).then((d) => { statusEl.textContent = `proxy ${d.api_base} · ${d.model} · ${d.workspaces ? d.workspaces.length : ''} ws`; }).catch(() => (statusEl.textContent = 'proxy: erro'));
refreshWs().then(refreshTree);
