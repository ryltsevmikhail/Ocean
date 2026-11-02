# Terminal dialogue

```sh
node apps/cli/dist/main.js tui --cwd /absolute/path/project
```

With the CLI installed on PATH, `runne` opens the TUI in the current working
directory; `runne help` prints usage. `runne tui --cwd /absolute/path/project`
selects another workspace.

The main screen is one scrollable conversation with a bottom input. It starts
ready to type. User messages, assistant replies and compact tool status lines
remain together across continuation TaskRuns. Reasoning is hidden by default.
Full tool results and runtime events are available separately.

| Key                                            | Action                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Enter                                          | Send the draft; while busy, keep it for later                              |
| Ctrl+J or Alt+Enter                            | Insert a newline                                                           |
| Left/Right, Home/End, Ctrl+A/Ctrl+E, Backspace | Edit at the input cursor                                                   |
| PgUp/PgDn, Up/Down                             | Scroll without changing the draft                                          |
| Tab                                            | Switch focus between dialogue and input                                    |
| Home/End with dialogue focused                 | Jump to the oldest/latest page                                             |
| F1                                             | Open help                                                                  |
| F2                                             | Open tasks; arrows/j/k select, Enter returns, n starts an independent task |
| F3                                             | Open committed events and full tool output                                 |
| F4                                             | Open task details, workspace and budgets                                   |
| F5                                             | Show/hide reasoning                                                        |
| Esc in a panel                                 | Return to the dialogue without cancelling or discarding input              |
| Esc or Ctrl+C in the dialogue while busy       | Cancel the running turn                                                    |
| `/new`                                         | Start a blank independent conversation                                     |
| `/quit` or two idle Ctrl+C presses             | Exit                                                                       |

Bracketed paste inserts a draft, including its newlines, without submitting.
Input is capped at 2000 UTF-16 units, and the editor keeps the cursor visible
when it spans more than one row. Unicode characters split across input reads
are preserved. Navigation is measured in wrapped terminal rows.

At the live bottom, new output follows automatically. After scrolling up,
arriving output preserves the reading position. Returning to the bottom
resumes following. Opening panels preserves the draft and dialogue position.
The transcript retains up to 100 entries per conversation view; it is not a
persistent conversation store. Terminal cells are measured for common wide
characters and emoji; unusual terminal/font width rules may differ.

Committed task status, events and token usage refresh during execution.
The terminal writes only changed rows, batches input before painting, and
retains only the latest pending frame if output applies backpressure. Leaving
restores raw mode, wrapping, bracketed paste and alternate-scroll modes.

## Permission screen

File edits and commands open a dedicated preview before execution. `y` allows
once, `a` allows the same exact prepared operation until the session ends, `n` denies. Arrows or
PgUp/PgDn scroll; Home/End jump within the preview. Pasted text cannot grant
permission. Esc/Ctrl+C rejects and cancels the turn. Command approval grants
your OS user permissions; the workspace is not an OS sandbox.

No UI framework or terminal-rendering library is used. The host uses Node
streams, raw input and ANSI controls. If a terminal intercepts a function key,
configure it to send that key to the application. macOS may require Fn with
function/media keys; PgUp/PgDn are commonly Fn+Up/Fn+Down.

Interrupted durable tasks appear under F2 with their committed reconciliation
state. Their conversation history is unavailable and they cannot continue.
Use `/new` for a separate conversation; unresolved effects still block tools.
Native command results require reconciliation because Node cannot certify
process-tree termination. See [execution limits](coding-agent.md).
