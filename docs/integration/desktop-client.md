# Desktop clients and runtime integration

## In-repository Ocean Desktop

`apps/desktop` imports the complete committed desktop tree from source revision
`1c8d8c3` (2026-11-02). See [its README](../../apps/desktop/README.md) for launch
and attachment behavior. It is an Electron/Vue Linux client with room/bot
management, direct/group history, named recipients, appearance controls and
persistent scoped attachments (four files, 10 MiB each).

The implemented host is `apps/desktop/src/host/main.ts`. Each operation starts
an external Node 26 worker, which invokes this checkout's built CLI through
`src/host/worker.ts`; it does not attach through ACP or a shared-runtime socket.
Its private Electron userData `conversation` directory contains the CLI profile,
workspace and attachment store. Window close sends SIGINT to the active worker;
an interrupted send can remain `uncertain`, and does not prove cancellation.

Attachment bytes and request receipts are stored before CLI submission. Images
can be previewed/zoomed, text can be previewed, and original files exported.
Clipboard/drop imports and restarted history use the same room/message-scoped
store. The current provider path is text-only: it includes bounded text excerpts
and descriptions, with no image/PDF/archive understanding. CLI profile backup
does not include attachment bytes; preserve the full `conversation` directory.

[Shared local runtime](../ocean/shared-runtime.md) is a future migration of this
in-repository host. The current worker-per-request implementation has no shared
endpoint seam and is not evidence of detach/reconnect or two-client runtime
acceptance. Deterministic GUI smoke/transfer QA uses a temporary Electron profile
and mocked HTTP provider; live-provider, installed-app and packaging qualification
are separate gates. This import does not modify the installed application.

## External RunneBot / ACP client

The following contract describes the separately inspected **RunneBot**
(`runnebot` 0.1.111, Electron/React, Linux x86_64), an MIT OpenMausBot fork from
`Ryltsevmg/runne-os`. That client's source is not vendored here and its ACP
handshake has not been qualified end-to-end. Its external-engine contract is
separate from the imported Ocean Desktop host above.

## How a desktop client attaches an external engine

The client resolves engines from an instance map; an external runtime is one
entry. Two supported shapes:

1. **Any ACP agent CLI over stdio** — the client spawns the process and speaks
   Agent Client Protocol v1:

   ```json
   {
     "instances": {
       "runnets": {
         "driver": "customAcp",
         "displayName": "Ocean",
         "config": { "cli": "runne acp" }
       }
     }
   }
   ```

2. **Any OpenAI-compatible endpoint** (`driver: "openai-compat"` with
   `config.url` / `config.apiKeyEnv` / `config.model`). Not implemented here.

Ocean implements shape 1: `runne acp` serves the runtime as an ACP agent.
The server running RunneBot must resolve `runne` and inherit
`DEEPSEEK_API_KEY` for model calls. For an uninstalled checkout, use an
absolute Node executable and built entry point in `config.cli`, for example:
`/absolute/path/node /absolute/path/Ocean/apps/cli/dist/main.js acp`.
Quote paths containing spaces. Run `pnpm build` before attaching.

The client probes the command with `--version`; the CLI recognizes this even
after `acp`. The custom driver uses the agent's default model and sends
`session/cancel` as a notification. Ocean accepts both notification and
request cancellation. The desktop token counter remains empty because
`PromptResult` does not expose usage; token usage is committed to TaskRun
budgets internally. `RUNNE_DB` optionally preserves those committed streams,
not the ACP session or conversation. See [SQLite storage](sqlite.md).

## ACP surface the client actually calls

Inspected in the client's ACP driver (`server/drivers/acp/core.ts` in the
OpenMausBot lineage). Methods it sends to the agent:

| Method                                                            | Used for                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `initialize`                                                      | Handshake; reads `agentCapabilities`, `authMethods`, `models`            |
| `session/new`                                                     | Opens a session with `cwd` and `mcpServers`; reads `sessionId`, `models` |
| `session/prompt`                                                  | One turn; prompt is a list of content blocks                             |
| `session/cancel`                                                  | Cancels the in-flight turn                                               |
| `session/load`, `session/resume`                                  | Only when advertised in `agentCapabilities.loadSession`                  |
| `session/set_model`, `session/set_config_option`, `session/close` | Only when advertised in `agentCapabilities.sessionCapabilities`          |

Notifications the agent sends: `session/update` with `agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`,
`config_option_update`, `current_mode_update`.

Requests the agent may send to the client: `session/request_permission`
(approval cards) and `fs/read_text_file` / `fs/write_text_file` (only when the
client advertises the matching `clientCapabilities.fs` flags).

Wire types for this surface live in [`@runnets/contracts`](../../packages/contracts/src/acp.ts).
A protocol or schema change there is a breaking change for out-of-repo clients.

## What Ocean implements today

| Capability                                                                                          | Status                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `initialize` (protocol v1, capability advertisement, model catalog)                                 | Implemented                                      |
| `session/new` (one session = one conversation; opens its first `TaskRun`)                           | Implemented                                      |
| `session/prompt` (one prompt = one turn; each turn runs in its own `TaskRun`)                       | Implemented                                      |
| Streaming: `agent_message_chunk`, `agent_thought_chunk`, `current_mode_update`                      | Implemented                                      |
| Model calls through `@runnets/provider-deepseek` when `DEEPSEEK_API_KEY` is set                     | Implemented (DeepSeek chat completions over SSE) |
| Usage settlement into the `TaskRun` budget (`attempt.usage_recorded`; overrun → `budget_exhausted`) | Implemented                                      |
| `session/cancel` (aborts the stream, then two-phase cancellation)                                   | Implemented                                      |
| Tool calls and `session/request_permission`                                                         | Implemented                                      |
| `fs/*`, session load/resume/close, config options                                                   | Not implemented                                  |

Without `DEEPSEEK_API_KEY` a prompt still runs the full domain lifecycle
(admit → schedule → start attempt → complete) and answers with a deterministic
message, so the handshake is testable offline. With a key, the turn streams the
model reply, records token usage, and turns provider failures into a `Fail`
command with a normalized provider error code; the prompt then returns
`refusal`. Cancellation returns `cancelled` after `RequestCancel` +
`CompleteCleanup`.

Known limits of the turn today:

- Text, reasoning and tool updates are surfaced. File tools execute inside
  the selected local workspace; commands require client permission.
  See [Coding agent](coding-agent.md) for limits.
- `provider_cost_usd` is not charged because there is no pricing snapshot; only
  `provider_tokens` is settled.
- Conversation history is kept in process memory; a restart loses it.
- A prompt that completes without provider usage evidence fails the run rather
  than claiming success (ADR-0012).

## Verifying the seam

Build with `pnpm build`, then start `node apps/cli/dist/main.js acp`.
Send each JSON-RPC frame as one line, waiting for the response before the next:

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp"}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s_0001","prompt":[{"type":"text","text":"hi"}]}}
```

Use the `sessionId` returned by `session/new` (a retained database can advance
its suffix). Keep stdin open until the prompt response arrives. Closing stdin
begins shutdown: active providers are aborted, queued turns are rejected, and
cancellation settles before the SQLite connection closes.

`apps/cli/src/acp/agent.test.ts` and `agent-provider.test.ts` drive the same
frames over in-memory streams and assert the handshake, session creation,
streaming updates, usage settlement, failure and cancellation. The engine
itself is covered by `apps/cli/src/engine/turn.test.ts` against a scripted
provider.
