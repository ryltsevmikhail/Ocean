# Ocean 1.1 coding recovery development

Status: stage 7 in progress. Interrupted apply recovery, read-only inspection
and exact owner apply resolution are implemented. Other coding-operation
reconciliation, complete fault qualification,
asset-complete backup/restore and release acceptance remain open.

New applications now place retained evidence in the exact version-2 owner/task/
application/changeset scope described in [coding backup](coding-backup.md#exact-scope-for-new-application-recovery).
The trusted application supplies this context only after the durable per-file
started receipt. Private canonical FD-pinned directories and the exact scope
header must be synced before project effects. Existing missing/corrupt scope
state refuses without repair; legacy recovery data remains untouched. This
identity evidence grants no approval, replay permission or completion inference.
The adapter keeps the checked directory FDs open across the full synchronous
effect and writes recovery evidence relative to the validated files FD. It
rechecks canonical scope bindings/private ownership/exact header before project
mutation and after displacement/publication. Observed replacement throws, leaving
the durable application uncertain and retaining evidence even if displacement
already occurred; it never accepts a substituted private directory by pathname.

## Interrupted application receipts

Exclusive durable runtime startup recovers apply receipts before generic tool
reconciliation. In one SQLite transaction it changes applying receipts to
uncertain, retains each completed/pending file, and changes started files to
uncertain. It does not call the project observation or filesystem effect port.
Even when every file has a completed receipt, missing overall completion is
not inferred as success. No owner decision, write or apply is replayed.

The same transaction preserves the shared unresolved effect hold. A previously
started journal becomes uncertain; an existing uncertain journal remains held.
A contradictory completed/missing journal fails and rolls back receipt changes.
Repeated startup leaves terminal receipts unchanged. The global hold continues
to block new external effects; text-only room acknowledgement cannot release it.

This is uncertainty retention, not content reconciliation. No filesystem bytes
are automatically repaired, restored, removed or accepted as complete. Retained
originals and per-file recovery intents are needed for later explicit inspection.

## Owner-local read-only inspection

`ocean coding pending` lists held application IDs from the current profile's
shared effect journal, including after a crash before an ID was printed. It
also reports other unresolved effects rather than hiding their global hold.
`ocean coding inspect-apply RECEIPT_ID` compares actual file entries against
that receipt's immutable changeset. It reports recorded receipt status plus
before/after/conflict/unavailable observations, raw-content SHA-256, Git file
mode and physical kind (file/missing/directory/unavailable). No file content is
returned. Exact mode changes and declared file/directory refactors are included.

Inspection requires the original non-restored profile owner and exact task,
workspace, base, artifact and ordered receipt paths. Authority/binding are
rechecked after observation. It remains usable while the global hold blocks
execution, even if a mutation lease was lost. Neither command can call a model,
write/repair project files, change a receipt, settle an effect or grant approval.
The result explicitly says holdReleased=false; matching after bytes never
upgrades an uncertain effect to completed.

The Linux adapter walks pinned directory FDs without following links, refuses
protected paths, hardlinks, special/oversized files, and detects file/parent/root
changes during observation. Limits: 1,000 paths, 128 KiB per file and 32 MiB
aggregate observed bytes. Unavailable observations cannot be used as matching
proof. Per-file results are diagnostic snapshots, not a coherent whole-project
verification: unrelated/ignored files and extra directory entries are not
scanned. Directory comparisons only describe declared artifact file entries.

Real temporary Git/SQLite integration checks held after-state inspection,
mode/content conflicts, symlink refusal, unchanged receipt/journal, CLI ID
listing and restored-profile refusal. Deterministic read-boundary tests change
file bytes or move a parent mid-read and require unavailable rather than a
matching hash. Domain tests distinguish additions/deletions, modes and declared
refactors. Independent review found no blocking issue in this diagnostic layer.
At the diagnostic-layer checkpoint, `pnpm check` passed 816 tests (39 opt-in skipped); build and format pass on
the same qualified Linux/Node/pnpm versions. The exact owner resolution protocol for fixed host application is described
below; this diagnostic command itself still releases nothing.

## Exact owner resolution for fixed host application

`ocean coding reconcile-apply RECEIPT_ID --accept before|after --reason TEXT`
requires a separate interactive owner confirmation. It accepts an observed
eligible-tree snapshot; it never retries, repairs or completes an unknown apply.
Both before and after hashes use the same full manifest policy as the immutable
artifact: base/cached/Git-eligible untracked files, exact bytes and modes,
protected/ignored exclusions and existing 1,000-file/32-MiB limits. Two scans and
canonical-root/current-HEAD checks reject changed base or unstable captures.
This includes unchanged eligible files, not just the changed-file list. It does
not claim ignored/private data or the whole host was unchanged.

Only the exact single uncertain coding_apply effect can be resolved: task,
workspace, receipt, artifact, base, original owner, context and fingerprint are
bound. Both original/worktree leases must still be live. A restored profile,
lost authority/lease, another unresolved effect or a tree matching neither exact
snapshot refuses. The full tree is checked before and after confirmation;
authority/binding are checked again in the commit transaction. Confirmation is
one-use and expires after five minutes, including backward/invalid-clock refusal.
A mixed partial application remains held until the owner manually brings the
project to an exact accepted before or after snapshot. Ocean does no automatic
stash/reset/clean/restore or deletion of retained originals.

The decision is append-only journal metadata in tool_effect_resolutions_v1,
independently versioned like tool_invocations_v1/v2. Its one SQLite commit also
changes the pending/claim predicate for that exact context/fingerprint. The
original uncertain invocation and per-file receipt remain unchanged forever;
their identities still prohibit replay. No separate settlement window exists.
A rolled-back decision retains the hold, and a duplicate decision refuses.
Doctor uses the same unresolved predicate; old metadata without this table
remains conservatively held. Older readers that ignore resolutions also retain
the original uncertainty rather than replaying it.

`inspect-apply` shows the saved owner resolution alongside the unchanged receipt.
The result still states holdReleased=false because inspection changes no state.
This protocol is limited to the fixed trusted host file-application adapter. It
cannot resolve sandbox writes/tests, prove child-process termination, claim a
historical outcome or guarantee absence of later external edits. Other unresolved
effects remain blocked and need their own supervision/content reconciliation.

Real temporary Git/SQLite tests cover accepted before/after, denial, stale
confirmation, unrelated user files, restored profiles and lost leases. Journal
scope/rollback tests verify unchanged uncertain history, exact fingerprint/context,
other-effect refusal and preserved replay protection. Expiry/clock regressions
and disk reopen verify decision scope/persistence. Independent review found no
blocking issue. Root check passes 835 tests (39 opt-in skipped), build and format
pass. The focused sandbox workflow plus SIGKILL suite passes 8 tests (2 native
sandbox scenarios and 6 process boundaries) after the shared-manifest refactor.

## Process fault evidence

`apps/cli/src/ocean/coding-process-recovery.test.ts` starts a separate Node process
with the actual SQLite store and Linux GitCodingApplyProject adapter, waits for
a signalled committed boundary, then sends SIGKILL and waits for process exit.
Its temporary Git fixture covers:

- committed apply intent, before any file starts;
- committed file started, before its external effect;
- scope.json fsynced, before files/ creation or any project file effect;
- original renamed into retained recovery storage, destination absent;
- staged replacement linked at the project destination, before its recovery name is unlinked;
- staged name unlinked, before the completion intent is saved;
- completion intent saved, before its file completion receipt;
- first file completed and second changed but not recorded complete;
- all file receipts completed, before overall operation completion.

The fixture exercises storage/filesystem crash boundaries, not task admission:
its trusted worker seeds a receipt directly. Stage-6 runtime/native workflow
fixtures separately qualify task/evidence/review/owner admission.

Two fresh runtime openings must preserve file bytes and effect-dispatch counts,
retain exact completed/uncertain/pending states and refuse receipt replay. The
rename-gap case also checks the retained original bytes; runtime does not infer
that a missing destination means cancellation or restore it automatically.
The scope-header case checks unchanged source bytes, exact retained header bytes
and continued absence of files/ after each reopening. No recovery directory is
repaired and the uncertain receipt cannot be claimed again.
Unit/store tests cover no project-port calls, idempotence, existing journal
uncertainty and transaction rollback on contradictory completed evidence.

At the initial recovery checkpoint on 2026-11-02, Linux x86_64 / Node 26.13.0 /
pnpm 12.16.1: `pnpm check` passed 807 tests (39 opt-in skipped); `pnpm build` and `pnpm format:check` pass. This
covers process SIGKILL, not power loss. No external provider or real profile is
used. Independent review found no blocking issue in this recovery increment.

At the corrected 7.1 scope checkpoint, root check passes 913 tests (41 opt-in
skipped), build and format pass. The opt-in Linux command
`OCEAN_SANDBOX_NATIVE=1 pnpm test apps/cli/src/ocean/coding-process-recovery.test.ts apps/cli/src/ocean/coding-workflow-native.test.ts`
passes 9 tests: seven process boundaries plus two direct/group workflows with
actual admitted application. Crash fixtures remain trusted seeded receipts;
they do not replace admission qualification. No provider/key or installed 1.0
artifact was used or changed. Fresh independent packaged review remains with
the controller; this checkpoint does not complete Task 7.
The initial 7.1 review found a scope/effect pathname substitution gap. Its fix
adds deterministic scope/files/header swaps before effects and scope replacement
after displacement, preserving both directories and refusing false completion.

## Frozen recovery protocol and source evidence

New claims persist recoveryProtocol 2 in the receipt and shared journal
fingerprint before file effects. Startup retains the marker when it changes
interrupted status to uncertain. Historical unmarked receipts retain their
original protocol ambiguity, including receipts created by the initial scoped
writer. The read-only evidence collector requires a frozen numeric marker and the
exact original operation context.

The SIGKILL fixture now explicitly seeds a marked receipt and inspects the scoped
source after each of two reopenings. Claim and pre-dispatch interruptions show
an absent source. A crash after scope.json fsync shows a header-only leaf. The
rename gap shows an incomplete record with the displaced original. Later crashes
can show completed native records while the overall receipt remains uncertain.
Project bytes and dispatch counts survive both openings, the journal retains its
hold and a duplicate claim refuses. No folder repair or settlement accompanies
source capture. See [coding backup](coding-backup.md).

At the 7.4 checkpoint both publication boundaries leave the first file uncertain
and the shared hold in place over two reopenings. The project contains the new
bytes and the recovery directory contains the original bytes. Immediately after
the link, its staged name still shares the destination inode. After unlink, that
name is absent. Read-only capture distinguishes these shapes, preserves the
source and never retries the apply. A separate SIGKILL fixture uses a real task
and changeset with a trusted seeded receipt to capture the publication link from
a frozen profile under maintenance ownership. Its quarantined staged file has
one link and its own inode. The four-file native suite passes 14 tests on Linux,
including the two admitted direct/group workflows.

## Interrupted worktree creation (7.5)

Six real SIGKILL fixtures reach actual adapter boundaries: persisted plan before
Git effects, successful no-checkout before chmod, after chmod, during raw-blob
materialization, immediately before read-tree and immediately after read-tree.
The runtime admits the synthetic task and commits its preparation intent before
the worker reaches the real Git/filesystem boundary. Two ordinary reopenings
preserve `preparing`, the task/worktree binding and one create dispatch. Repeated
prepare refuses `recovery_required` without reapproval, recreation or pruning.
Capture does not promote the state to ready or infer cancellation/completion.

Each reopening captures through `snapshotCodingDatabase` while maintenance
ownership reports busy. Partial evidence includes actual tree bytes/modes,
explicit absent/present raw index, minimal bound administration and required
base/history/stage/REUC object closure. Before-chmod 0755 roots require the private
pinned managed ancestor. Absent roots still require base and branch/admin
observations. Unsafe or incomplete internal Git shapes refuse without repair.
See the [supported shapes and bounds](coding-backup.md#managed-worktree-subgraph).
Private quarantine/import tests do not revive approvals or reconnect source paths.

The first shared-runtime delivery is accepted at `56bbef0`, including the reviewed
`dc9e244` correction and qualified source `67665e9`. These fixtures respect its
owner boot/PID-namespace checks and maintenance-held inventory API. All host and
child runtime fixtures use disposable HOME/coordination state. This qualifies
host SIGKILL, not power loss, an installed upgrade or complete profile restore.

## Frozen configuration/dependency evidence (7.6)

The 7.5 worktree/Git checkpoint is accepted at `a6b3958`; its independent object
identity, exact closure and pack inflation bounds remain unchanged. The next
subgraph binds private project configuration and exact selected dependency/toolchain
mounts to policy evidence from the ownership-held frozen SQLite inventory. Archive
verification and per-task quarantine materialization work after synthetic source
removal. Relative workspace-package links need the exact originating captured task
tree; absent inputs remain explicitly `not-supplied`, never a full-backup success.

No registry entry, restored file, old approval or resolution record grants execution
or releases an uncertain effect. Source configuration/absolute paths are inert data;
no checkout is recreated or rebound. Registry absence, file bytes, source/mapping
identities and all earlier inputs are rechecked after the final consumer. Unsupported
or missing closure refuses without source cleanup. See the [supported-state table](coding-backup.md#frozen-configuration-and-dependency-subgraph-76).

## Remaining release gates

The host-level crash matrix in [crash matrix](crash-matrix.md) now classifies
every execution/effect boundary as unit simulation, actual SIGKILL, cgroup
native or installed-open, and closes the previously missing immutable changeset
capture, test-result-persistence and native test-spawn/cleanup boundaries with
real SIGKILL and two-reopen evidence. Remaining work is content reconciliation
and owner resolution for sandbox write/test effects without redispatching
unknown operations (test presets have no resolution command yet) and installed
artifact qualification. Snapshot format 2 must unify all referenced worktrees, Git administration, recovery,
frozen configuration and dependencies under global cross-subgraph accounting.
Imported Desktop per-profile attachment/preparation assets remain mandatory and
OPEN until trusted path binding and exact selection are determined without arbitrary
HOME traversal. Full quarantine profile restore and authority rebind remain OPEN; old format-1 backup still refuses
external coding assets rather than producing an incomplete full backup.

Qualify restored authority as inert, corrupted/missing assets as failures,
installed Linux artifacts and legacy text-only compatibility. Native interactive
terminal acceptance and an explicitly agreed live-provider access/request budget
remain required. Previous live-provider permissions are exhausted.

## Desktop publication evidence (7.7)

Desktop upload commit, preparation and isolated legacy migration now record a
durable owner intent before filesystem effects. A started outcome is unknown,
never inferred from an existing file and never automatically repeated. The
actual receipt link/unlink SIGKILL case retains two names and rejects retry;
capture currently refuses that alias state without source repair. Private
unlinked preparation temporaries and incomplete upload bytes are portable inert
evidence. Quarantine does not grant approval, resend, enroll old paths or become
a usable restored profile. See [Desktop capture](desktop-assets.md). Full-format-2
restore/rebind and remaining crash intervals stay open.

## Crash-qualification matrix (7.11)

[Crash matrix](crash-matrix.md) is the binding evidence table for every
execution/effect boundary: durable facts before the boundary, existing
source/test evidence, qualification class, two-reopen behaviour and remaining
limitation. It reuses accepted 7.1–7.10 fixtures rather than redoing them and
adds the still-missing actual boundaries: immutable changeset capture
(`coding-capture-crash.test.ts`), test result persistence before journal
settlement (`coding-test-persist-crash.test.ts`) and registered test
spawn/exit/cleanup under a killed runtime or supervised cgroup
(`coding-test-spawn-crash.test.ts`). Runtime-level file replacement was already
covered by the shared-runtime `effect` SIGKILL case and is cited, not duplicated.

The cgroup case exposed one genuine defect: systemd reports `SIGTERM` as a clean
service exit, so `systemd-run --wait` returned exit 0 for an externally stopped
unit and the runtime could record a killed preset as passed. Review round 2 found
the same defect for the other clean non-oneshot service signals, `SIGHUP`,
`SIGINT` and `SIGPIPE` (which Node ignores by default). The fix moves completion
to a child-invisible channel in `sandbox-supervision.ts` and
`sandbox-launcher.ts`: the trusted host-side supervisor, outside the project PID
namespace, traps all four signals and exits with the reserved status 75, and
`systemd-run --wait` propagates that non-zero status. Project code cannot signal
or fake the supervisor, and completion does not depend on a completion token
embedded in the in-sandbox argv (the readiness handshake token cannot authorize
completion) or on stdout bytes, so it cannot be forged and does not consume the
retained-output limit. An admitted run whose supervisor exited 0
without being stopped is the only shape recorded as passed; units stopped with
`SIGTERM`, `SIGHUP`, `SIGINT` or `SIGPIPE` are never passed, and ordinary exit-0
runs still pass, including one that fills the retained-output cap exactly. The
remaining limitation is the documented exit-75 collision: a preset that itself
exits 75 is indistinguishable from the reserved stop status and is likewise not
passed. Native cgroup regressions cover `systemctl stop` (SIGTERM) and
`systemctl kill` with `SIGHUP`, `SIGINT` and main-process `SIGPIPE` during a
running registered preset. This is a host-process qualification, not power-loss,
installed artifact or Desktop GUI qualification.
