'use strict';
const $ = (s) => document.querySelector(s);
const chatEl = $('#chat');
const sessionsEl = $('#sessions');
const inputEl = $('#input');
const sendBtn = $('#send');
const statusEl = $('#status');
const sessBadge = $('#sessBadge');
const modelSelect = $('#modelSelect');
const treeEl = $('#tree');
const toolsPanel = $('#toolsPanel');

let currentId = null;
let models = [];

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function relTime(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.innerHTML = `<div class="role">${role}</div>${esc(text)}`;
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}
function renderTools(container, tools) {
  for (const t of tools || []) {
    const d = document.createElement('div');
    d.className = 'tool';
    const argStr = Object.entries(t.args || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ');
    const isErr = String(t.result || '').startsWith('ERROR');
    d.innerHTML = `<div class="name">🔧 ${esc(t.name)}</div><div class="args">${esc(argStr)}</div><div class="result ${isErr ? 'err' : ''}">${esc(t.result || '')}</div>`;
    container.appendChild(d);
  }
}
function renderTree(tree) {
  if (!tree || !tree.length) { treeEl.innerHTML = '<div class="node">— vazio —</div>'; return; }
  const walk = (nodes) => {
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
        kids.appendChild(walk(n.children));
        node.appendChild(kids);
      }
      frag.appendChild(node);
    }
    return frag;
  };
  treeEl.innerHTML = ''; treeEl.appendChild(walk(tree));
}

// ---- sessions ----
async function loadSessions() {
  const d = await (await fetch('/api/sessions')).json();
  models = d.models || [];
  modelSelect.innerHTML = '';
  models.forEach((m) => { const o = document.createElement('option'); o.value = m; o.textContent = m; modelSelect.appendChild(o); });
  statusEl.textContent = `proxy ${d.api_base}`;
  sessionsEl.innerHTML = '';
  (d.sessions || []).forEach((s) => {
    const el = document.createElement('div');
    el.className = 'session' + (s.id === currentId ? ' active' : '');
    el.innerHTML = `<div class="s-title">${esc(s.title)}</div><div class="s-preview">${esc(s.preview)}</div><div class="s-meta"><span>${relTime(s.updatedAt)}</span><span class="s-del" data-del="${s.id}">🗑</span></div>`;
    el.addEventListener('click', (e) => { if (e.target.dataset.del) return; openSession(s.id); });
    el.querySelector('.s-del').addEventListener('click', (e) => { e.stopPropagation(); delSession(s.id); });
    sessionsEl.appendChild(el);
  });
}
async function openSession(id) {
  currentId = id;
  const d = await (await fetch('/api/sessions/' + id)).json();
  modelSelect.value = d.session.model;
  sessBadge.textContent = d.session.title;
  chatEl.innerHTML = '';
  for (const m of d.session.messages) {
    if (m.role === 'user') addMsg('user', m.content);
    else if (m.role === 'assistant') {
      if (m.content) addMsg('assistant', m.content);
      if (m.tools && m.tools.length) {
        const wrap = document.createElement('div');
        wrap.className = 'tools';
        renderTools(wrap, m.tools);
        chatEl.appendChild(wrap);
        chatEl.scrollTop = chatEl.scrollHeight;
      }
    }
  }
  if (d.tree) renderTree(d.tree);
  else refreshTree();
  await loadSessions();
}
async function delSession(id) {
  if (!confirm('Excluir esta sessão?')) return;
  await fetch('/api/sessions/' + id, { method: 'DELETE' });
  if (currentId === id) { currentId = null; sessBadge.textContent = 'nenhuma sessão'; chatEl.innerHTML = ''; }
  await loadSessions();
}
async function refreshTree() {
  if (!currentId) return;
  const d = await (await fetch('/api/sessions/' + currentId)).json();
  if (d.tree) renderTree(d.tree);
}

// ---- chat ----
async function send() {
  const text = inputEl.value.trim();
  if (!text || !currentId) { if (!currentId) alert('Crie ou selecione uma sessão primeiro.'); return; }
  inputEl.value = '';
  addMsg('user', text);
  sendBtn.disabled = true;
  const model = modelSelect.value;
  await streamChat(text, model);
  sendBtn.disabled = false;
  loadSessions();
}
function streamChat(text, model) {
  return fetch('/api/sessions/' + currentId + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, model }) })
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
    case 'assistant': addMsg('assistant', ev.text); break;
    case 'info': addMsg('info', ev.text); break;
    case 'error': addMsg('error', ev.text); break;
    case 'tool':
      // agrupa tools na ultima msg assistant (ou cria container)
      let wrap = chatEl.querySelector('.tools:last-child');
      if (!wrap || wrap.dataset.closed) { wrap = document.createElement('div'); wrap.className = 'tools'; chatEl.appendChild(wrap); }
      renderTools(wrap, [{ name: ev.name, args: ev.args, result: '…' }]);
      chatEl.scrollTop = chatEl.scrollHeight;
      break;
    case 'tool_result':
      // atualiza o ultimo tool pendente
      {
        const wraps = chatEl.querySelectorAll('.tools');
        const last = wraps[wraps.length - 1];
        if (last) { const r = last.querySelectorAll('.tool .result'); const lr = r[r.length - 1]; if (lr) { lr.textContent = ev.result || ''; if (String(ev.result || '').startsWith('ERROR')) lr.classList.add('err'); } }
      }
      break;
    case 'tree': renderTree(ev.tree); break;
    case 'session': sessBadge.textContent = ev.session.title; break;
    case 'done': refreshTree(); break;
  }
}

// ---- events ----
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('#newBtn').addEventListener('click', async () => {
  const d = await (await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).json();
  await loadSessions();
  openSession(d.session.id);
});
$('#themeBtn').addEventListener('click', () => {
  document.body.classList.toggle('light');
  $('#themeBtn').textContent = document.body.classList.contains('light') ? '☀️' : '🌙';
  try { localStorage.setItem('rc-theme', document.body.classList.contains('light') ? 'light' : 'dark'); } catch {}
});
$('#treeBtn').addEventListener('click', () => { toolsPanel.classList.toggle('hidden'); if (!toolsPanel.classList.contains('hidden')) refreshTree(); });
$('#treeClose').addEventListener('click', () => toolsPanel.classList.add('hidden'));

// ---- init ----
try { if (localStorage.getItem('rc-theme') === 'light') { document.body.classList.add('light'); $('#themeBtn').textContent = '☀️'; } } catch {}
loadSessions();
