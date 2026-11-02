# Architecture

RunneTS is an event-sourced TypeScript runtime with CLI, ACP and terminal hosts.
Rust Runne is reference material, not a crate layout to reproduce. The desktop
client is a separate project; this repository has no desktop or web UI dependencies.

## 1. State ownership

`TaskRunService` executes typed commands against committed aggregate versions.
The domain's `decide` produces events; adapters commit them, and `replay` derives
state. Hosts cannot originate authoritative state by changing a projection.
Terminal TaskRuns are immutable. Retry, reconciliation and two-phase cancellation
are explicit commands rather than inferred status changes.

## 2. Layers

| Package             | Responsibility                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `domain`            | Pure synchronous events, commands, lifecycle, budgets and side-effect rules                  |
| `application`       | Ports, atomic command service, provider contract, turn/tool orchestration and reconciliation |
| `store`             | In-memory event and atomic command adapters, clocks and deterministic ids                    |
| `store-sqlite`      | Durable log, atomic receipts, journal, checkpoints, identity allocation and host ownership   |
| `provider-core`     | HTTP/SSE adapters and compatibility exports of the application provider contract             |
| `provider-deepseek` | DeepSeek request/stream/error translation                                                    |
| `tools-node`        | Workspace file tools and ordinary Node process execution                                     |
| `contracts`         | Existing ACP v1 and JSON-RPC client DTOs                                                     |
| `apps/cli`          | Composition, environment/arguments, approval input, transport mapping and rendering          |

Dependencies point inward. Application imports the domain, not Node I/O,
provider adapters or client DTOs. Provider-core reexports application-owned
`ProviderPort` and `ProviderError`, preserving class identity for existing
adapters. CLI engine modules are compatibility reexports of application logic.

## 3. Command transaction

The official memory and SQLite event logs expose an atomic command port.
The complete submitted request is copied before asynchronous work and bound
canonically to its command id. Lookup precedes replay/version checking; commit
rechecks identity under the write lock. Events and receipt commit together.
Same id/request returns the original receipt. A different task, payload, actor,
version or type fails without returning another request's receipt.

Legacy separate dedup stores remain compatibility mirrors, not authoritative
command writers. A custom adapter without the atomic port does not offer the
same crash guarantees. Old unbound receipts fail closed. See [storage](integration/sqlite.md).

## 4. Turn orchestration

Application `runTurn` admits/schedules a run, starts its attempt and drives a
bounded provider/tool loop. Every model dispatch settles token usage before
requested tools can run. Assistant/tool messages and reasoning form process-local
conversation context. A final assistant response is required for normal success.
Concurrent turns on one service/TaskRun are refused before dispatch. Application
`selectTurnTask` chooses an unstarted run or an explicit terminal continuation;
unresolved execution cannot become a fresh turn.

Providers implement an injected application port and emit normalized stream
updates. Hosts map application updates to existing ACP DTOs and terminal text.
The application does not depend on the client protocol. Without a provider, a
turn explicitly reports deterministic execution instead of model output.

## 5. External effects

`ToolService` prepares the operation, obtains approval, durably claims its
run/attempt/invocation identity, executes it and records settlement. A claim is
committed before dispatch and cannot authorize a second execution. It binds the
request; unknown outcomes block fresh dispatch as well as same-identity replay.

Permission review receives frozen preview metadata without execution authority.
Session approvals apply to the same tool, arguments, kind and preview; they do
not grant every edit or command. Prepared file edits recheck observed contents.
This is not atomic isolation from an uncooperative filesystem writer.

## 6. Cancellation evidence

AbortSignal requests cancellation; it does not establish termination. Closing
a remote provider stream does not prove generation stopped or billing ended;
without a positive terminal response its cancellation remains unknown. The engine
awaits the execution result and prioritizes uncertainty over cancellation.
`CompleteCleanup` is emitted only when quiescence is established by the execution
path. Uncertain effects leave a run `reconciling`, or `cancelling` if cancellation
was requested. Sending a signal, closing pipes or observing leader exit cannot
confirm that a process tree stopped.

The Node backend reports process results as uncertain because escaped children
cannot be ruled out. It makes best-effort group termination and bounds waiting;
it never converts this into confirmed tree cleanup. Explicit containment requests
are refused unless the backend declares all required capabilities.

## 7. Storage and recovery

Ephemeral mode loses all state at process exit. Durable mode requires a persistent
SQLite file, durable journal and exclusive host ownership. Hosts await startup
reconciliation before accepting work. A second live/unverified owner is refused.
PID liveness protects cooperating host ownership, not execution containment.

Replay/checkpoints reconstruct TaskRun state. Reconciliation converts interrupted
claims to unknown outcomes, marks unfinished tasks for review and never relaunches
a provider or tool. A lost conversation is not resumed using empty history.
TUI lists recovered tasks, ACP warns a fresh session, and `runne status` displays
retained states/effect metadata. No automatic unknown-effect resolution exists.

## 8. Client boundary

ACP v1 over spawned stdio is the existing out-of-process interface, with
initialize, new session, prompt, cancellation, streamed updates and approvals.
Session loading/resuming is not advertised. The spawning process controls access;
there is no authenticated network listener. No new transport was added.

Application ports are in-process seams, not a versioned network API. There is no
cursor-based event reconnect protocol. Existing `packages/contracts` DTOs remain
unchanged. Unknown results use existing refusal/message/mode updates.

## 9. Budgets

Token usage is committed before completion/failure/cancellation. Actual finite
provider-token overruns commit usage and exhaustion together. Reservations and
other budget dimensions exist in the domain but are not fully driven by coding
execution. No price snapshots or provider-cost accounting are implemented.

## 10. Verification boundaries

Deterministic tests cover atomic receipt rollback/retry, concurrent commands and
turns, interrupted claims, approval scope, capability refusal, cancellation and
host recovery. Native OS behavior is a separate qualification activity. Unit
streams and mocked spawn outcomes are not evidence of real containment.

## 11. Limits of this repository

- Conversation history, approvals and read snapshots remain process-local.
- Linux is the intended contained-execution target; no qualified containment
  backend is implemented. macOS/other systems use ordinary uncontained Node I/O.
- Native commands stop the turn for reconciliation even on leader exit code zero.
- Unknown effects cannot be interactively certified/resolved by this CLI; no
  automatic retry, compensation or process reattachment is implemented.
- SQLite payloads/request bindings are not encrypted. Hosts assume local trusted
  database access and cooperating execution ownership.
- No MCP, cost accounting, durable conversation resume or desktop qualification.

See [coding tools](integration/coding-agent.md), [storage](integration/sqlite.md),
[TUI](integration/tui.md), [domain model](domain-model.md),
[state machines](state-machines.md) and [provenance](../NOTICE).
