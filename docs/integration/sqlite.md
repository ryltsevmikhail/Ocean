# SQLite storage

`@runnets/store-sqlite` implements event, atomic command, checkpoint and tool
journal ports using `node:sqlite`. No external database or native npm module is
required.

```sh
RUNNE_MODE=durable RUNNE_DB=/absolute/path/runtime.sqlite runne
RUNNE_MODE=durable RUNNE_DB=/absolute/path/runtime.sqlite runne acp
RUNNE_DB=/absolute/path/runtime.sqlite runne status
```

Without a persistent `RUNNE_DB`, the default mode is ephemeral. Explicit
`RUNNE_MODE=durable` requires a persistent file; `:memory:` is insufficient.
Explicit ephemeral mode rejects a persistent path. The parent directory must
exist. Ephemeral state, receipts, conversation context and approvals disappear
when the process ends; ephemeral mode makes no crash-recovery promise.

## Commands and migration

File databases use WAL, synchronous FULL, foreign keys and a bounded busy wait.
The command port commits events and its request-bound receipt in one immediate
transaction. Duplicate commands return the original receipt before checking the
current aggregate version. Reusing an id with another task, actor, expected
version, type or payload returns an error. In-memory logs use the same semantics.

Schema 5 migrates versions 1–4 transactionally, retains conversation history and task records, and retains group rooms, shared messages and all effect claims. It adds audited text-only continuation references and room policies. See [recovery](recovery.md). See [group chats](group-chat.md). Migration refuses a live or unverifiable runtime owner. See [direct history](conversations.md). The legacy compatibility extensions still include a nullable `request_binding` receipt column,
`tool_invocations_v2`, ownership metadata and durable identity counters.
Existing rows remain intact. Old receipts without request bindings cannot prove
which request committed: retries fail closed rather than returning unverifiable
receipts. Legacy tool claims remain replay-blocking and appear in diagnostics.

Schema 19 is the durable Desktop identity capability boundary. Its transactional
schema migration preserves history, binding bytes and uncertain operation states;
filesystem anchoring is a separate exclusive-owner step. RC2 (schema 18) refuses
schema 19 before runtime ownership or execution. Ordinary supported-schema
inspection stays read-only. Public backup maintenance may atomically advance an
exact schema-18 Desktop binding and the capability version before freezing its
snapshot; it never rewrites immutable ready rebind lineage. See
[Desktop binding and legacy recovery](desktop-assets.md#durable-binding-in-the-stable-11-implementation).

The v2 journal binds a claim to TaskRun, attempt, invocation and request before
dispatch. Outcomes are `started`, `not_started`, `completed`, `failed` or
`uncertain`. Results/output are not saved in the journal. Tool request fingerprints are SHA-256 digests; raw tool arguments and outputs
are not persisted in the journal. Command request bindings and domain events
remain stored, so database access must be restricted like workspace access.
Never put credentials in tool arguments. A claimed identity never runs
again, even after settlement. Unresolved effects block new tool dispatches.

## Reconciliation and ownership

Durable hosts acquire exclusive process ownership before reconciliation and
await recovery before accepting turns. A live owner, permission error or
unverified PID prevents takeover. A stale PID may be replaced only after OS
liveness checks establish that its owner no longer exists. PID reuse can refuse
recovery conservatively; this is not proof that the owner's descendants stopped.
The ownership table assumes cooperating local hosts and is not a security boundary.

A `started` claim becomes `uncertain` after interruption. Nonterminal runs become
`reconciling`; `cancelling` stays pending without a cleanup event. No process or
model call is automatically replayed. `runne status [taskRunId]` displays retained
states and unresolved effect identities when no other host owns the database.
TUI exposes interrupted tasks through F2, ACP sends a warning in a fresh session,
and the task CLI prints a recovery notice.

Legacy task/ACP conversation history, sessions, approvals and read snapshots are process-local. Persistent Ocean rooms use [the M2 path](direct-chat.md).
They are not reconstructed from lifecycle events. Recovered tasks cannot accept
continuation with invented empty history. `/new` starts a separate conversation;
it does not clear unresolved effects. There is no mechanism to certify an unknown process tree stopped. Ocean room acknowledgement only permits new text-only messages and preserves uncertain effects.
Operator inspection is required; preserve the database for reconciliation.

## Checkpoints

`store.checkpoints.save(id, position, events)` saves a committed event prefix.
Positions are immutable. Recovery validates its boundary against the log and
replays the prefix plus tail; no snapshot means full replay. This optimization
is separate from execution reconciliation. Hosts do not schedule checkpoints.

Keep the database and WAL together for live backups, or close the runtime first.
Stored payloads and request bindings are not encrypted.
