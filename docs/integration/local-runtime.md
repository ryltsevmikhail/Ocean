# Local runtime lifecycle, durable turns and owner decisions

One foreground Linux process owns the canonical private profile, SQLite recovery
and the provider for shared room turns. Authenticated clients can submit a turn
and reconnect to its persisted room history, run events and result. Explicit
versioned cancellation is available to authenticated clients. The standard room TUI connects to this runtime. The in-repository Electron Desktop connects through the same authenticated SDK. The runtime also serves
exact coding approvals and text-only room review decisions.
Profile commands connect to the published owner. The supported operations and maintenance refusals are listed below. See the
[shared-runtime plan](../ocean/shared-runtime.md) for the migration sequence.

After initializing an isolated profile, run:

```sh
pnpm ocean runtime start --profile /absolute/private/profile --json
```

Start stays in the foreground and emits a ready status only after exclusive
SQLite ownership and existing conversation, coding-apply and effect-journal
recovery succeed. Starting the Linux owner requires the system Python 3 interpreter at
`/usr/bin/python3` for its socket bootstrap. Missing bootstrap support refuses
startup with `endpoint_verification_unavailable`. The foreground host resolves its provider from its own environment.
A synthetic or disabled provider can be injected by host composition. A
restored profile, including a dangling restore-guard symlink, refuses
`restore_restricted` before publishing an endpoint;
existing offline restored reads and freshly confirmed text-only behavior are
unchanged.

In separate terminals:

```sh
pnpm ocean runtime status --profile /absolute/private/profile --json
pnpm ocean runtime stop --profile /absolute/private/profile --json
```

Status and stop authenticate through the socket without opening SQLite. Success
returns the existing CLI envelope `{version:1,ok:true,data:...}`. Status includes
protocol, canonical profile identity, instance identity, capabilities and state.
Stop returns `state: "stopped", outcome: "complete"` only after settlement and
runtime close. Closing a client merely detaches it. SIGINT and SIGTERM request
the same shutdown as explicit stop.

Stop signals active controllers and waits for their execution promises and any
additional host drain. During draining or an incomplete stop, exact retries
return the original receipt and changed bindings return `request_conflict`.
Fresh submissions return `runtime_draining` before any admission write. Uncertain
settlement from work started by this process, a rejected drain, or the default
29-second deadline returns `state: "stop_incomplete", outcome: "uncertain"`.
The owner and listening endpoint stay available for status and reads. Repeated
stop requests observe the retained outcome. Uncertainty recovered from an
earlier process remains in durable room/run state and cannot authorize replay.

Clients receive exit 4 for an incomplete stop. `owner_busy`, `runtime_absent`,
`runtime_unreachable` and `endpoint_exists` use exit 3. Other invalid input or
security refusals use exit 2, except inherited `restore_restricted` (exit 4).

## Profile CLI while the owner is listening

Use the same canonical profile and runtime directory in each terminal. The CLI authenticates before selecting a profile operation. A missing descriptor beside other entries, unreachable socket, incompatible identity/protocol, failed authentication or insecure paths refuse the command. Only a locally verified absent publication permits offline one-shot operation. The exclusive SQLite ownership transaction also checks for a surviving publication digest before taking ownership for offline recovery. Erasing the runtime directory after a crash cannot authorize a takeover. Ordinary runtime start uses its separate attested recovery procedure.

| CLI command                                                                                            | Authenticated owner operation                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot add/list`                                                                                         | `bots.create` binds the complete bot profile and request ID. `bots.list` pages by bot ID.                                                                                                                                                                                                   |
| `room direct/group/list/members`                                                                       | `rooms.direct` and `rooms.group` bind stable bot IDs. Lists use `rooms.list`, `rooms.members` and bounded bot profiles.                                                                                                                                                                     |
| `history ROOM`                                                                                         | `history.list` reads a sequence page in the requested room, default 50 entries.                                                                                                                                                                                                             |
| `send ROOM --text TEXT [--task TASK] [--request-id ID]`                                                | `turns.submit` commits before acknowledgement. Only the owner supplies the execution provider.                                                                                                                                                                                              |
| `run list/show/review`                                                                                 | The CLI uses room and run projections. Show returns the durable run snapshot. Review uses `reviews.get` with the exact run ID and returns the review version and scoped effects.                                                                                                            |
| `run acknowledge RUN --text-only --review-version VERSION --reason REASON`                             | A terminal obtains the server's `reviews.continue` card, verifies its entire preview, shows escaped controls and asks for an explicit vote. Version, digest, expiry, room and run still bind the decision. `continuationApplied` reports whether the owner also committed the continuation. |
| `coding show/diff/pending/inspect-apply`                                                               | `coding.show`, `coding.diff`, `coding.pending` and `coding.inspect-apply` provide read-only projections.                                                                                                                                                                                    |
| `init`, `project add`, `coding start/review/apply/reconcile-apply`, `backup`, `restore`, full `doctor` | Exit 3 with `maintenance_required`. Stop the runtime explicitly to perform the offline operation.                                                                                                                                                                                           |
| `doctor --static`                                                                                      | Checks platform and profile metadata without opening SQLite. Its database status is `not_inspected`.                                                                                                                                                                                        |

Run IDs are resolved against committed room-run associations in the bound workspace. Add `--room ROOM` to narrow a run or coding query. Coding views derive the task's owner room and membership from durable task and application records. A mismatched room refuses a single-task or application inspection. The complete frozen `coding.diff` preview includes file modes, hashes, diff and registered test bindings. It writes no changeset artifact or capture receipt. Review and apply continue to require the separately captured immutable artifact. The active `coding.pending` projection labels its scope as `coding_applications` and includes `omittedPendingEffects`. This counts unresolved effects outside the named applications, including unattributable legacy claims. Their identities remain private. A full diagnostic is available with the authorized offline command. Reading a projection cannot clear a hold.

Bot and room mutation parameters contain the workspace ID and a request ID, plus the bot profile, direct bot ID or group title and bot IDs respectively. Exact duplicates return their committed result during drain. Fresh mutations refuse `runtime_draining`. Lists page at up to 200 entries and may end a frame early. A client advances the cursor until it receives an empty page. The three single coding views accept `workspaceId, id`, an optional `roomId` and the same offset/version chunk sequence used by the coding panel. Each view binds the method, scope and complete digest to one client connection. Pending accepts `workspaceId`, optional `roomId`, and page parameters.

Active send exits 0 immediately with the version-1 success envelope. Its data includes `requestId`, `messageId`, `turnId`, nullable `runId` and status `admitted` or `recorded`. An unaddressed group post has null turn and run IDs. The exit acknowledges durable acceptance. To inspect execution later, use `run show`, `run review` or `history`. Exact retries return the same receipt without redispatch. An interrupted CLI awaiting acknowledgement emits `receipt_unknown` with the request ID and exits 130 for SIGINT or 143 for SIGTERM. Losing the response to an outstanding submit exits 3 with the same guidance. Read the receipt, or retry the identical payload with **the same request ID**. The CLI never retries on its own. Signal and disconnect detach the client. Explicit version-bound `runs.cancel` remains separate. With verified absence, the legacy offline send waits and signals its own one-shot operation.

ACP remains a separate stdio host. A competing ACP process using the same SQLite profile exits 3 with `owner_busy` on stderr before accepting requests. After a listener crash, the surviving publication refuses ACP and other legacy `RUNNE_DB` hosts with `endpoint_exists` (exit 3) before recovery. Restart the shared runtime to validate the prior publication. A separate profile keeps ACP 1 initialize, session, prompt, updates, permission and cancel behavior. ACP does not advertise shared-room methods.

## Room terminal

Create the room with the CLI before or after starting the runtime. Keep the foreground owner running and open another terminal using the same profile and runtime directory.

```sh
pnpm ocean tui --profile /absolute/private/profile --room ROOM_ID
pnpm ocean tui --profile /absolute/private/profile --room ROOM_ID --task TASK_ID
```

The header uses room members and the admitted performer. Enter submits a message. In a group, a leading `@handle` addresses one bot. Unaddressed posts have a message receipt and no run. The TUI immediately displays the confirmed message and admitted run IDs. Room reads continue separately. Until the corresponding history and run are observed, repeating the same input shows the retained receipt and Enter keeps a different message in the editor. Press Enter again after history updates to send that draft. A read error is displayed beside that receipt while the client retries observation. An idle terminal reauthenticates and resynchronizes after a runtime instance change. F2 selects a run, F3 shows scoped event names and sequence numbers, and F4 shows the run version, performer, result ID and pending decision IDs. The dialogue follows committed room history, including posts from other clients.

`/quit`, EOF, terminal hangup and SIGTERM detach. Escape in the dialogue or Ctrl+C on a selected active run requests version-bound cancellation when the status row shows its complete run ID and bracketed version. Enlarge a compact or clipped terminal to reveal the binding. The receipt confirms the request. Run and turn state report eventual settlement. Escape in a panel closes it. Closing the client during an owner decision leaves the decision pending. The legacy standalone `tui` without `--room` retains its embedded execution lifecycle.

A living client retries a lost submission acknowledgement with the original request ID and exact payload. A malformed acknowledgement holds that binding for an explicit retry of the original text. Opening a new terminal reads committed history and runs. A missing runtime returns `runtime_absent` on an initialized profile. Authentication and protocol failures propagate.

A room decision displays its ID, version, status and expiry. Type `/decision ID` to inspect the complete escaped operation. Use at least 20 columns and 3 rows. Resizing resets page credit. The view renders non-ASCII operation content with reversible Unicode escapes. Page through the preview before pressing `y` for one approval, or press `n` to deny. Another client's vote updates the card. For interrupted work, `/review` reads a scoped snapshot and `/continue text-only <reason>` requests a decision bound to that exact version. The applied receipt confirms the future text-only policy.

F6 in a task-bound room requests `coding.panel` with workspace, room and task identifiers. The runtime checks the owning room, registered task and leases and scans the worktree twice. The frozen view includes the changeset hash, base and tree, complete diff, available test hashes/output and stale-binding labels. F6 refreshes the view. It publishes no changeset or approval. Offline capture, review and apply continue to use stored artifacts. The SDK `codingPanel` verifies the scoped digest and complete bounded chunks (32768 UTF-16 code units per chunk, 16 MiB UTF-8 view and serialized evidence budget, also bounded to 16 Mi code units by the SDK). SQLite selects the most recent evidence per registered preset using an index and checks serialized size before returning its payload. The owner serves up to two concurrent scans and retains at most two multi-chunk views. An evicted view returns `stale_capture`.

Reproduce the terminal and opt-in native coding checks using synthetic profiles and providers.

```sh
pnpm build
pnpm exec vitest run apps/cli/src/ocean/room-tui-{process,reconnect,decisions,changeset}.test.ts
OCEAN_SANDBOX_NATIVE=1 pnpm exec vitest run apps/cli/src/ocean/room-tui-coding-native.test.ts
```

The Linux PTY driver requires Python 3. It starts the built CLI, submits, captures its run ID, physically closes the controlling PTY master while the provider waits, and separately checks raw-mode restoration after SIGTERM. An independent SDK process observes the running task and its single final result. Reopening the standard TUI reads the same committed answer. The persisted provider call count is one.

## Endpoint and independent clients

The canonical profile must be an owned 0700 directory without symlink ancestors.
Ancestors must be owned by the current UID or root, with no group/other write
permission unless sticky; trusted sticky `/tmp` remains supported. The existing
database privacy checks also apply. The profile identity is SHA-256
of that canonical absolute path; the runtime instance is a fresh UUID.

Endpoint discovery uses an owned 0700 `XDG_RUNTIME_DIR`, or an owned 0700
`/tmp/ocean-UID` fallback. An overlong XDG path selects the verified short fallback.
A profile-specific `ocean-<24 hex digits>` directory contains `runtime.sock` (0600)
and `connection.json` (0600). The descriptor is published without replacement,
after recovery and listening, and binds protocol 1, profile, instance, endpoint
and a fresh 256-bit capability. It is private credential material: do not print,
copy into transcripts, commit or expose it or the endpoint to model workers.
All clients must use the same runtime-directory environment.

The public Node client is exported by `@runnets/tools-node`:

```js
import { connectLocalRuntime } from '@runnets/tools-node';
const client = await connectLocalRuntime({ profile: '/absolute/private/profile' });
try {
  console.log(await client.status());
} finally {
  client.close();
}
```

The narrow public export `@runnets/tools-node/local-runtime-client` loads only SDK transports, validation and wire contracts. Electron main and the [standalone example](../../examples/local-runtime-client.mjs) use it. After `pnpm build`, each invocation below starts a fresh client process. Use a private test profile with an explicitly started owner and an existing direct room. Supply the operator's original request ID again to resume or explicitly retry an identical submission.

```sh
node examples/local-runtime-client.mjs "$profile" rooms
printf '%s\n' 'hello' | node examples/local-runtime-client.mjs "$profile" submit "$room" my-request
node examples/local-runtime-client.mjs "$profile" resume "$room" my-request
node examples/local-runtime-client.mjs "$profile" observe "$room" "$run"
node examples/local-runtime-client.mjs "$profile" result "$room" "$run"
node examples/local-runtime-client.mjs "$profile" history "$room"
node examples/local-runtime-client.mjs "$profile" decide "$room" "$run" "$decision"
```

Use the returned run ID and an existing pending operator decision for the last command. It prints the card and complete digest-verified operation with escaped controls, then reads an explicit vote. The runtime returns the persisted winner. The [Desktop integration guide](desktop-client.md) describes simultaneous GUI and TUI qualification.

A desktop or independent process can implement the same newline-delimited UTF-8
JSON framing using `@runnets/contracts` without importing application internals.
Each request is `{id,method,params}`, with a nonempty string ID up to 128
characters. First send `hello` with `protocol:1`, `profileId`, `instanceId` and
`capability` from the verified descriptor. Success returns identity plus
`capabilities`. Subsequent `status` and `stop` accept empty
params. Responses are `{id,result}` or `{id,error:{code}}`. Unknown methods refuse;
there are no placeholder handlers for future methods. Wrong authentication,
profile and instance return `authentication_failed`; incompatible protocol returns
`protocol_mismatch`; requests before hello return `authentication_required`.

**Raw v1 exchange.** These are newline-delimited request frames for an initialized direct room, followed by a separate pending decision in a task-bound room. Replace angle-bracket fields with the corresponding descriptor value or exact ID from the preceding response. Keep the capability private. The SDK reads and verifies the descriptor in memory.

```jsonl
{"id":"1","method":"hello","params":{"protocol":1,"profileId":"<profile hash>","instanceId":"<instance UUID>","capability":"<private capability>"}}
{"id":"2","method":"turns.submit","params":{"workspaceId":"ws_ocean","roomId":"<room>","requestId":"my-request","text":"hello"}}
{"id":"3","method":"receipts.get","params":{"workspaceId":"ws_ocean","roomId":"<room>","requestId":"my-request"}}
{"id":"4","method":"observe","params":{"workspaceId":"ws_ocean","roomId":"<room>","runId":"<admitted run>"}}
{"id":"5","method":"observe","params":{"workspaceId":"ws_ocean","roomId":"<room>","runId":"<admitted run>","cursor":"<cursor from 4>","waitMs":1000}}
{"id":"6","method":"runs.result","params":{"workspaceId":"ws_ocean","roomId":"<room>","runId":"<admitted run>"}}
{"id":"7","method":"history.list","params":{"workspaceId":"ws_ocean","roomId":"<room>","after":0,"limit":16}}
{"id":"8","method":"decisions.get","params":{"workspaceId":"ws_ocean","roomId":"<task room>","runId":"<task run>","decisionId":"<pending ID>"}}
{"id":"9","method":"decisions.preview","params":{"workspaceId":"ws_ocean","roomId":"<task room>","runId":"<task run>","decisionId":"<pending ID>","offset":0}}
{"id":"10","method":"decisions.resolve","params":{"workspaceId":"ws_ocean","roomId":"<task room>","runId":"<task run>","decisionId":"<pending ID>","expectedVersion":1,"bindingDigest":"<displayed digest>","choice":"deny"}}
```

Wait for each matching response. Frame 1 returns the authenticated profile, instance, protocol and supported method list. The two receipt responses have the following shape.

```jsonl
{"id":"2","result":{"workspaceId":"ws_ocean","roomId":"<room>","requestId":"my-request","messageId":"<message>","turnId":"<turn>","runId":"<admitted run>"}}
{"id":"3","result":{"workspaceId":"ws_ocean","roomId":"<room>","requestId":"my-request","messageId":"<message>","turnId":"<turn>","runId":"<admitted run>"}}
```

Frame 4 returns a scoped snapshot, signed cursor and room sequence. Frame 5 can return a change, resync or timeout. Frame 6 returns the scoped message (null before publication), and frame 7 returns sequence rows with UTF-8 bodies encoded as base64. Frames 8–9 carry the immutable operation's identity, version, expiry, digest and preview length. Repeat frame 9 at the next UTF-16 offset until the complete preview is available. Verify its SHA-256 and present it before the explicit operator vote. Frame 10 returns the persisted card and version, including a competing winner if another client already resolved it.

Each frame is at most 2MiB excluding the newline. Invalid request envelopes,
malformed/invalid UTF-8 and oversized frames terminate that connection; later
coalesced requests on a rejected stream cannot execute. The server bounds connections to 64,
requires hello within five seconds and drops observers whose pending output
exceeds one 2MiB frame plus its newline. The Node client bounds pending requests to 128 with five-second
transport timeouts (30 seconds for stop and the requested wait plus five seconds
for observation). Clients authenticate with the private filesystem descriptor
and its random capability. The bootstrap checks kernel peer credentials only
while verifying its own new listening socket. Same-UID processes with access to the private descriptor capability are trusted.

## Submitting and reconnecting

| Method         | Parameters                                                       | Result                                                                                       |
| -------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `turns.submit` | `workspaceId, roomId, requestId, text` and optional `to, taskId` | Stable `{workspaceId, roomId, requestId, messageId, turnId, runId}`                          |
| `receipts.get` | `workspaceId, roomId, requestId`                                 | Original admission identity, or `null`                                                       |
| `runs.get`     | `workspaceId, roomId, runId`                                     | Receipt identity, `performerId, turnStatus, taskStatus, version, resultMessageId`, or `null` |

Node clients call `submit`, `getReceipt` and `getRun` respectively. All three
methods reject extra parameters on both the client and the server. The Node SDK
validates its parameter snapshot before writing a frame. The submitting client retains the exact request
and its ID until it can confirm the acknowledgement. After a dropped response,
read the scoped receipt or retry the exact request. Its original message and run
identities survive reconnect and recovery. Changing the bound workspace, room,
text, recipient or task returns `request_conflict`. A missing or differently
scoped lookup returns `null`. An unaddressed group post commits a message with
both `turnId` and `runId` null.

Submission commits before execution. Each fresh addressed turn gets one
runtime-owned controller and completion promise. Duplicate submissions observe
the existing receipt. Task-bound submissions require a coding adapter supplied
by the trusted host. The foreground command uses the private registered project,
task policy, sandbox qualification and runtime owner decision adapter. A room
released for text-only continuation refuses fresh task-bound admission.

Run reads expose `admitted_before_run` at version zero when a turn has been
accepted and its TaskRun has yet to be created. Recovery marks interrupted
acceptance failed, with `taskStatus: "not_created"` if the aggregate is absent.
An interrupted dispatch stays uncertain. A completed turn identifies its
committed history message via `resultMessageId`. The existing publication path
can finish an exactly prepared answer during recovery. None of these reads
dispatches a provider or resumes an effect.

## Room queries, observation and cancellation

| Wire method     | Node method                 | Scope and result                                                                                                                                                                                                                                  |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rooms.list`    | `listRooms`                 | Workspace ID. Returns direct/group summaries ordered by room ID.                                                                                                                                                                                  |
| `rooms.members` | `listMembers`               | Workspace and room IDs. Returns room member IDs, names and handles in bot ID order.                                                                                                                                                               |
| `history.list`  | `history`                   | Workspace and room IDs. Returns committed messages in room sequence order.                                                                                                                                                                        |
| `runs.list`     | `listRuns`                  | Workspace and room IDs. Returns run snapshots in turn ID order.                                                                                                                                                                                   |
| `runs.events`   | `listEvents`                | Workspace, room and run IDs. Returns the bound scope and an `events` array of sequence, type and sensitivity. The SDK returns the array. Restricted events use type `redacted`. Event payloads, actors and private tool transcripts are excluded. |
| `runs.result`   | `getResult`                 | Workspace, room and run IDs. Returns the bound scope and `message`, containing the once-published bot reply or null. The SDK returns that message or null.                                                                                        |
| `observe`       | `observeRoom`, `observeRun` | Workspace and room IDs. Include run ID for a run snapshot. Optional opaque `cursor` and `waitMs`.                                                                                                                                                 |
| `runs.cancel`   | `cancelRun`                 | Workspace, room, run and request IDs and nonnegative `expectedVersion`. Returns the original bound request plus `version` and `status: "requested"`.                                                                                              |

List queries accept optional `limit` (default 50, range 1–200) and exclusive
`after`. For rooms and members, pass the last returned ID. For runs, pass the
last turn ID. For history and events, pass the last room sequence or run event
sequence, starting at zero. Continue until an empty page or the target
watermark. A byte-limited page can be short even when more rows follow.
Messages carry complete UTF-8 text in `bodyBase64` on the wire. The SDK
returns decoded `body`. Room and run lookups check the owning scope before
reading messages, events or results. Temporal positions beyond the head or
gaps within a returned page produce `resync_required`.

An initial observation returns `kind: "snapshot"`, workspace/room IDs,
`instanceId`, the committed `roomSeq` and an opaque cursor. Run observation
also includes `snapshot` with the performer, admission phase, TaskRun status
and version, result message ID and unexpired pending owner decision IDs
bound to the same workspace, room and run. Coding references also match the
performer and coding task. Room observation works for an empty room or an unaddressed group
post. Room observation also detects committed owner decision changes.

Supply the cursor again to check for changes or wait up to 30000 ms.
`changed` and `timeout` both include the current watermarks. `resync` supplies
a fresh snapshot when the cursor is unknown, belongs to another scope or
instance, or trails the head by more than one maximum page. On reconnect,
fetch committed history and events from your last consumed numeric positions.
Drain to the observed watermarks before treating them as consumed. If local
positions cannot be verified, rebuild the room from sequence zero. Results
reference the same bot message as history. Merge by message ID to display
each committed reply once. Observation never resubmits a turn.

The runtime polls committed state for up to four waiting calls per client
and 32 across the owner. Further waits return `observer_busy`. Disconnect
releases the waits. Observers receive committed snapshots and watermarks.
The runtime retains no token queue for them.

Explicit cancel requires a live execution owned by this runtime and a created
TaskRun. Unknown bindings return `unknown_run`. Previously unseen requests
against a recovered or settled turn return `run_not_active`. A live turn whose
aggregate has yet to be created returns `run_not_started`. A stale version of
a live run returns `version_conflict`. Exact retries replay the durable
receipt even after the run has advanced or settled. Reusing the command ID
with a different binding returns `request_conflict`. Cancel reads the bound
turn phase and event head separately from the observation snapshot. It remains
available when pending decision references exceed the observation page limit.
The runtime commits the
TaskRun cancellation command and its receipt before signalling the controller.
Terminal provider evidence and executor settlement determine the subsequent
run state. A lost stream can leave the run cancelling and the turn uncertain,
with no committed cleanup. Actual usage for the same active attempt still
settles during cancellation. An overrun commits the budget terminal event and
retains the cancellation cause. The effect and room uncertainty remain visible.

## Owner decisions and text-only continuation

Both clients authenticate with the existing private profile capability. The model
tool catalog contains project reads, exact writes and registered test presets.
Decision endpoints are available through the owner socket only. Closing a client
leaves a pending card available to other clients.

| Wire method         | Node client           | Parameters and result                                                                                                                                                                                                                                                                                                                           |
| ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisions.list`    | `listDecisions`       | Workspace and room, optional exclusive decision ID `after` and `limit` (default 50, maximum 200). Returns historical and pending card metadata.                                                                                                                                                                                                 |
| `decisions.get`     | `getDecision`         | Workspace, room, run and decision ID. Returns kind, status, version, SHA-256 `bindingDigest`, creation and expiry in Unix milliseconds, and preview length in UTF-16 code units.                                                                                                                                                                |
| `decisions.preview` | `decisionPreview`     | Same reference plus a zero-based code-unit `offset` on the wire. Each response repeats the card and offset with up to 32768 code units of `text`. The SDK assembles the complete serialized JSON preview and verifies its digest.                                                                                                               |
| `decisions.resolve` | `resolveDecision`     | Same reference plus `expectedVersion`, `bindingDigest` and `choice` (`allow-once`, `deny`, or `cancel`). Returns the persisted winner.                                                                                                                                                                                                          |
| `reviews.get`       | `reviewRoom`          | Workspace and room. The SDK reads the exact scoped snapshot in bounded chunks. Wire requests include `offset` and, on subsequent chunks, the opaque review `version`.                                                                                                                                                                           |
| `reviews.continue`  | `requestContinuation` | Workspace, room, run, request ID, observed `reviewVersion` and nonempty `reason` (up to 2048 UTF-8 bytes). Creates or returns the bound continuation card. The request ID is reserved atomically with the card and conflicts with reuse by other conversation operations. A competing request for the same held run returns `decision_pending`. |
| `reviews.result`    | `continuationApplied` | Decision reference. Returns the bound reference and `applied`. The SDK returns the boolean backed by the exact committed acknowledgement receipt.                                                                                                                                                                                               |

Review, display the full card, then resolve its ID, version and digest. A coding
card contains the exact operation preview and its workspace, room, bot, task,
project, worktree, run, attempt, invocation, policy, limits, toolchain, operation
and source hashes. A review card contains the original scoped snapshot, reason,
request ID and `text_only` mode. JSON escaping preserves exact content. Render
untrusted text safely in the client. The owner retains the full underlying
review version, including global journal evidence. Remote review exposes a
global count, an opaque version and effects scoped to this run. Any change to
the global version invalidates a pending confirmation.

A pending card starts at version 1. A single conditional update commits version
2 before waking the operation. Terminal outcomes are `allowed`, `denied`,
`cancelled`, `expired`, `invalidated` or `interrupted`. A stale version against
a pending card returns `version_conflict`. A matching digest against a resolved
card returns its current state. A different digest returns `binding_conflict`.
The runtime clock enforces the existing 300000 ms lifetime and refuses a clock
earlier than creation. Explicit operation cancellation wakes a pending waiter.
Disconnecting an observer has no effect on the waiter. If the decision write fails, the runtime holds the run, refuses further grants for it and retains profile ownership on incomplete stop. An operator can still read the durable decision.

SQLite schema 11 adds owner decisions alongside the existing coding grants and
journal. Startup retires orphaned pending cards. An allowed card records owner
consent. Coding still rechecks the binding, registered sandbox, task membership,
source and both leases before the approval transition and atomic consumption.
The registered adapter prepares mountpoints at setup and inspects existing targets read-only during a vote and consumption. Custom host sandbox setup must provide a separate read-only inspector to authorize a mutation. A missing inspector refuses the operation.
A typed admission refusal before sandbox launch can settle a failed turn after
the runtime verifies its committed phase. Unexpected qualification failures and
unresolved work retain the owner on incomplete stop. The existing claim precedes execution. Each durable runtime has a fresh approval
authority identity so previous allowed grants cannot be consumed after reopen.
A losing or concurrent resolver reads the same committed owner fact even if acknowledgement later refuses changed evidence. A continuation requires the original review version and the existing atomic room
policy and receipt write. Use `continuationApplied` to distinguish an applied
continuation from consent interrupted before that commit. Acknowledgement keeps
the earlier outcome and billing unknown. An original schema-11 card created before receipt reservations still occupies its request key. Lookup preserves that key without writing a new receipt or applying an old vote. No prior work is scheduled on reconnect
or recovery.

## Safety and qualification limits

After SIGKILL of a ready listener, run the ordinary foreground start again with
the same profile and runtime directory. Until then, status reports
`runtime_unreachable`. Start first acquires the existing exclusive SQLite owner
and completes application recovery. SQLite table `local_endpoint_v1` holds one
SHA-256 digest of the last published binding. It covers the boot, mount namespace,
canonical profile and endpoint directory, profile/database/root/directory
identities, socket and descriptor identities and exact private descriptor bytes.
SQLite stores only the digest. The runtime pins the two entries, verifies their
types, ownership, permissions, mount IDs, identity and digest, and requires
`ECONNREFUSED` from the pinned socket inode. It verifies the complete binding
again after the asynchronous probe before retiring the prior names. The owner
fsyncs the endpoint directory and clears the matching SQLite proof.

The stable `runtime.sock` and descriptor layout preserve protocol-1 clients and
the short path limit. The Linux bootstrap runs `/usr/bin/python3 -I -S` with a
fixed standard-library program, an inherited private directory FD and an empty
application environment. It binds the listener under a private umask and opens
a nonfollowing filesystem pin. A local probe reserves a unique abstract Unix
socket address with embedded NULs and 32 random bytes. It connects through the
pin. The listening FD itself accepts the connection. While the probe still
holds the address, the bootstrap compares every byte of the kernel-reported
peer address to the reserved address. Abstract names are scoped to a network
namespace. A foreign process in another namespace can copy those bytes.
The bootstrap also reads Linux `SO_PEERCRED` from both its connected probe and
the socket accepted by its listener. It checks the exact native credential
layout. Both kernel-reported PID, effective UID and effective GID tuples must
match the still-running bootstrap, which created one listener and one probe in
the same namespace. Linux translates peer IDs into the receiver's namespaces.
These checks use the live socket FDs while the probe retains its address.
No proof payload is sent through the stream.

The bootstrap execs the host Node binary with the same listening FD and
filesystem pin. Node adopts that FD with `server.listen({fd})` and transfers
the server and pinned identity over private IPC. The owner independently pins
the named inode, verifies the identity, acknowledges and waits for helper exit
before chmod or publication. The probe connect and accept have one-second
timeouts. The bootstrap has a five-second alarm and the owner enforces a
5.5-second deadline. Closing a transferred server cannot unlink a pathname.
The helper receives no connection capability. Only the long-lived owner opens
SQLite, authenticates clients and serves requests.

The SQLite digest includes a format tag for the two-direction credential check.
Earlier digests based on a stream challenge or an abstract peer address alone
cannot authorize retirement. Stop a running older owner cleanly before switching
implementations. The public version-1 descriptor and client handshake are
unchanged.

Start publishes a freshly generated descriptor using a synced exclusive
temporary file and a no-replace hard link. It removes the temporary link,
fsyncs the directory, commits the binding digest and rechecks it before service.
Clients reconnect with a new handshake. An old instance cursor yields a
`resync` snapshot. The persisted receipt, run, event positions and room hold
survive. An interrupted external effect remains uncertain. Restarting leaves
old approvals inert and provides no evidence of descendant termination.

Automatic restart accepts an empty directory with no active proof, or the
entire exact attested predecessor after recovery and a definitive refused
connection. A live owner or listener, an older unregistered stale endpoint,
missing or extra entries, changed content/permissions/UID, symlinks, special
files, mount changes or a substituted directory refuse takeover. A crash
during retirement, bind or link can leave a partial layout that refuses the next
start. After durable publication the complete new layout is recoverable even
if the foreground ready message was lost. A reboot or erased runtime directory
with an outstanding proof requires separate maintenance. There is no force
takeover command. On clean stop, a replaced descriptor is preserved. A replaced
socket or uncertain execution drain gives an incomplete stop and retains the
owner. Identity checks and filesystem mutations share the existing trusted
same-UID host boundary.

## Committed-source process qualification

On 2026-11-03 the clean Linux worktree at `f7dac84dd7cd227a0e93e528549ffda4a394b434` passed the four shared-runtime cases below. All clients used disposable profiles. The listening owners used deterministic providers. Independent Task 8 and whole shared-runtime reviews are pending. Installed Ocean 1.1, complete backup/restore, physical Desktop picker/clipboard and a live-provider release candidate have separate gates.

1. **Room TUI detach.** The standard CLI ran under a controlling PTY. After the terminal displayed its run ID, the driver closed the master or sent SIGTERM. A new SDK process observed the same running turn before the provider was released. Reopening the TUI read one committed answer. For physical hangup the receipt was `f4beaf3f-b6e6-4bf0-bf0d-2c840fe1b4ac`, user message `2d4d664eefa04632b8a85e3f731838bd`, run `tr_26affae000a74510aa11be7771f9be17`, answer `reply_26affae000a74510aa11be7771f9be17`. Each terminal case recorded one provider dispatch.
2. **Lost submit receipt.** The owner destroyed the socket before writing the committed receipt. Independent SDK processes read and retried request `submit`. Changes to text, recipient, task and room returned `request_conflict` on each side of SIGKILL and restart. The completed case kept user message `9b0e79c92f304c499586784d1c001bb3`, run `tr_78476e211e8547ada226f48b123eca2c`, one answer and original/successor dispatch counts 1/0. An independently gated case exposed `admitted_before_run` at version 0. After restart its receipt still identified message `303993a8c3a6422ea06da85bd08d2d4b` and run `tr_bfd06906c3c94c9ea3680e54f4a5c225`. Its turn was failed, aggregate absent, result null and counts 0/0.
3. **One-use write.** Two SDK processes each read the same version-1 card and complete digest-verified preview before racing allow-once. Both read the persisted version-2 winner, including on an opposite stale vote. Pending version mismatch, foreign room/run and changed digest refused. Run `tr_d2cd096374894e1b9f4e3757a4426284` consumed write card `c6538ea2-109c-4517-9e5d-6a8380b6df3a`, digest `c9e566b5ab43ce5a640fcdca3e28673fc495612440391a2d9d89db036eb77bec`. The executor recorded one write. A second run advanced process-wide `Date.now` in the isolated fixture owner past expiry between card read and vote. Both clients read expired, the underlying grant was denied and the write counter stayed zero. The text-only review suite separately checked the exact continuation receipt.
4. **Unknown effect.** SIGKILL interrupted a real listener after its one-use journal claim and durable synthetic effect counter, before result settlement. Ordinary explicit start recovered profile evidence twice after SIGKILL and twice after clean stop. Two independent clients saw the original receipt and uncertain run on each new instance. Run `tr_14bbdfc5e1844f738747cb5f19d57a15` retained its single inbound message, pending effect, room hold and null result. On a separate first restart from the started claim, the instrumented successor for run `tr_33fd43c9b5ba4de69353fe39bfc03799` retained original dispatch/effect counts 1/1 and produced zero successor dispatches, including through retries. A fresh same-model control tripped that provider once. No cancellation event was added. The native write fixture separately killed a listening owner after its approved sandbox edit and before journal settlement. Owner exit supplies no evidence of descendant termination.

**Desktop.** Two actual `pnpm --filter @ocean/desktop start` launches used one isolated owner and Desktop store. Request `b6fe4bbe-89fa-4569-8b8a-6a749cccbd98` recovered message `bc7b3c40317d4249b436313c380c0a93` after a dropped acknowledgement. Run `tr_c8c744392a90477387f703ef66c7e191` yielded `reply_c8c744392a90477387f703ef66c7e191` with one provider dispatch. The independently launched public SDK and PTY observed the same live run while the first window closed. Reopening the standard app recovered exactly one result. Electron 45.2.1 (embedded Node 24.22.1) resolved only ten wire contract modules, seven SDK modules and four Node built-ins on the public client import.

**Reproduction.** Linux 7.2.8-9-omarchy x86_64, Node 26.13.0, pnpm 12.16.1, system Python 3.14.8, bubblewrap 0.13.1, systemd 262 and Wayland. From the committed workspace root, these commands exited 0.

```sh
pnpm install --frozen-lockfile --offline
pnpm build
pnpm check
pnpm format:check
pnpm exec vitest run --maxWorkers=2 apps/cli/src/acp/{agent,agent-provider,permissions,shutdown}.test.ts apps/cli/src/ocean/{room-tui-process,remote-command-process,remote-send-signal,remote-review-process,remote-offline-boundary,remote-coding-process,remote-hello-refusal,operations}.test.ts apps/cli/src/local-runtime/{admission-process,lost-receipt-process,restart-process,decision-process,process,restart-refusals,observation}.test.ts packages/tools-node/src/local-runtime-security.test.ts packages/application/src/coding-apply-recovery.test.ts
OCEAN_SANDBOX_NATIVE=1 pnpm exec vitest run --maxWorkers=1 apps/cli/src/local-runtime/{vote-process-native,decision-native,decision-crash,binder-netns-native,endpoint-native}.test.ts apps/cli/src/ocean/{room-tui-coding-native,remote-shutdown-native}.test.ts packages/tools-node/src/sandbox-native.test.ts
node --test apps/desktop/qa/window-close.test.mjs
pnpm --filter @ocean/desktop bundle
node apps/desktop/qa/entrypoint.mjs
node apps/desktop/qa/smoke.mjs
```

Clean root check passed 1,251 tests in 222 files, with 62 skipped. The development workspace included a separate atlas suite and passed 1,324 in 223 files with the same skips. The explicit process and access matrix passed 107 in 21 files. This includes the actual CLI and ACP stdio owner-busy exit 3, separate-profile session updates, exact review, stale endpoint refusal, bounded reads and observation backpressure. The opt-in native run passed 27 in 8 files, including journal recovery, foreign UID and mount refusal, live kernel socket attestation, sandbox containment and observable cgroup cleanup on supported paths.
