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
- replacement published, before its file completion receipt;
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

At the separate 7.1 scope checkpoint, root check passes 909 tests (41 opt-in
skipped), build and format pass. The opt-in Linux command
`OCEAN_SANDBOX_NATIVE=1 pnpm test apps/cli/src/ocean/coding-process-recovery.test.ts apps/cli/src/ocean/coding-workflow-native.test.ts`
passes 9 tests: seven process boundaries plus two direct/group workflows with
actual admitted application. Crash fixtures remain trusted seeded receipts;
they do not replace admission qualification. No provider/key or installed 1.0
artifact was used or changed. Fresh independent packaged review remains with
the controller; this checkpoint does not complete Task 7.

## Remaining release gates

Extend reconciliation to other coding effects without redispatching unknown
operations. Qualify interruptions after approval decision,
write/test spawn/result and artifact capture, including process supervision.
Snapshot format 2 must include all referenced worktrees, Git administration and
recovery assets with verified manifests; old format-1 backup still refuses
external coding assets rather than producing an incomplete full backup.

Qualify restored authority as inert, corrupted/missing assets as failures,
installed Linux artifacts and legacy text-only compatibility. Native interactive
terminal acceptance and an explicitly agreed live-provider access/request budget
remain required. Previous live-provider permissions are exhausted.
