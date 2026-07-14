# rc-deepseek-coder-web

App web (npm + HTML/JS/CSS, **zero dependências**) que gera código usando o seu proxy DeepSeek Web via protocolo OpenAI nativo de tool-calling. Interface **estilo OpenCode**: sessions persistentes (salvas em arquivo), chat compacto, tool calls embutidas nas mensagens e painel de arquivos.

## Recursos

- 💬 **Chat permanente** — cada conversa é uma **session** salva em `~/.rc-coder/sessions/<id>.json`. Sobrevive a restart do servidor; você pode fechar o navegador e continuar depois.
- 📋 **Lista de sessions estilo OpenCode** — sidebar com ícone, título (derivado da 1ª mensagem), preview da última resposta e tempo relativo. Clique para abrir, 🗑 para excluir.
- 🔧 **Tool calls embutidas** — cada `read`/`write`/`edit`/`list`/`glob` aparece dentro da mensagem do assistant, com args + resultado.
- 🌳 **Árvore de arquivos** do workspace (botão 🌳).
- 🎛️ **Seletor de modelo** por session (deepseek-reasoner / v4-pro / chat / v3).
- 🌙 **Tema claro/escuro**.
- 🛡️ **Sandbox**: ferramentas só operam dentro do workspace da session.

## Por que não trava as tools

O backend Node envia as ferramentas no formato `tools` da OpenAI e o proxy devolve `tool_calls` **estruturados**. O agente executa no FS e repete o ciclo. Validação real:

```json
"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\"path\":\"C:\\\"}"}}]
```

## Requisitos

- Node.js 18+ (apenas biblioteca padrão — **zero dependências de npm**)
- O proxy DeepSeek Web rodando e acessível

## Configuração (env / .env)

Copie `.env.example` → `.env`. Carregado automaticamente.

| Var | Default | Descrição |
|---|---|---|
| `DS_API_BASE` | `http://172.22.0.1:9655` | Base URL do proxy (**obrigatória**) |
| `DS_API_KEY` | `sk-local` | Proxy não valida |
| `DS_MODEL` | `deepseek-reasoner` | Modelo padrão |
| `PORT` | `8080` | Porta do servidor web |

Sessions ficam em `~/.rc-coder/sessions/`.

## Uso

```bash
git clone https://github.com/RC-ia/rc-deepseek-coder-web.git
cd rc-deepseek-coder-web
npm start          # node server.js
# abra http://localhost:8080
```

1. Clique em **+ Nova sessão**.
2. Digite o pedido (ex.: "crie hello.py que imprima oi mundo").
3. A session é salva automaticamente — reaparece na lista ao reabrir.

## Tratamento de erros

- **413 (contexto cheio):** o agente detecta e comprime o histórico.
- **Throttle 25s do proxy:** o proxy bloqueia a requisição; o app apenas aguarda (streaming).
- **1 retry de rede** em falhas transitórias.

## Endpoints

- `GET /` — UI
- `GET /api/sessions` · `POST /api/sessions` (criar) · `DELETE /api/sessions/:id`
- `GET /api/sessions/:id` · `POST /api/sessions/:id/messages` (roda agente, SSE)
- `GET /api/health`
