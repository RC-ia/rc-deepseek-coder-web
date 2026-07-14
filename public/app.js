'use strict';
const chatEl = document.getElementById('chat');
const toolLogEl = document.getElementById('toollog');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}
function addTool(name, args, result) {
  const div = document.createElement('div');
  div.className = 'tool';
  const argStr = Object.entries(args || {})
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('  ');
  const isErr = String(result || '').startsWith('ERROR');
  div.innerHTML =
    `<div class="name">🔧 ${name}</div>` +
    `<div class="args">${escapeHtml(argStr)}</div>` +
    `<div class="result ${isErr ? 'err' : ''}">${escapeHtml(result || '')}</div>`;
  toolLogEl.appendChild(div);
  toolLogEl.scrollTop = toolLogEl.scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// status
fetch('/api/health')
  .then((r) => r.json())
  .then((d) => (statusEl.textContent = `proxy OK · ${d.model} · ${d.workdir}`))
  .catch(() => (statusEl.textContent = 'proxy: erro'));

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  addMsg('user', text);
  sendBtn.disabled = true;

  await streamChat(text);

  sendBtn.disabled = false;
}

function streamChat(text) {
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
  }).then((res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    return new Promise((resolve) => {
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) return resolve();
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            const line = part.replace(/^data: /, '').trim();
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            handleEvent(ev);
          }
          pump();
        });
      };
      pump();
    });
  });
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'start':
      break;
    case 'tool':
      addTool(ev.name, ev.args, '…');
      break;
    case 'tool_result':
      // atualiza o ultimo tool com o resultado
      updateLastToolResult(ev.result);
      break;
    case 'assistant':
      addMsg('assistant', ev.text);
      break;
    case 'info':
      addMsg('info', ev.text);
      break;
    case 'error':
      addMsg('error', ev.text);
      break;
  }
}

function updateLastToolResult(result) {
  const tools = toolLogEl.querySelectorAll('.tool');
  if (!tools.length) return;
  const last = tools[tools.length - 1];
  const r = last.querySelector('.result');
  r.textContent = result || '';
  if (String(result || '').startsWith('ERROR')) r.classList.add('err');
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
