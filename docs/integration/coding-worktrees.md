# Task worktrees and immutable changesets — Ocean 1.1 stage 2

Implemented in development source for Linux x86_64. The published 1.0 archive remains the text-chat release. Stage 2 adds host APIs and adapters; it does not connect model-driven writes/tests, a sandbox, automatic review or application to the original checkout.

## Host workflow

A durable runtime exposes `codingChanges: CodingChangesetService`, sharing the coding task store, project registry, owner profile identity and recovery restrictions from [stage 1](coding-tasks.md).

1. Reserve a coding task through `runtime.coding.start`.
2. Call `runtime.codingChanges.prepare(access, ownerPort)`. Access must be the task's explicitly assigned dev with project_read, correct room/workspace/policy version, no unresolved tool claim and a retained project lease.
3. The host shows a detached owner preview containing the complete task and exact worktree plan. Consent is a trusted in-process port, not a model response or wire boolean.
4. Capture with `runtime.codingChanges.capture(access, requestId)`. It returns a persisted content-addressed Changeset.
5. Read the frozen artifact with `runtime.codingChanges.read(access, hash)`. Dev uses project_read; the assigned reviewer uses changeset_read. No private dev chat history is implicitly handed over.

These are application APIs, not new CLI commands. Later CLI/TUI task controls follow the implementation plan. All chat execution still has tools disabled, and stage-1 authorization still returns executionEnabled false.

## Working copy creation

The host checks a clean canonical source checkout at its saved base revision. Dirty source is refused; there is no automatic stash/reset. A dedicated branch is named `codex/ocean/<sha256>`, where the suffix binds owner profile identity, project root and task ID. The root is `~/.local/state/ocean-worktrees/<sha256>`; it is private and outside the original checkout.

Tracked base files are preflighted with explicit limits. The adapter creates Git administration state with worktree add --no-checkout, copies raw blobs itself, then populates the index with read-tree. No checkout/smudge/clean filter is used for copying. Host Git disables hooks, fsmonitor, external diff, automatic maintenance and host-wide attributes/excludes; source cleanliness inspection also neutralizes effective filters from worktree configuration.

The source checkout's files, index and current branch are not modified. Creating the dedicated branch and worktree necessarily adds records to the repository's shared Git administration directory. Git administration paths are not forwarded as model context. Actual worker access masking is a stage-3 prerequisite; a linked worktree by itself is not a security boundary.

Both the original project and the separate worktree root hold coordination leases. Updated legacy writers cannot bypass the reservation by selecting the worktree as their cwd. Uncontained commands still require global mutation scope.

Before any creation effect, one SQLite transaction records a preparing intent and binds the task's worktreeRoot. Success advances it to ready; a creation failure becomes uncertain. Concurrent prepare requests cannot create twice. A preparing/uncertain record is never replayed automatically, and ready records are verified before an idempotent response. A missing/rebound directory or changed Git identity requires reconciliation.

Stage-1 cancellation refuses a bound worktree, including a worktree attached while a cancel prompt was pending. There is no automatic branch/worktree deletion in this stage. Unknown effects and existing user changes must not be removed as cleanup.

## Complete frozen artifact

Changesets compare actual working-copy bytes to the saved base commit, independently of the staging state. Candidate paths combine base files, cached/staged files and Git-eligible untracked files. Additions, deletions, executable mode changes, empty files and file↔directory refactors are represented explicitly.

Each changeset stores:

- task ID and immutable base commit;
- beforeTreeHash and afterTreeHash over ordered eligible path/mode/raw-content hashes;
- a complete ordered changed-file list, each with before/after mode, exact UTF-8 text and SHA-256, or null for an addition/deletion;
- a full unified diff without external diff/textconv;
- content-addressed id/hash derived from the entire payload.

UTF-8 BOM, newline presence and CRLF bytes are preserved. Changed binary/invalid-UTF-8 files and symlinks/special files are refused. Protected tracked paths are unsupported for worktree preparation; protected untracked credentials and dependency trees are excluded without reading their content. Ignored untracked files are not part of the eligible Git changeset.

Capture reads bounded file handles, refuses links and path escapes, and compares two complete working-tree manifests plus Git identity. A changed source during observation returns stale_capture; no partial artifact is persisted. A successfully frozen changeset remains readable even if later files change or disappear. It is evidence of those captured bytes, not a claim that the current worktree is unchanged.

Limits are explicit: 1,000 eligible paths, 32 MiB total tree bytes, 8 MiB per baseline/working file, 128 KiB per changed text file, 2 MiB combined changed before/after bytes and 4 MiB diff. Unsupported/oversized input fails without silently truncating review evidence. These limits bound capture; they are not a sandbox or CPU/memory isolation guarantee.

A repeated capture request returns the original immutable snapshot without re-reading files. A changed access binding conflicts. A new request captures a new snapshot when bytes/modes changed. Receipt failure rolls back the artifact transaction. Read-only access to an existing artifact does not grant writes/tests and can continue during an unrelated unresolved tool effect.

## Schema, persistence and backup boundary

Schema 7 additively introduces ocean_worktrees, ocean_changesets and ocean_capture_receipts, with task foreign keys and immutable adapter bindings. Existing schema 6 tasks/rights and older data migrate transactionally. Failed migration restores the prior schema and constraints.

Changed-file content is stored in SQLite, so frozen snapshots survive host restart without reading the current files. Worktree contents themselves are external assets and must not be confused with those changed-file blobs.

Snapshot format 1 remains supported for schemas 5, 6 and 7 when there are no external coding assets. If any worktree intent exists, backup returns coding_assets_unavailable and removes only the newly created incomplete destination. Restore likewise refuses a metadata-only snapshot claiming external worktrees. It cannot silently report complete recovery while omitting the working copy. Full asset-complete coding-task backup/restore is stage 7; use a separate development profile for this unreleased feature.

Restored profiles and ephemeral runtimes cannot prepare/capture/read coding authority. The existing text-only restore guard is preserved.

## Verification

Native fixtures exercise clean-source preservation, deterministic distinct branches, full staged/untracked diffs, modes, empty files, BOM, file/directory transitions, unsupported inputs, capture races and hostile Git configuration. Memory/SQLite contracts exercise role scope, repeated/concurrent preparation, unknown effect retention, immutable receipts, cancel races and transactional rollback. Frozen schema-6 fixtures cover migration and retry after failure.

A real temporary-project integration creates, captures, reopens and reads a worktree artifact; it checks the source checkout stays clean, legacy writes remain blocked, a missing worktree is not recreated and an incomplete backup is refused. Tests use temporary registries and no provider credentials.
