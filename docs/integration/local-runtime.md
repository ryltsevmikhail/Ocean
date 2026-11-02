# Local runtime lifecycle and durable turns

One foreground Linux process owns the canonical private profile, SQLite recovery
and the provider for shared room turns. Authenticated clients can submit a turn
and look up its receipt or current run state. The standard room TUI, desktop,
run event observation and owner decisions are future delivery stages.
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

Stop refuses submissions with `runtime_draining`, signals active controllers,
and waits for their execution promises and any additional host drain. Uncertain
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
`capabilities:["status","stop","turns.submit","receipts.get","runs.get"]`. Subsequent `status` and `stop` accept empty
params. Responses are `{id,result}` or `{id,error:{code}}`. Unknown methods refuse;
there are no placeholder handlers for future methods. Wrong authentication,
profile and instance return `authentication_failed`; incompatible protocol returns
`protocol_mismatch`; requests before hello return `authentication_required`.

Each frame is at most 2MiB excluding the newline. Invalid request envelopes,
malformed/invalid UTF-8 and oversized frames terminate that connection; later
coalesced requests on a rejected stream cannot execute. The server bounds connections to 64,
requires hello within five seconds and drops observers whose pending output
exceeds 2MiB. The Node client bounds pending requests to 128 with five-second
transport timeouts (30 seconds for stop). Contract limits of 200 items per page and 30-second waits are
reserved for later methods; lifecycle has no lists or waits. No peer-credential
API is claimed: filesystem privacy plus the random capability provide the local
boundary. Same-UID processes with access to those credentials are trusted.

## Submitting and reconnecting

| Method         | Parameters                                                       | Result                                                                                       |
| -------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `turns.submit` | `workspaceId, roomId, requestId, text` and optional `to, taskId` | Stable `{workspaceId, roomId, requestId, messageId, turnId, runId}`                          |
| `receipts.get` | `workspaceId, roomId, requestId`                                 | Original admission identity, or `null`                                                       |
| `runs.get`     | `workspaceId, roomId, runId`                                     | Receipt identity, `performerId, turnStatus, taskStatus, version, resultMessageId`, or `null` |

Node clients call `submit`, `getReceipt` and `getRun` respectively. All three
methods reject extra parameters. The submitting client retains the exact request
and its ID until it can confirm the acknowledgement. After a dropped response,
read the scoped receipt or retry the exact request. Its original message and run
identities survive reconnect and recovery. Changing the bound workspace, room,
text, recipient or task returns `request_conflict`. A missing or differently
scoped lookup returns `null`. An unaddressed group post commits a message with
both `turnId` and `runId` null.

Submission commits before execution. Each fresh addressed turn gets one
runtime-owned controller and completion promise. Duplicate submissions observe
the existing receipt. Task-bound submissions require a coding adapter supplied
by the trusted host. The foreground command currently refuses a fresh
task-bound submit with `invalid_input` until the runtime decision adapter ships.

Run reads expose `admitted_before_run` at version zero when a turn has been
accepted and its TaskRun has yet to be created. Recovery marks interrupted
acceptance failed, with `taskStatus: "not_created"` if the aggregate is absent.
An interrupted dispatch stays uncertain. A completed turn identifies its
committed history message via `resultMessageId`. The existing publication path
can finish an exactly prepared answer during recovery. None of these reads
dispatches a provider or resumes an effect. Full history, result/event
observation and explicit run cancellation are planned for Task 3.

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
