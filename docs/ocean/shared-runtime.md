# Shared local Ocean runtime

Status: authenticated lifecycle, durable turn admission and scoped receipt/run
reads, runtime observation, versioned explicit cancellation, durable coding decisions
and room-scoped text-only review continuation are implemented. The standard room TUI uses the runtime. CLI routing and Desktop migration remain planned. See [implemented commands, methods and limits](../integration/local-runtime.md).
Owner request on 2026-11-02 supersedes
continuing the remaining coding-backup work as the immediate priority. Ocean 1.1
stages 1–6 and reviewed stage-7 work through `5d032ae` remain implemented; their
remaining acceptance gates are not waived. Schedules and ScheduleOccurrence are
explicitly subsequent work.

## Delivery

One long-lived Linux process owns one canonical Ocean profile, SQLite recovery,
provider and active turns. The room TUI and desktop use the same versioned local
contract. Closing either client detaches it; only an explicit cancellation asks
the runtime to cancel a run. Runtime shutdown is a third operation. No new domain
engine, parallel receipt store or second effect executor is introduced.

The reference is Runne `b0e23ae6`: `LocalRuntimeProfile.connect()` in CLI exec,
submit acknowledgement with TaskRun identity, subsequent run polling, and
`RuntimeMode::ExternalLocal` in app-core/desktop. Ocean keeps its own TypeScript
layers, conversation model and recovery semantics rather than copying Rust APIs.

## Current evidence

- The standard room TUI connects to the authenticated endpoint. It retains a pending submission's exact payload and request ID in memory, observes room and run projections and restores committed room history on open. Its exit closes only its client.
- `DirectChatService.send` already calls atomic `admitChat`, with a durable
  request binding and receipt before `onAdmitted`. Identical request IDs observe
  the same turn; changed bindings fail. Legacy send waits for execution. The
  shared owner uses the synchronous submit receipt and supervises fresh execution.
- `createRuntime` owns SQLite and recovers chat publication, coding apply and the
  effect journal. Ownership must remain exclusive before exposing ready state.
- Coding approvals persist exact bindings, expire after 300000ms and atomically
  transition/consume. The shared host resolves an authenticated durable decision.
  The room TUI reads the complete server preview and submits the observed card version and binding.
- Normal Ocean commands open the profile themselves. Existing ACP has its own
  stdio lifecycle and must keep its advertised protocol and permissions.

## Process and access boundary

Commands: `ocean runtime start --profile PATH` runs in foreground until explicit
stop/signal; `ocean runtime status --profile PATH --json` verifies the handshake;
`ocean runtime stop --profile PATH` requests graceful shutdown. External process
management is supported; automatic spawning, bundled desktop lifecycle and
system-wide service installation are outside this first delivery.

Use a canonical private profile and a short Unix-socket path in an owned 0700
runtime directory under XDG_RUNTIME_DIR, or a verified private fallback. The
connection descriptor is 0600 and binds profile identity, protocol 1, runtime
instance, endpoint and a random authentication capability. Socket is 0600.
Check ownership/modes/nofollow/canonical bindings before connection/publication.
Never follow/remove arbitrary stale paths or rely on PID alone for takeover.
SQLite ownership is the authoritative single-owner guard. After recovery, ordinary
start may retire a dead predecessor's exact SQLite-attested files in the same
private layout. It pins and checks the file and mount identities, requires a
definitive refused connection, and rechecks the binding before retirement.
For fresh publication the Linux bootstrap requires `/usr/bin/python3` and verifies
the pinned socket using the exact peer address accepted by the listening FD and
the kernel peer credentials on both ends of the bootstrap's live connection.
Unattested or partial layouts refuse. Publish ready only after durable endpoint
publication. See the [lifecycle and refusal states](../integration/local-runtime.md#safety-and-qualification-limits).

Handshake authenticates the capability and exact profile/protocol before any
profile data or mutation. Reject another profile, incompatible version, insecure
path, malformed/oversized frames and missing credential. Where peer-credential
support is used it must be proven on Node/Linux, not assumed from the socket
path. Filesystem isolation plus the private capability are mandatory. Same-UID
host processes with access to owner credentials are trusted; model workers never
receive credentials or socket mounts. No arbitrary RPC shell, provider override,
filesystem path or user-supplied owner boolean is an authority grant.

Newline JSON protocol v1: request id + method + validated params; bounded
responses and stable error codes. Maximum frame 2MiB; history/run lists are
paginated (at most 200 items); bounded waits at most 30 seconds. No raw provider
secrets, private tool logs or unrelated room context in responses. Slow/disconnected
observers cannot block execution or create unbounded retained token queues.

## Client contract

Public DTOs in contracts are separate from ACP. Node client uses those DTOs;
a desktop may implement the documented framing without importing application.

- Handshake returns protocol, profile identity, instance identity and capabilities.
- Rooms/members/history and run lists are scoped to the requested workspace/room.
- Submit accepts requestId, workspaceId, roomId, text, optional recipient/taskId;
  never provider credentials or a caller's execution privileges. The durable
  acceptance returns the original receipt, turn/message identity and nullable
  runId (group messages without selected recipient are recorded without a run).
- Read receipt by requestId, and read run snapshot/result by runId. A just-admitted
  run may still be awaiting TaskRun creation; represent this explicitly, never
  mistake absent aggregate for no accepted work. Include turn/room/performer,
  committed state/version, result and pending-decision references.
- Observe from durable per-run event version and room history sequence. Notifications
  are wakeups; authoritative snapshots/events rebuild after loss, restart or cursor
  gap. Tokens may be transient and never mistaken for committed final history.
- Explicit cancellation binds command/request identity and expected run version;
  acceptance means requested, not proven stopped. Reconnect never resubmits a
  fresh send automatically. Persist/retain the original client requestId and exact
  payload through an uncertain acknowledgement, then read/retry the same identity.

Runtime owns execution controllers independently of connections. Admission is
synchronous/durable before receipt, then runtime-owned execution continues. Bind
fresh-only execution to the existing atomic receipt path; a duplicate never
schedules another provider call. Crash between admission and dispatch is recovered
without replaying uncertain work, using existing recovery rules.

## Decisions

Pending decisions belong to runtime durable state, not a TuiApp promise.
A versioned projection carries exact escaped preview, room/task/run/attempt/
invocation/binding identity, expiry and status. Authorized owner clients can list,
observe and decide by decisionId + expectedVersion + exact binding digest.
The server resolves its trusted owner adapter; clients cannot construct the
in-process owner port or widen operation permissions. Deny, expiry, changed
binding, restored profile and room mismatch retain existing refusal semantics.

Persist CAS of the decision before waking the waiting executor. Two clients may
show the same request, but only one pending transition wins; stale decisions
return current status/conflict and never create another grant. Consumption still
revalidates source/policy/lease and atomically claims the operation before effects.
Disconnect leaves a decision pending until expiry or explicit action. Runtime
restart does not revive allowed/consumed/restored decisions or retry an effect.
All existing coding and room-review owner prompts used by the room TUI must
have an explicit remote path; no hidden local approval callback fallback.

## CLI, ACP and shutdown

While runtime owns a profile, supported room/bot/history/send/run/coding commands
route through the client contract. Unsupported maintenance/profile mutations
(init, registry edits, backup/restore until runtime maintenance is implemented)
fail clearly with runtime_active/maintenance_required rather than opening another
runtime. When no runtime exists, legacy one-shot commands keep documented offline
behavior; room TUI requires explicit runtime start and never owns SQLite.
No failure to authenticate or negotiate may fall back to opening SQLite.

The v1 routing matrix is explicit:

| Command while runtime is active                                  | Behavior                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| bot add/list; room direct/group/list/members; history            | Same typed conversation operations through runtime                                             |
| send, including --task; run list/show/review                     | Runtime-owned admission and read projections                                                   |
| run acknowledge --text-only; TUI /review and /continue text-only | Runtime-owned exact review snapshot and durable owner decision                                 |
| coding show/diff/pending/inspect-apply; TUI F6                   | Read-only, room/task-authorized runtime queries                                                |
| coding start/review/apply/reconcile-apply; project add; init     | maintenance_required; explicitly stop runtime and use existing owner-confirmed offline command |
| backup/restore; doctor requiring ownership                       | maintenance_required; no second database owner                                                 |
| doctor static/profile checks                                     | Allowed only if they do not claim DB ownership or mutate profile                               |

Stopping runtime to perform an offline command must not discard an unknown effect
or bypass existing admission, lease or clean-checkout checks. A missing authenticated
runtime is distinct from an insecure/unreachable existing endpoint. Only verified
absence permits the documented offline path.

Runtime start on a restored profile refuses `restore_restricted` in this first
version, before provider dispatch or publishing a usable endpoint. The existing
offline restored-profile reads and freshly confirmed text-only access remain
unchanged. Serving restored profiles remotely is future work with server-enforced
restrictions; no client flag can override this startup refusal.

Existing ACP stdio remains compatible as a separate host; attempting to own the
same profile reports owner_busy without takeover. No promise of shared Ocean room
ACP sessions is added. A future ACP-to-shared-runtime bridge is separate work.

Graceful stop rejects new work, asks active executions to stop through existing
cancellation/supervision and waits for authoritative settlement before close.
Unknown cleanup stays uncertain; deadline produces an explicit incomplete stop,
not a claim of confirmed cancellation. SIGKILL recovery remains conservative.

## Desktop boundary

Ocean Desktop is now imported in this repository at `apps/desktop` from source
revision `1c8d8c3`. Its actual entry point is
`pnpm --filter @ocean/desktop start`; `src/host/main.ts` starts `worker.js` per
request and sends SIGINT to the active worker on window close. The worker invokes
this checkout's CLI. This imported behavior is implemented; the shared-runtime
migration remains proposed. Preserve the separate source checkout and installed
application.

Task 7 must qualify this in-repository entry point against the delivered endpoint
using an isolated profile and a deterministic provider. Currently no external
endpoint/profile configuration seam exists: replace worker-per-request ownership
with the authenticated client port before claiming GUI shared-runtime acceptance.
The attachment store is Desktop-local, room/message scoped; preserve its existing
import/preview/export/receipt semantics during migration. Providers currently
receive only bounded text excerpts and attachment descriptions. Asset-complete
backup is still an open gate: CLI profile backup excludes attachment bytes.

Always deliver an independent client-process example and E2E driver. GUI smoke of
the imported client and shared-runtime GUI acceptance have distinct evidence and
pass/fail status; a headless protocol test cannot prove GUI acceptance.

## Acceptance

1. Start runtime; use the standard room TUI to submit and see runId. Kill/detach
   TUI during a controlled provider generation. A separate client reconnects to
   that room/run and sees one committed answer; provider-call counter is exactly 1.
2. Drop transport after admission commit before receipt write. Same requestId and
   payload return the original runId; changed text/recipient/task/room refuse;
   provider counter remains 1. Include restart and admitted-before-TaskRun interval.
3. Two authenticated clients see one exact decision. First reply is persisted;
   second observes it. Simultaneous/stale/expired/wrong-room/version/binding replies
   cannot create another permission or effect; execution counter is at most 1.
4. SIGKILL runtime after durable external-effect start before result. Restart and
   attach two clients: both see uncertain status, unchanged execution count, no
   replay and no confirmed cancellation without evidence. Retain existing coding
   sandbox containment and recovery qualifications separately.

Run real separate OS processes and a PTY-driven standard TUI, with deterministic
provider/effect counters in synthetic fixtures, never live credentials. Document
commands, exit statuses and transcript/state evidence. Root check/build/format,
ACP compatibility, Linux socket/security, reconnect/backpressure and desktop-entry
results are required. Passing these gates does not close the remaining Ocean1.1
asset-complete backup/restore and live release RC gates.
