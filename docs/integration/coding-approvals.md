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
