# Local runtime lifecycle, durable turns and owner decisions

One foreground Linux process owns the canonical private profile, SQLite recovery
and the provider for shared room turns. Authenticated clients can submit a turn
and reconnect to its persisted room history, run events and result. Explicit
versioned cancellation is available to authenticated clients. The standard room
TUI and desktop migrations remain future delivery stages. The runtime also serves
exact coding approvals and text-only room review decisions.
Existing CLI room commands still open the profile directly and report
`owner_busy` while the shared runtime holds it. See the
[shared-runtime plan](../ocean/shared-runtime.md) for the migration sequence.

After initializing an isolated profile, run:

```sh
pnpm ocean runtime start --profile /absolute/private/profile --json
```

Start stays in the foreground and emits a ready status only after exclusive
SQLite ownership and existing conversation, coding-apply and effect-journal
recovery succeed. The foreground host resolves its provider from its own environment.
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

Each frame is at most 2MiB excluding the newline. Invalid request envelopes,
malformed/invalid UTF-8 and oversized frames terminate that connection; later
coalesced requests on a rejected stream cannot execute. The server bounds connections to 64,
requires hello within five seconds and drops observers whose pending output
exceeds one 2MiB frame plus its newline. The Node client bounds pending requests to 128 with five-second
transport timeouts (30 seconds for stop and the requested wait plus five seconds
for observation). No peer-credential
API is claimed: filesystem privacy plus the random capability provide the local
boundary. Same-UID processes with access to those credentials are trusted.

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

| Wire method         | Node client           | Parameters and result                                                                                                                                                                                                             |
| ------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisions.list`    | `listDecisions`       | Workspace and room, optional exclusive decision ID `after` and `limit` (default 50, maximum 200). Returns historical and pending card metadata.                                                                                   |
| `decisions.get`     | `getDecision`         | Workspace, room, run and decision ID. Returns kind, status, version, SHA-256 `bindingDigest`, creation and expiry in Unix milliseconds, and preview length in UTF-16 code units.                                                  |
| `decisions.preview` | `decisionPreview`     | Same reference plus a zero-based code-unit `offset` on the wire. Each response repeats the card and offset with up to 32768 code units of `text`. The SDK assembles the complete serialized JSON preview and verifies its digest. |
| `decisions.resolve` | `resolveDecision`     | Same reference plus `expectedVersion`, `bindingDigest` and `choice` (`allow-once`, `deny`, or `cancel`). Returns the persisted winner.                                                                                            |
| `reviews.get`       | `reviewRoom`          | Workspace and room. The SDK reads the exact scoped snapshot in bounded chunks. Wire requests include `offset` and, on subsequent chunks, the opaque review `version`.                                                             |
| `reviews.continue`  | `requestContinuation` | Workspace, room, run, request ID, observed `reviewVersion` and nonempty `reason` (up to 2048 UTF-8 bytes). Creates or returns the bound continuation card. A competing request for the same held run returns `decision_pending`.  |
| `reviews.result`    | `continuationApplied` | Decision reference. Returns the bound reference and `applied`. The SDK returns the boolean backed by the exact committed acknowledgement receipt.                                                                                 |

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
Disconnecting an observer has no effect on the waiter.

SQLite schema 11 adds owner decisions alongside the existing coding grants and
journal. Startup retires orphaned pending cards. An allowed card records owner
consent. Coding still rechecks the binding, registered sandbox, task membership,
source and both leases before the approval transition and atomic consumption.
A typed admission refusal before sandbox launch can settle a failed turn after
the runtime verifies its committed phase. Unexpected qualification failures and
unresolved work retain the owner on incomplete stop. The existing claim precedes execution. Each durable runtime has a fresh approval
authority identity so previous allowed grants cannot be consumed after reopen.
A continuation requires the original review version and the existing atomic room
policy and receipt write. Use `continuationApplied` to distinguish an applied
continuation from consent interrupted before that commit. Acknowledgement keeps
the earlier outcome and billing unknown. No prior work is scheduled on reconnect
or recovery.

## Safety and qualification limits

Existing descriptor/socket entries, including stale, foreign and symlink paths,
are never automatically removed or stolen. A clean stop removes only its pinned
owned descriptor and socket; foreign descriptor replacement is preserved. Node
closes and unlinks Unix listener paths, so a replaced socket causes incomplete
stop and retains the owner. Ownership is checked immediately before close;
concurrent same-UID filesystem mutation remains inside the trusted-process
boundary.

SIGKILL leaves stale endpoint evidence: status reports unreachable and a new
start refuses `endpoint_exists`. **Real crash restart and two-client reattachment
are still an open lifecycle acceptance gate.** No manual deletion is counted as
restart qualification. Safe predecessor reclamation or an explicit verified
maintenance procedure must be delivered before that acceptance gate closes.

The Linux process suite exercises separate owner/status/stop processes, second
owner refusal, recovery before ready, clean restart, SIGTERM, SIGKILL stale refusal,
uncertain drain and foreign-socket preservation. Socket tests cover two clients,
authentication/profile/version/instance binding, modes, symlinks, short fallback,
fragmentation, oversized frames and foreign descriptor preservation. Separate owner and client processes use a gated synthetic provider
and a persisted dispatch counter to verify detach, retry, single publication,
provider failure and incomplete stop. Separate SIGKILL tests reopen the
application database twice at admission and after an effect claim. These qualify
local persistence and headless process behavior. Standard TUI, desktop
shared-runtime, live provider and full Ocean 1.1 acceptance gates remain open.
