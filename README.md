# rc-deepseek-coder-web

App web (npm + HTML/JS/CSS) que **gera código usando o seu proxy DeepSeek Web** via protocolo OpenAI nativo de tool-calling, com **log de tool calls ao vivo**, **workspaces dinâmicos** (qualquer pasta, em qualquer local) e **tema claro/escuro**.

## Recursos

- 💬 **Chat** com o modelo (DeepSeek Web via proxy) — sem XML frágil, usa `tool_calls` estruturado.
- 🔧 **Tool calls ao vivo** (painel lateral): cada `read`/`write`/`edit`/`list`/`glob` com args + resultado.
- 📁 **Workspaces**: crie um workspace apontando para **qualquer pasta** (ex.: `/home/aldair/projeto`, `C:\mango - Copia`). Troque entre eles a qualquer momento. Persistido em `~/.rc-coder-workspaces.json`.
- 🌳 **Árvore de arquivos** do workspace atualizada em tempo real conforme o agente cria/edita arquivos.
- 🎛️ **Seletor de modelo** (deepseek-reasoner / v4-pro / chat / v3) por workspace.
- 🌙 **Tema claro/escuro** (preferência salva no navegador).
- 🛡️ **Sandbox**: ferramentas só operam dentro do workspace ativo.

## Por que não trava as tools

O backend Node envia as ferramentas no formato `tools` da OpenAI e o proxy devolve `tool_calls` **estruturados**. O agente executa no FS e repete o ciclo. Validação real:

```json
"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\"path\":\"C:\\\"}"}}]
```

## Requisitos

- Node.js 18+ (apenas biblioteca padrão — **zero dependências de npm**)
- O proxy DeepSeek Web rodando e acessível
- Quem roda o app (WSL/Linux) deve alcançar o proxy

## Configuração (env)

| Var | Default | Descrição |
|---|---|---|
| `DS_API_BASE` | `http://172.22.0.1:9655` | Base URL do proxy |
| `DS_API_KEY` | `sk-local` | Proxy não valida |
| `DS_MODEL` | `deepseek-reasoner` | Modelo padrão (cria workspace "default") |
| `DS_WORKDIR` | `./workspace` | Pasta do workspace "default" |
| `PORT` | `8080` | Porta do servidor web |

## Uso

```bash
git clone https://github.com/RC-ia/rc-deepseek-coder-web.git
cd rc-deepseek-coder-web
npm start          # node server.js
# abra http://localhost:8080
```

1. Clique em **+ Novo workspace**, dê um nome e aponte para qualquer pasta.
2. Selecione o modelo no seletor.
3. Digite o pedido (ex.: "crie hello.py que imprima oi mundo") e veja as tool calls + árvore ao vivo.

## Tratamento de erros

- **413 (contexto cheio):** o agente detecta e comprime o histórico antes de retomar.
- **Throttle 25s do proxy:** o proxy bloqueia a requisição; o app apenas aguarda (streaming).
- **1 retry de rede** em falhas transitórias do proxy.

## Endpoints

- `GET /` — UI
- `POST /api/chat` — roda o agente, stream SSE (`data: {json}\n\n`)
- `GET /api/workspaces` · `POST /api/workspaces` (criar/switch)
- `POST /api/model` — troca modelo do workspace ativo
- `GET /api/tree` — árvore de arquivos do workspace
- `GET /api/health` — status
