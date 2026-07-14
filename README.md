# rc-deepseek-coder-web

App web (npm + HTML/JS) que **gera código usando o seu proxy DeepSeek Web** via protocolo OpenAI nativo de tool-calling. Interface no navegador com **log de tool calls ao vivo** (SSE).

Mesma ideia do CLI `rc-deepseek-coder`, mas com UI: você descreve o que quer, o modelo chama as ferramentas (`read`/`write`/`edit`/`list`/`glob`) e você vê cada chamada e resultado no painel lateral — sem XML frágil, sem travamento das tools.

## Por que não trava as tools

O backend Node envia as ferramentas no formato `tools` da OpenAI e o proxy devolve `tool_calls` **estruturados**. O agente executa no sistema de arquivos e repete o ciclo. Validação real do proxy:

```json
"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\"path\":\"C:\\\"}"}}]
```

## Requisitos

- Node.js 18+ (apenas biblioteca padrão — **zero dependências de npm**)
- O proxy DeepSeek Web rodando (Windows ou host acessível)
- Quem roda o web app (WSL/Linux) deve alcançar o proxy

## Configuração (env)

| Var | Default | Descrição |
|---|---|---|
| `DS_API_BASE` | `http://172.22.0.1:9655` | Base URL do proxy |
| `DS_API_KEY` | `sk-local` | Proxy não valida |
| `DS_MODEL` | `deepseek-reasoner` | Modelo |
| `DS_WORKDIR` | `./workspace` | Pasta de trabalho (sandbox) |
| `PORT` | `8080` | Porta do servidor web |

## Uso

```bash
git clone https://github.com/RC-ia/rc-deepseek-coder-web.git
cd rc-deepseek-coder-web
npm start
# abra http://localhost:8080
```

No navegador, digite o pedido (ex.: "crie hello.py que imprima oi mundo") e veja as tool calls no painel ao vivo.

## Tratamento de erros

- **413 (contexto cheio):** o agente detecta e comprime o histórico antes de retomar.
- **Throttle 25s do proxy:** o proxy bloqueia a requisição; o app apenas aguarda a resposta (streaming).
- **Sandbox:** todas as ferramentas resolvem caminhos relativos e bloqueiam path que saia de `DS_WORKDIR`.

## Endpoints

- `GET /` — UI
- `POST /api/chat` — roda o agente, stream SSE (`data: {json}\n\n`)
- `GET /api/health` — status
