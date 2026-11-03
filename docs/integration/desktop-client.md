# Desktop clients and runtime integration

## In-repository Ocean Desktop

The Linux Electron/Vue client in `apps/desktop` shares the local runtime with the standard room TUI. Initialize the private profile and workspace with the CLI first. Start the foreground owner in one terminal, then launch Desktop in a second terminal with the same canonical profile and runtime directory.

```sh
pnpm ocean runtime start --profile /absolute/private/profile --json
# Another terminal
OCEAN_DESKTOP_PROFILE=/absolute/private/profile pnpm --filter @ocean/desktop start
```

For an isolated window, append `--user-data-dir=/absolute/private/desktop` to the start command. Without an override Desktop selects `<userData>/conversation/profile`, the profile path of the imported client. It connects only. An absent profile requires explicit CLI initialization, an absent owner requires explicit start, and authentication or endpoint errors are shown in the window. The provider configuration belongs to the foreground owner. The profile panel shows its authenticated profile hash, instance UUID, protocol and state.

The sandboxed renderer sends validated room and attachment commands to Electron main. Only the file-backed main frame of that window can invoke them. Main authenticates through the public `@runnets/tools-node/local-runtime-client` export and closes each bounded request connection when it finishes. Electron 45.2.1's embedded Node 24.22.1 was exercised with this client export on Linux. The owner and workspace build continue to use Node 26. The renderer receives no connection descriptor, provider configuration or arbitrary path/exec interface.

A send displays the durable message/run receipt as soon as the owner acknowledges it. A group note has no run. The window follows scoped room/run watermarks, pages committed history and runs using the authoritative turn ID (which need not match the run ID), and displays read failures separately from admission. An uncertain acknowledgement in a living window retains the original UUID, recipient, text and attachment IDs for the explicit retry button. Every automatic recovery success passes the original prepared content through binding-checked admission. The locally persisted prepared body permits an exact retry even when attachment bytes disappear. Missing or corrupt preparation evidence keeps the original UUID and draft unresolved; an identity-only owner receipt cannot establish content agreement. A local or owner binding conflict keeps that same pending command, including across later preparation failures. A first-attempt refusal such as `context_limit` leaves the draft and recipient editable. Reopening the room reads the owner's committed history and runs. Closing the window detaches. The cancel button identifies a run and version and requests cancellation against that binding. The run projection reports the actual outcome. Room tasks show performer and pending decision IDs. Inspect and vote on the complete operation in the room TUI or the public client example.

### Runtime-owned attachments

File selection, paste and drop retain four files of at most 10 MiB each. Electron
main uses the authenticated `DesktopAttachmentClient` for chunked import, exact
preparation and authorized reads. Runtime owns canonical blobs, metadata and
request receipts. Native image/text previews and save dialogs remain in the host;
exports use the exact bytes checked by the runtime/client digest path.

The original default and alternate stores are explicit migration sources. The
owner copies and verifies them into a new private profile store, then commits the
binding; original directories stay untouched and cannot become authority again.
Missing required data and unknown migration/preparation outcomes refuse. Relocating
the profile or changing an enrolled userData does not silently select another
store. See [Desktop ownership and capture](desktop-assets.md) for exact namespaces,
protocol and supported/refused legacy states. CLI format-1 backup refuses bound
Desktop assets; full format 2 and full restore remain open.

### Historical Linux GUI qualification (before 7.7)

```sh
pnpm build
pnpm --filter @ocean/desktop bundle
node apps/desktop/qa/smoke.mjs
node apps/desktop/qa/entrypoint.mjs
```

These historical results do not qualify the new runtime-owned asset layout. The scripts need separate requalification; no current installed or open Desktop was changed for 7.7. The Wayland drivers create private temporary userData, workspace, runtime directory and profile. The explicitly started owner uses a deterministic in-process HTTP replacement and a fixture-only key. The entrypoint driver launches the actual `pnpm --filter @ocean/desktop start` command twice. Only the disposable window enables a loopback debugging port. The driver drops a committed attachment-send acknowledgement, damages and removes the local attachment receipt while retaining the draft, then recovers the original admission from the restored frozen binding after local attachment bytes go missing, observes the same receipt from a separate SDK process and starts the standard room TUI in a PTY. It closes the window while generation waits, releases the provider and verifies one answer and one dispatch across clients and a reopened GUI. A separate GUI case fills room history, verifies a context refusal causes zero dispatches, then edits and submits a shorter turn. Transfer QA uses synthetic file inputs, paste/drop events and an intercepted save dialog, and compares the exported image and binary bytes. Physical OS clipboard, interactive file pickers, installed app and live providers require separate qualification.

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
