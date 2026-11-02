# Coding agent

Ocean executes coding tasks through a bounded model/tool loop. The same turn
engine serves the CLI, TUI and ACP host. A final model response completes the
TaskRun; requesting an instrument alone does not count as success.

## Start

Build with `pnpm install --frozen-lockfile && pnpm build`. Supply
`DEEPSEEK_API_KEY` in the environment of the CLI process, without putting the
key in command history or project files.

```sh
node apps/cli/dist/main.js tui --cwd /absolute/path/project
node apps/cli/dist/main.js task --cwd /absolute/path/project "Fix the addition bug and run its tests"
```

TUI: type directly into the bottom input and press Enter to send. PgUp/PgDn
scroll the dialogue. F2 opens tasks, F3 events and tool output, F4 details;
Esc closes a panel. F5 reveals reasoning. See [TUI controls](tui.md).
At a permission screen: `y` allows once, `a` allows the same exact prepared operation
(kind, tool, arguments and preview) until this session ends, `n` denies. Arrows scroll the
complete preview. Esc/Ctrl+C cancels the turn, including pending permission.
The optional events panel displays full tool results; arrows scroll wrapped output.
The CLI asks the same approval questions in a terminal; redirected stdin
never grants edit or command permission. ACP uses `session/request_permission`
and denies missing, invalid or cancelled responses.

## Tools

| Tool           | Input                                     | Behavior                                                      |
| -------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `list_files`   | `path`                                    | List immediate directory children                             |
| `read_file`    | `path`, optional `start_line`, `end_line` | Numbered UTF-8 text, 1-based inclusive line range             |
| `write_file`   | `path`, `content`                         | Create or replace a file; existing content must first be read |
| `replace_text` | `path`, `old_text`, `new_text`            | Replace exactly one occurrence after a read                   |
| `run_command`  | `program`, `args`, `cwd`                  | Structured process invocation, no implicit shell              |

Paths are relative to the selected workspace (ACP uses `session/new.cwd`).
Files must be regular single-link UTF-8 files, at most 128 KiB. Symlinks,
parent traversal, absolute paths, `.git`, `.env*`, common credential files and
`node_modules` are excluded from file tools. Parent directories must exist;
creating directories is an approved command operation. Edits are prepared
before approval and compare the current content again before replacement.
These checks detect observed changes; they are not an atomic compare-and-swap
against an uncooperative concurrent writer. The write uses a synced temporary file and atomic rename; new files use an
exclusive link so an existing file is not silently overwritten.

Commands require approval even for tests and search. They run with the user's
OS permissions; **workspace path checks are not an OS sandbox**. An approved
program can access other directories or the network. Approve only trusted
commands and projects. Commands receive a small environment allowlist;
provider API keys are not inherited. Output is capped at 32 KiB and execution
at 60 seconds. Cancellation attempts SIGKILL on the process group and awaits
leader/pipe closure, with a bounded fallback. Neither SIGKILL, stdout closure nor
leader exit proves that all descendants stopped. The native Node backend marks
command results uncertain even after a zero leader exit code; the TaskRun stops
for reconciliation rather than reporting success or confirmed cancellation.
Programs can escape their process group. Linux is the target for contained
execution, but this repository currently has no qualified containment backend.
The same limitation applies on macOS and other operating systems.

`RUNNE_EXECUTION_MODE=contained` requests containment. A backend must explicitly
provide filesystem containment, process containment and confirmed tree-stop
capabilities; the Node backend declares all false and refuses execution.
The default `uncontained` mode requires normal user approval and makes no
containment claim. Permission review receives frozen metadata without an
execution function; approval cannot replace the prepared operation.

## Runtime behavior

Each model request settles token usage before admitting its tools. The next
request includes assistant tool calls, reasoning and correlated tool results.
At most 24 model requests run per user prompt. An interrupted remote stream does
not prove the provider stopped or billing ended: cancellation remains unknown
unless a positive terminal provider response establishes completion. Missing usage, malformed calls,
budget exhaustion and uncertain tool outcomes stop the turn. A denied tool is
returned to the model as an error; it is never executed.

With `RUNNE_DB=/absolute/path/runtime.sqlite`, the host records a durable,
request-bound tool claim before dispatch. The identity includes TaskRun and
attempt; a claimed identity never runs again. Failed settlement or interruption
leaves an unresolved claim. Reopening converts `started` to `uncertain` and
blocks new effects. Unknown tool outcomes leave the TaskRun `reconciling`, or
`cancelling` when cancellation was requested; they are not terminal failures or
confirmed cancellations. Read [SQLite storage](sqlite.md) for recovery diagnostics
and the explicit ephemeral/durable modes.

Conversation history (including tool results), approvals and read snapshots
are process-local. Restarting does not resume a coding conversation. SQLite
preserves TaskRun events, token usage and invocation claims. Cost accounting,
MCP, native OS isolation and desktop qualification remain outside this feature.
A model's final answer can still be mistaken: inspect the diff and actual
check results. The engine does not independently certify code correctness.

The deterministic `tui/coding.test.ts` drives read → edit → command → final
answer through the real DeepSeek SSE adapter and a fake HTTP/I/O backend.
Native filesystem/process behavior also requires a local smoke run; no live
provider availability is implied by offline tests.
