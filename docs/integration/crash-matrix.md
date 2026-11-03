# Ocean coding crash-qualification matrix

Status: workpackage 7.11 evidence audit on BASE `fd53d21` (accepted stages 1–6,
shared runtime and 7.1–7.10). This document distinguishes what is **simulated**
from what was **actually SIGKILLed**, what is **cgroup/native**, and what is
still **open for installed artifacts**. It never upgrades an unproven outcome:
unknown effects stay uncertain/held, are not replayed and are not declared
cancelled. See [coding recovery](coding-recovery.md) for the recovery protocol,
[sandbox](coding-sandbox.md) for containment and [backup](coding-backup.md) for
durable assets.

## Qualification classes

| Class           | Meaning                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit simulation | Application/domain/store tests with a deterministic seam or forged interruption. No independent process dies.                                           |
| actual SIGKILL  | A separate real process (runtime or worker) reaches a named durable boundary and is killed with `SIGKILL`; state is observed over two fresh reopenings. |
| cgroup native   | A real transient user `ocean-worker-*` systemd unit runs under the actual sandbox; the observed cgroup or the unit is killed.                           |
| installed open  | An installed artifact/upgrade would be needed. Not performed in 7.11.                                                                                   |

Qualification envelope for every run below: `Linux 7.2.8-9-omarchy x86_64`,
Node `v26.13.0`, pnpm `12.16.1`, synthetic
`HOME`/all XDG/`TMPDIR` under `/tmp/o79.b6f8ec` through
`.superpowers/sdd/2026-11-02-ocean-1.1/task-7.9-env.sh` (`env -i`, no provider,
no real profile, no keys). Native runs additionally set
`OCEAN_SANDBOX_NATIVE=1`. SQLite runs with `journal_mode=WAL` and
`synchronous=FULL`. Qualification is process `SIGKILL`, not power loss.
Native `/run/user/<uid>` was used only for unique transient
`ocean-worker-*` units; no isolation check was weakened.

## Matrix

| #   | Boundary                                                                                            | Durable facts written before the kill                                                                                         | Source + test evidence                                                                                                                                                                                                                                                           | Class                                                      | Two-reopen behaviour                                                                                                                                                                                  | Remaining limitation                                                                                    |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Owner decision pending/winner/allowed/claim/effect                                                  | approval card, winner settlement, one-use claim, shared effect claim                                                          | `apps/cli/src/local-runtime/decision-crash.test.ts` (5 cases; effect case performs an actual admitted sandbox write)                                                                                                                                                             | actual SIGKILL                                             | Same request/run/history, no new dispatch; interrupted card cannot be re-allowed; claim/effect journals hold `uncertain`                                                                              | provider turns synthetic; installed open                                                                |
| 2   | Durable tool claim before dispatch; unknown claim after start                                       | `ocean_coding_approval_claims` + `tool_invocations_v2` in one transaction (`claimApprovalOperation`), `tool_journal.claimNow` | `packages/application/src/coding-dispatch.ts` order; `decision-crash` `claim` and `effect` phases; `apps/cli/src/ocean/coding-dispatch-native.test.ts` real allow-once/deny effects with durable approval (no kill)                                                              | actual SIGKILL (claim), native (allow-once)                | Started claim becomes `uncertain`; no replay, no second approval consumption                                                                                                                          | exact instant between claim commit and tool spawn is the `claim` boundary, no interior seam exists      |
| 3   | Write-file replacement/rename (worker) and runtime journal settlement                               | recovery intent JSON + original bytes, staged `.after` link, shared journal claim                                             | `packages/tools-node/src/sandbox-file-crash.test.ts` (worker SIGKILL after displacement rename), `sandbox-file-create-crash.test.ts` (after installation), `decision-crash` `effect` (runtime replacement then kill at settlement), `coding-process-recovery` publication phases | actual SIGKILL (worker and runtime)                        | Displaced original retained, next operation refused; runtime receipt/journal stay uncertain                                                                                                           | no runtime-level kill exactly at the adapter's displacement rename; worker-level only                   |
| 4   | Registered test preset spawn, exit/output/cleanup evidence, result persistence                      | durable approval claim; sandbox unit/cgroup; test evidence row only after execution                                           | **new** `apps/cli/src/ocean/coding-test-spawn-crash.test.ts` (runtime kill and cgroup stop, two reopens); `packages/tools-node/src/sandbox-native.test.ts`; `sandbox-command*.test.ts`                                                                                           | actual SIGKILL + cgroup native                             | Runtime kill: claim `uncertain`, no evidence, no replay. Cgroup stop: evidence retained, never passed, journal settles failed                                                                         | installed open; externally graceful `SIGTERM` handlers are indistinguishable from completion            |
| 5   | `recordResult` persisted before `journal.settleNow`                                                 | immutable `ocean_coding_test_evidence` row (exact preset/invocation/binding/tree/deps/exit/output/cleanup)                    | **new** `apps/cli/src/ocean/coding-test-persist-crash.test.ts`; ordering in `packages/application/src/coding-dispatch.ts` and `coding-operation.ts`                                                                                                                              | actual SIGKILL                                             | Evidence visible and `codingTestPassed`, journal `uncertain` and held; exact current review still cannot apply; no re-run                                                                             | no owner resolution path exists for test effects, so the hold is documented, not released               |
| 6   | Immutable changeset capture: partial scan, artifact before commit, committed before acknowledgement | `ocean_changesets` row + `ocean_capture_receipts` in one SQLite transaction                                                   | **new** `apps/cli/src/ocean/coding-capture-crash.test.ts` (scan/artifact/committed); `packages/tools-node/src/coding-worktree.test.ts` (`betweenScans` → `stale_capture`); `changeset-storage.ts` immutability                                                                   | actual SIGKILL                                             | `scan`/`artifact`: zero rows, nothing torn; retry captures current tree once. `committed`: exact frozen bytes over both reopens, zero new scans, no duplicate/overwrite, old request never redirected | artifact is the immutable SQLite row; a durable-artifact-before-receipt window does not exist by design |
| 7   | Partial apply publication and per-file application                                                  | `coding_apply` journal claim, per-file started/completed receipts, retained originals, scope header                           | `apps/cli/src/ocean/coding-process-recovery.test.ts` (9 SIGKILL phases + published-link capture); accepted 7.1–7.4                                                                                                                                                               | actual SIGKILL                                             | Files stay partially applied/uncertain; receipt cannot be reclaimed; read-only capture preserves bytes; no replay                                                                                     | mixed partial trees still require manual owner resolution                                               |
| 8   | Finalization disable, registry begin/commit, release receipt, profile publication                   | finalizing task, release intent, registry changes/receipt, finalized result                                                   | `apps/cli/src/local-runtime/finalization-crash-process.test.ts` (intent/registry_begin/registry_commit/result); `finalization-backup-process.test.ts`                                                                                                                            | actual SIGKILL                                             | Intent/begin held `uncertain` and never retried; commit resolves through receipt; release never replayed                                                                                              | installed open                                                                                          |
| 9   | Backup publication/incomplete marker and restore origin/lineage                                     | archive envelope, `.incomplete` marker, copied SQLite identity, frozen origin/lineage                                         | `apps/cli/src/ocean/profile-backup-publication.test.ts`, `profile-backup-recovery.test.ts`, `profile-backup-v2.test.ts`, `profile-backup-races.test.ts`, `restore-origin.test.ts`                                                                                                | unit simulation (fault-injected readers/races, real files) | Recovery refuses incomplete archives until an incomplete marker/identity path is proven; origins stay frozen                                                                                          | no actual SIGKILL publication crash on this host; full restore/rebind stays open                        |
| 10  | Restored-profile rebind/epoch publication                                                           | rebind intent, decision, acquired lease, prepared registry, publication                                                       | `apps/cli/src/local-runtime/restoration-process.test.ts` (10 SIGKILL phases), `restoration-contention-process.test.ts`, rebind/history suites                                                                                                                                    | actual SIGKILL                                             | Each phase reopens twice without retry; broken/restored authority stays inert; exact history/diff readable                                                                                            | full format-2 quarantine restore/rebind remains OPEN                                                    |
| 11  | Desktop attachment enroll/upload/preparation and runtime publication                                | owner intent, upload/preparation records, archive, publication marker                                                         | `apps/cli/src/local-runtime/desktop-assets-process.test.ts` (SIGKILL upload/preparation aliases and publication), `desktop-assets-native.test.ts`, race suites                                                                                                                   | actual SIGKILL                                             | Two names survive the link/unlink kill and retry is refused; quarantine evidence is inert; capture refuses the alias shape without repair                                                             | GUI/installed Desktop open; capture refuses alias state                                                 |

## Boundaries closed by 7.11

### A. Immutable changeset capture (`coding-capture-crash.test.ts`)

Real child runtime opens the product `CodingChangesetService` over the same
durable profile and Git worktree; the parent kills it at three named boundaries:

- `scan`: the real Git scan finished in memory, before any store transaction.
- `artifact`: the `INSERT INTO ocean_changesets` statement ran inside the capture
  transaction, before the receipt insert and `COMMIT`.
- `committed`: the capture returned, so row + receipt committed before the caller
  observed the receipt.

After each kill the test opens the profile twice and proves: `scan`/`artifact`
leave exactly zero changeset and receipt rows (WAL rollback; no torn artifact);
the retry is a single fresh capture of the current tree and inserts the artifact
and receipt atomically; `committed` reopens return the exact byte-identical
frozen artifact with zero new snapshot scans and no duplicate/overwritten row;
an old request id is never redirected to a later tree while a new request id
creates a new immutable artifact. A stale scan is rejected by the existing
`stale_capture` regression (`coding-worktree.test.ts`). The product writes the
artifact and capture receipt in one SQLite transaction, so the brief's
"durable artifact, unsettled receipt" interval cannot exist; the test proves the
actual atomic shape instead of inventing a seam.

### B. Test result persistence (`coding-test-persist-crash.test.ts`)

Real runtime child sends a turn that reads the repaired file and runs the
registered preset through the real sandbox, then halts after
`SqliteCodingTestEvidenceStore.put` and is SIGKILLed before `journal.settle`.
Both reopenings retain exactly one passed evidence row (`codingTestPassed` true)
while the shared journal reports `coding_test`/`uncertain` and refuses any new
claim. A later exact owner path is separate: a real reviewed approval over the
retained evidence satisfies `codingApplicationVerified`, yet `codingApply.apply`
still returns `coding_denied` because the unresolved effect holds admission, and
the owner confirmation is never reached. Test presets have no owner resolution
command, so the hold is documented rather than fictionalised.

### C. Test spawn/exit/cleanup (`coding-test-spawn-crash.test.ts`)

- Runtime `SIGKILL` while the real native preset is running: both reopenings
  report the started claim as `uncertain`, retain no evidence, refuse a new
  claim, and leave worktree bytes exactly unchanged. The orphaned unit is waited
  out; the runtime never observed its exit, so nothing is counted as passed.
- Supervised cgroup stop while the preset runs: the runtime survives and records
  real evidence, but exit/cleanup evidence is not passed because the run was not
  observed to complete; the journal settles failed and source bytes are
  unchanged.

That second case exposed a real defect. systemd treats `SIGTERM` as a clean
service exit, so `systemd-run --wait` returned exit 0 for an externally stopped
unit; the runtime recorded `reason=exit`, `exitCode=0`, confirmed cleanup and
therefore `codingTestPassed=true`. The minimal fix in
`packages/tools-node/src/sandbox-supervision.ts` makes the worker report a
per-run completion sentinel only when its child exited on its own
(`signal === null`); a signal-terminated or stopped unit the runtime did not
observe complete yields `reason=unavailable` (or a non-zero code) and can never
be recorded as passed. A run of the new regression against pre-fix source failed
with `expected true to be false` on `codingTestPassed`
(`task-crash-red-sentinel.log`); the same test passes on the fixed source
(`task-crash-green-sentinel.log`). Ordinary exit-0 runs still pass (workflow
native suite).

### D. Runtime-level file replacement

Already covered, not duplicated: `decision-crash.test.ts` phase `effect` kills a
real runtime at the shared-journal settlement after an actual admitted
`sandboxFile` replacement of `math.cjs`; two reopenings preserve the replacement
bytes and the uncertain journal, and never redispatch. The finer displacement
rename boundary remains covered at worker level by `sandbox-file-crash.test.ts`.
No new product seam was added for the adapter internals.

## Run record (2026-11-03, BASE `fd53d21` + this local change)

| Invocation                                                                                                                | Result           |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `OCEAN_SANDBOX_NATIVE=1` process config: `decision-crash.test.ts`                                                         | 5 passed         |
| `OCEAN_SANDBOX_NATIVE=1` process config: new capture + persist + spawn crash suites                                       | 3 + 1 + 2 passed |
| `OCEAN_SANDBOX_NATIVE=1` process config: `coding-worktree-process-recovery.test.ts`, `finalization-crash-process.test.ts` | 6 + 4 passed     |
| source config: `coding-process-recovery.test.ts`                                                                          | 10 passed        |
| source config: sandbox native/command/hold/files/limits/file-crash/create-crash/observation/binding                       | 30 passed        |
| source config: `coding-workflow-native.test.ts`, `coding-dispatch-native.test.ts`                                         | 4 passed         |
| strict changed-test/worker compile (repository strict options)                                                            | exit 0           |

## Open items (not claimed)

- Installed Linux artifact, upgrade and cross-version recovery: **installed
  open** for every row.
- Power loss or filesystem reordering: not qualified; only process `SIGKILL`
  with WAL + `synchronous=FULL`.
- Backup publication/restore has no actual-SIGKILL crash qualification on this
  host; it remains unit-simulation plus real-file fault injection.
- Full format-2 restore/rebind and Desktop GUI/installed attachment operations
  remain open per [coding backup](coding-backup.md) and 7.7/7.9 records.
- Native test-preset kill leaves the orphaned systemd unit to finish on its own;
  the runtime never claims its cleanup, and the test waits for the unique
  preset token to disappear rather than stopping foreign units.
