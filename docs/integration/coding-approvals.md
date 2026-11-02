# Coding approval development

Status: stage 4 in progress. The domain binding and expiry predicate are
implemented; durable storage, owner decisions, atomic consumption and host UI
integration remain pending.

An approval binding identifies workspace, task, project and worktree, room,
bot, run, attempt and invocation, operation kind, exact operation hash, source
tree hash, policy version, limits hash and qualified toolchain hash.
A decision is valid for at most five minutes, expires at the deadline, and
is refused if the clock precedes creation or any binding field changes.

These types grant no authority on their own. Application admission must
validate task ownership, lease and pending claims, persist the exact preview
and trusted owner decision, then atomically consume an allowed decision
before dispatch. Restored decisions remain unusable.

The application service now requests an atomic preview record before prompting
the trusted owner port, then rechecks task admission, exact binding and expiry
after the owner returns. It supports allow-once, deny and cancel. Restored
instances refuse requests and decisions. Regression tests cover expiry while
the owner prompt is open and restored request refusal. Concrete durable storage,
atomic consumption and host integration remain pending.

Consumption is now an application transaction: recheck allowed status, exact
binding, expiry, restored state and task admission, create the dispatch claim
through the same transaction, then persist consumed status. The store port
requires claim and status updates to roll back together. Regression tests
verify one claim for allow-once, no claim for deny/cancel or a foreign room,
and refusal of repeated consumption. Concrete adapters remain pending.

The memory adapter now commits approval records and dispatch claims together
using copy-on-write transactions. Storage enforces immutable preview/binding,
pending→allowed/denied→consumed transitions and a unique invocation claim.
Regression tests cover rollback after claim plus consumed update, repeated
claims, immutable preview refusal and consumption without a claim.
SQLite migration and durable adapter remain next.

Schema 8 adds approval records and unique approval/invocation dispatch claims
through the existing immediate migration transaction. The SQLite adapter uses
BEGIN IMMEDIATE for preview/decision/consumption transactions, validates
immutable transitions and requires the matching claim for consumed status.
The adapter regression suite covers rollback, duplicate claims and schema 7
upgrade. Legacy migration tests and format-1 restore now recognize schema 8.
Runtime admission integration, on-disk reopen/concurrency qualification and
owner UI remain pending.

On-disk adapter qualification now opens two connections, consumes from one,
verifies duplicate refusal from the other, closes both and reopens the file
to verify consumed status and claim persistence. This verifies visibility and
reopen durability, not simultaneous cross-process lock contention.
Memory/SQLite parity tests also require that the claim belongs to the exact
approval ID; memory storage now records that owner instead of only the
invocation key.

The public openSqliteStore factory now exposes codingApprovals over the same
durable connection and lifecycle as the other ports. A file-backed regression
writes through this public port, closes the store, reopens it and verifies the
exact pending preview. Runtime admission wiring must avoid nesting a coding
BEGIN IMMEDIATE inside an approval transaction on that connection; authority
reads and consumption need a shared transaction view.

Admission callbacks now receive the active approval transaction, and every
request/decision/consumption admission check executes inside that transaction.
SQLite exposes authoritative task reads on that view without opening a nested
coding transaction. Memory storage accepts a synchronous task reader.
A regression verifies all four admission checkpoints run within the transaction.
Production authority policy and runtime wiring remain pending.

Runtime now composes codingApprovals over durable storage and transaction-local
task/member reads. Admission checks exact project/worktree, policy capabilities,
task owner, current membership, live project lease and unresolved legacy/global
tool claims. Apply remains unavailable until its separate stage-6 authority
flow exists. Ephemeral runtime refuses coding approvals. Regression coverage
includes foreign room/bot/worktree, pending effects, lost lease and membership.
Claim reconciliation across the approval and legacy journal paths still needs
integration before dispatch can be enabled.

SQLite consumption now records the shared tool journal's started effect in the
same transaction as its unique approval claim and consumed status. The journal
offers synchronous claim admission for this transaction while preserving the
existing asynchronous API. A regression verifies rollback leaves no pending
effect, successful consumption appears in global inspectPending, and a legacy
claim is blocked while that coding effect remains unresolved.

CLI and TUI owner adapters now display the exact binding and preview with
terminal controls escaped. Both refuse noninteractive approval. TUI coding
screens ignore the legacy allow-session key; only allow-once or denial is
available, and abort cancels the pending screen. CLI requires a live TTY and
an exact y response, with cancellation handled through AbortSignal.
Tests cover exact escaped preview, ignored session key, abort and no-TTY refusal.
Adapters still require connection to the task operation preparation flow.

Application dispatch now snapshots the trusted prepared operation, requests and
decides its exact preview, recomputes the current binding, consumes approval,
then executes and settles the shared journal claim. It does not claim twice.
Regression tests verify owner→claim→execute→settle ordering, no claim/effect for
deny/cancel/stale source, and uncertainty on execution failure after claim.
Host task operation preparation and chat invocation wiring remain pending.

The tools-node host factory now prepares bounded new-file/test operations
against a qualified task backend and computes hashes from exact call/preview,
limits, source snapshot and actual toolchain/dependencies. Owner preview
includes the fixed environment and limits. A native regression verifies
preparation creates no target file. The factory is public for host integration.
Session-scoped read history for existing-file edits and conversation wiring
remain pending; existing-file edits still fail the inherited read-before-write
guard when prepared without that history.

Task operation sessions retain qualified backend and WorkspaceTools read history
for subsequent existing-file edits in the same task scope. Reads require the
explicit project_read capability. Native regressions verify refusal before
reading and preservation of a file changed after preparation. Current root
pnpm check is blocked by unrelated untracked design-assets/ocean-motion.js
outside the TypeScript lint project. Typecheck, lint with that directory
excluded, the ordinary suite, native session tests, build and formatting pass.

Native host integration now exercises the public tools-node preparation factory,
SQLite approval service, exact owner preview, shared journal and real sandboxed
write together. Allow-once creates the file and consumes the approval; denial
leaves it absent with no pending journal effect. Duplicate consumption is
refused. These fixture tests inject trusted admission; runtime authority has
separate tests. The ordinary root check passes again in the current workspace,
along with build and formatting.

Binding validation now rejects empty/oversized/NUL-bearing identity fields,
invalid operation kinds and nonpositive/nonintegral policy versions. Matching
two malformed copies does not authorize an operation. Request timestamps must
also allow a safe-integer expiry. Domain regressions cover malformed equal
bindings.

Independent review identified source snapshot ordering during final binding
recomputation. Source is now captured after all asynchronous toolchain hashing.
The prepared executable also compares the source against its approved snapshot
before backend execution. A native regression changes source during executable
hashing: the pre-fix binding retained the old hash, while the corrected binding
sees the change and cannot match the approval. Native dispatch tests still pass.
