# Persistent direct chats (M2)

The CLI and TUI use the same application DirectChatService. Each addressed prompt
creates one durable chat turn and one TaskRun. The model context is rebuilt from
the selected direct room's user messages and published bot responses. Bot role
is a system message. Private reasoning and transient output are not replayed.

## Start from the checkout

Build once with `pnpm build`. Initialize a new persistent profile with an existing
workspace directory. These commands now work. Profile options may appear before
or after the command. RUNNE_DB and RUNNE_MODE must be unset when using Ocean profiles.

```sh
pnpm ocean init --workspace /absolute/project --profile /absolute/ocean-profile
pnpm ocean bot add --handle dev --name Developer --role "You are a developer." --profile /absolute/ocean-profile
pnpm ocean bot list --profile /absolute/ocean-profile
pnpm ocean room direct --bot dev --profile /absolute/ocean-profile
```

The last command prints `data.data.id` as the direct room ID. Use that ID in the
following commands. Export DEEPSEEK_API_KEY through your local secret setup.
The default provider is deepseek, default model deepseek-flash. Profiles can
store another model, but the configured adapter must advertise it.

```sh
pnpm ocean send ROOM_ID --text "The function is add." --request-id first --profile /absolute/ocean-profile --json
pnpm ocean history ROOM_ID --profile /absolute/ocean-profile
pnpm ocean tui --room ROOM_ID --profile /absolute/ocean-profile
```

Close the terminal and open the same profile and room again. The TUI immediately
renders its stored transcript. Enter sends another message, Esc or Ctrl+C
requests cancellation of the active turn, and /quit exits. In room mode /new
opens a new turn view within the same persistent room, retaining its history.
Only one process owns the profile at a time. Exit the TUI before using packet
CLI commands for that profile. The default profile is under
`$XDG_STATE_HOME/ocean`, falling back to `~/.local/state/ocean`.

## Persistence and retry behavior

M2 introduced schema 3. Current schema 4 preserves that data and adds [group rooms](group-chat.md), migrating schemas 1–3 transactionally. Existing profiles, rooms,
user records and receipts survive. Bot messages have their author and chat turn
identity. A unique room hold excludes overlapping execution; a unique publication
per turn prevents duplicate answers.

A send request binds its key to room, workspace and exact text before dispatch.
Repeat with the same request ID to inspect the existing outcome. A new request ID
authorizes a new paid request. Missing credentials or an unsupported profile
provider/model fail before writing the prompt. An interrupted or uncertain call
blocks new turns in that room for review. M4 will add the operator review flow.

Full validated model output is prepared durably after token settlement and before
TaskRun completion. Startup finishes local completion/publication before generic
task reconciliation. No provider call is replayed to reconstruct an answer.
Responses longer than the TaskRun summary retain their full text in the room.
An incomplete response never becomes a published answer.

The current room path is text-only and advertises no tools to the model. Existing
task/ACP execution paths retain their existing behavior. A conservative 64 KiB
UTF-8 local context ceiling rejects an oversized request explicitly, with no
silent truncation or automatic summarization. Model errors and unknown remote
cancellation remain visible as uncertainty. Streamed fragments are temporary.

## Validation

Offline tests exercise CLI→TUI continuity, restart context, exact-request retries,
room isolation, pre-dispatch cancellation, partial output, context overflow and
faults before TaskRun completion and bot-message publication. The actual DeepSeek
adapter is used by the host when credentials are configured. Live service
qualification is a separate RC activity.
