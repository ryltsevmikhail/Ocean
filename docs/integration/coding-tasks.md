# Coding task authority — Ocean 1.1 stage 1

Implemented in the development source; not part of the published Ocean 1.0 archive. This stage reserves a project and stores task-scoped policy. It does not enable chat file edits, test execution, worktrees or diff review.

## Application API

Durable host composition exposes `runtime.coding: CodingTaskService`. The application package exports the service and port types; domain exports task, policy, capability and result types.

`start(input: StartCodingTask, owner: CodingOwnerPort): Promise<CodingResult<CodingTask>>` accepts:

- taskId and requestId: stable owner/client-generated identities, at most 128 UTF-8 bytes;
- workspaceId and canonicalizable absolute projectRoot: the project must be the workspace bound to this profile;
- ownerRoomId/devBotId and reviewRoomId/reviewBotId: explicit assignments; each bot must belong to its assigned room;
- devCapabilities: an explicit subset of project_read, propose_write, run_test_preset; no capability follows from bot name, role prose or an existing profile;
- testPresets: at most 16 exact id/program/argv/cwd definitions, required for run_test_preset; cwd is currently '.', and presets are inert at this stage.

The trusted host supplies an in-process `CodingOwnerPort.confirm(preview)`. The preview contains operation, task ID, canonical root, base commit, workspace, both room/bot assignments and complete policy. A model response or boolean from a wire request cannot supply this port. Denial creates no task or project hold. Requests/previews are detached so an approval callback cannot change the stored binding.

The result is a reserved task with policyVersion 1 and worktreeRoot null. Review receives only changeset_read; it can never inherit dev's write/test capabilities. Separate private dev/review rooms and a shared group are both supported. The first stage has no per-operation approval UI; that is stage 4.

`authorize(access: CodingAccess)` checks task/workspace/room/bot/policy version, current membership, local unresolved claims and retained coordination ownership. Success always includes **executionEnabled: false**: it describes a valid reservation, not an executable tool token.

`cancel(workspaceId, taskId, owner)` explicitly cancels a reserved stage-1 task after owner confirmation and releases only its exact lease token. It does not certify process cleanup and cannot bypass unresolved tool claims. Duplicate cancellation cannot release a newer task's reservation.

Expected classifications: invalid_input, coding_denied, coding_unavailable, approval_required, project_busy, project_changed, request_conflict and recovery_required. The same start request returns its saved task without repeated consent; a changed binding conflicts. An already-used task ID cannot be silently recycled through a new request ID.

## Project validation and coordination

GitCodingProject resolves the real project root, verifies the base revision and refuses a dirty checkout. Inspection disables fsmonitor/hooks and all effective clean/process filters, including worktree configuration, before status evaluation. It never stashes, stages, creates branches or modifies files. Project identity is rechecked after consent and lease acquisition.

`ProjectLeasePort` has acquire(projectRoot, holder), owns(lease) and release(lease). A holder binds owner profile identity, task/request IDs, request binding and operation kind. Overlapping canonical roots conflict, including parent/child roots. Release requires the exact retained token and binding.

`SqliteProjectLeases` stores coordination outside individual profiles at:

```text
~/.local/state/ocean-coordination/leases.sqlite
```

The directory is 0700 and files are 0600; symlinks, hardlinks and unsafe ownership/permissions are refused. SQLite serializes acquisition across processes. The location is fixed per OS user instead of following a profile or XDG override. A task reservation survives runtime close and process death; neither a PID check nor a timeout silently releases it.

Known pre-effect rejection releases an unused reservation. A storage/commit exception retains it because the service cannot assume whether a commit occurred. Such incomplete reservations remain blocked pending later explicit reconciliation; stage 1 has no administrative force-unlock command. Do not remove coordination files to bypass an unknown outcome.

Updated native/compatibility adapters participate in the same registry:

- a file write reserves its workspace for the operation;
- an uncontained command reserves global scope, since its cwd cannot constrain where it writes;
- invalid cwd, stale pre-write input and pre-dispatch cancellation do not leave holds;
- thrown or uncertain post-dispatch outcomes retain their hold;
- the native backend still advertises no containment and no confirmed tree stop. Its conservative uncertain command results therefore continue to block mutation until reconciled.

This is cooperative coordination between updated Ocean hosts. It does not stop an unrelated editor, direct shell command or an older binary from changing files. Filesystem/process containment belongs to stage 3. Published 1.0 artifacts are unchanged.

InMemoryProjectLeases/InMemoryCodingStore are isolated test adapters. Production ephemeral runtimes return coding_unavailable for start, authorization and cancellation; they cannot grant rights invisible to the shared durable registry.

## SQLite and snapshots

Schema 6 adds ocean_coding_tasks and ocean_coding_receipts. Task policy, base, role assignments, lease binding, status and start receipt are persisted. Only reserved→cancelled is currently supported; other binding fields are immutable through adapters. SQL foreign keys check participants, and a unique active-project index complements cross-profile coordination.

Migration from frozen released schema 5 is transactional and leaves original bots, rooms, history, events and unresolved claims unchanged. Existing bots receive no task grants. Tests also retain older schema fixtures and future-schema refusal.

Snapshot format 1 continues to back up and restore schemas 5 and 6. The new snapshot contains all task/policy metadata; worktreeRoot is null, so no external coding assets exist yet. The global coordinator is not copied or used to reactivate reservations. Restored runtime coding start/authorize/cancel return recovery_required regardless of saved policy. Opening a schema-5 restored profile through a current host applies the normal migration, with its restore guard preserved.

Never test the development schema by opening the only operational profile with source CLI. The installed 1.0 binary cannot read schema 6; use a separate development profile and retain a verified schema-5 snapshot for its original binary.

## Verification

Tests cover memory/SQLite policy equivalence, explicit role/room assignments, default-deny behavior, duplicate/conflicting requests, changed owner previews, transactional rollback, orphan-free known rejection, two real simultaneous lease processes, retained holds after exit, canonical aliases, legacy mutation refusal, uncertain-command retention, malicious Git worktree filters, frozen 5→6 migration and schema-5/schema-6 backup/restore.

Run pnpm check, pnpm build and pnpm format:check. Native lease tests use temporary registries and synthetic subprocesses; no provider key or paid model request is required. These checks qualify stage-1 coordination, not the planned sandbox.
