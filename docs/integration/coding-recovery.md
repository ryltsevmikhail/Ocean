# Ocean 1.1 coding recovery development

Status: stage 7 in progress. Interrupted apply receipt recovery is implemented;
owner-confirmed content reconciliation, complete coding-operation fault qualification,
asset-complete backup/restore and release acceptance remain open.

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
`pnpm check` now passes 816 tests (39 opt-in skipped); build and format pass on
the same qualified Linux/Node/pnpm versions. Owner reconciliation decisions,
full-tree validation and any explicit hold-release protocol remain open.

## Process fault evidence

`apps/cli/src/ocean/coding-process-recovery.test.ts` starts a separate Node process
with the actual SQLite store and Linux GitCodingApplyProject adapter, waits for
a signalled committed boundary, then sends SIGKILL and waits for process exit.
Its temporary Git fixture covers:

- committed apply intent, before any file starts;
- committed file started, before its external effect;
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
Unit/store tests cover no project-port calls, idempotence, existing journal
uncertainty and transaction rollback on contradictory completed evidence.

On 2026-11-02, Linux x86_64 / Node 26.13.0 / pnpm 12.16.1: `pnpm check` passes
807 tests (39 opt-in skipped); `pnpm build` and `pnpm format:check` pass. This
covers process SIGKILL, not power loss. No external provider or real profile is
used. Independent review found no blocking issue in this recovery increment.

## Remaining release gates

Implement content reconciliation against exact before/after artifacts without
redispatching unknown effects. Qualify interruptions after approval decision,
write/test spawn/result and artifact capture, including process supervision.
Snapshot format 2 must include all referenced worktrees, Git administration and
recovery assets with verified manifests; old format-1 backup still refuses
external coding assets rather than producing an incomplete full backup.

Qualify restored authority as inert, corrupted/missing assets as failures,
installed Linux artifacts and legacy text-only compatibility. Native interactive
terminal acceptance and an explicitly agreed live-provider access/request budget
remain required. Previous live-provider permissions are exhausted.
