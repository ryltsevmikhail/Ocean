# Task 18.3.1 implementation report

Implemented the bounded normal coding consumer correction on `codex/ocean11-stable`,
starting at `4932a93206c934d9fc740555e11b1f42c8d26a06`. Parent 18.3 acceptance and
independent review remain with the controller. This report describes implemented
consumer behavior; it does not qualify the physical sandbox, native cleanup,
installed clients, remote services or model execution.

## Contracts and implementation

- `CodingServiceDeps.projectId(canonicalRoot)` is optional. Durable runtime
  composition supplies SHA-256 of the UTF-8 canonical root, identical to the
  existing SQLite `codingProjectId`. Ephemeral composition stays disabled.
- Public `codingResourceAdmission(projectRoot, projectId, worktree?)` builds a
  mutation conflict probe, null grant reference, project-wide selector and known
  worktree selector, with canonical root facts. It refuses invalid root/selector
  shapes. This helper creates no claim, grant, executable capability or receipt.
- The adjacent pure `codingResourceWorktree` checks stored task/worktree/lease
  binding consistency. Application and SQLite consumers share this small fact
  predicate; current lease ownership remains the operation service's check.
- `CodingTaskService.authorize` still returns `executionEnabled: false` and checks
  task membership, capability, immutable policy, owner/restored state and current
  original/worktree leases. Its conflict probe uses current durable task/worktree
  facts. Missing ID mapper, mapper exception/invalid result, missing inspector,
  missing/inconsistent worktree facts or lost lease retain global fallback.
- Start never derives authority from the requested path. Its preinspection gate
  permits only read-only canonical project inspection past qualified resource
  evidence; legacy/unqualified holds still stop before inspection. After inspection
  it checks the canonical project-wide footprint before owner consent, after the
  owner await before lease acquisition, and after the second inspection before
  state publication. Cleanliness, participants, owner reservation, request replay,
  project holds and unknown-release behavior remain enforced.
- Cancel uses the known reserved task's canonical footprint and original lease,
  rechecks after owner consent, and preserves conservative release failure. Prepared
  worktrees and disabled/finalizing tasks still require their existing lifecycle.
- SQLite finalization selects journal conflicts against the current target's
  consistent project/worktree footprint. Missing inspector or target facts falls
  back globally. Existing finalization selection checks both live leases before
  opening/consuming the owner decision and before durable disable/release.
- A foreign unquiescent coding claim is excluded only when its associated consumed
  approval/claim/journal passes the existing effective admission and exact guarded
  receipt proof, its owning task/worktree binding agrees, and the established
  resource comparison proves disjointness. `readEffectiveToolAdmission` is the
  extracted existing journal reader; its approval association, fingerprint,
  guarded marker and exact metadata rules are unchanged. Missing/orphaned,
  contradictory, unguarded, legacy and unqualified claims remain global.
- All own-task provider, pending approval, review, worktree, evidence/cleanup and
  unresolved claim holds remain. A is never settled, acknowledged, rewritten,
  released or replayed to finish B. Original-source apply keeps the existing global
  exact owner/review/changeset admission path.

No domain, SDK, schema, authority engine, counter, UI, scheduler, installation,
launcher, credential, service or profile changes were made. Production consumers
use public package entries. Every owned source/fixture/test is at most 300 physical
lines (largest: normal factory test, 291; coding service, 289).

## RED recorded before production edits

All commands below use the unchanged private runner:

```text
P = python3 .superpowers/sdd/2026-11-04-ocean-platform/run-private.py
```

This creates disposable HOME/XDG/TMP directories with a minimal environment and
removes them after the command. No real session/profile/database is used.

1. `P pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/coding-consumer-scope.test.ts`
   exited 1: 2 tests failed. Actual `CodingTaskService.authorize(B)` returned
   `recovery_required`; actual finalization service preview rejected with
   `finalization_effects_held`.
2. `P pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/coding-turn-factory.test.ts`
   exited 1: 1 failed, 1 passed. Actual normal `codingTurnFactory.forTurn(B)` threw
   `ToolError: coding recovery required`; the conflicting-task refusal passed.

Both fixtures used actual SQLite approval/grant/journal/claim semantics and an
actual guarded A dispatch that sent exactly once and returned uncertain. The
factory test scripts only the qualified platform session; it does not fake task
service, authorization, approvals, owner grants, journal or executable dispatch
checks. The finalization test uses actual service/store/SQLite decisions with a
scripted external lease registry port; its release asserts durable disable first.

## GREEN and scope evidence

The normal factory now reads project instructions, dispatches an edit, runs the
registered preset, records test evidence and obtains results under B's owner grant
without an owner prompt. Its normal per-call admission and real guarded approval
claim/dispatch checks all run. Then the same B task is previewed, explicitly
owner-confirmed, durably disabled, released and published finalized through the
actual finalization service. Only B's original lease is released, as specified by
existing finalization behavior. A's serialized task/worktree/approval/claim/journal
rows, grant and spent allowance remain identical; A's holds remain unchanged.

Additional regressions cover:

- Same task and exact root/worktree collision refusal (including SQLite uniqueness),
  case aliases, nested resource roots, equal project IDs and contradictory worktree
  identities; project-wide probes include both known canonical footprints.
- No mapper, invalid/throwing mapper, no conflict inspector, missing worktree and
  lost lease fallback. Canonical alias resolution happens through project inspect.
- Normal factory restored/review/lease refusal; late changes during qualification,
  before a call, after preparation, during owner await/current binding, and grant
  revocation or lease loss at guarded dispatch. Each sends zero B effects.
- Start reserve/replay/cancel independence, legacy preinspection refusal, conflicts
  after inspection, owner consent and second inspection; unused-lease release and
  cancellation lease loss/unknown release conservatism.
- Foreign missing admission/approval/claim/journal/owning task, incorrect fingerprint
  and unguarded receipts remain global. Reads of holds do not mutate history.
- B's own provider, approval, review, non-ready worktree and both lease refusals;
  late conflict invalidates a finalization owner decision without releasing either
  task. Existing evidence/cleanup regressions remain in covering verification.
- Unguarded approval request/decide/consume/claim and source-project apply retain
  global fallback (new checks plus accepted receipt regression suite).

The platform session is scripted and does not execute filesystem edits or native
presets. The asserted retained bytes are authoritative SQLite serialized state,
not a new physical worktree/sandbox qualification. No native/model/GUI/live
positive loop was repeated.

## Verification commands

Covering GREEN, exit 0: 18 files, 206 tests passed:

```text
P pnpm exec vitest run --config vitest.source.config.ts \
 apps/cli/src/coding-turn-factory.test.ts \
 packages/application/src/coding-resource-scope.test.ts \
 packages/application/src/coding-finalization.test.ts \
 packages/application/src/coding-finalization-identity.test.ts \
 packages/application/src/coding-finalization-recovery.test.ts \
 packages/store-sqlite/src/coding-consumer-scope.test.ts \
 packages/store-sqlite/src/coding-consumer-lifecycle.test.ts \
 packages/store-sqlite/src/coding-consumer-finalization.test.ts \
 packages/store-sqlite/src/coding-service.test.ts \
 packages/store-sqlite/src/coding-rejection.test.ts \
 packages/store-sqlite/src/changeset-service.test.ts \
 packages/store-sqlite/src/coding-finalization-claims.test.ts \
 packages/store-sqlite/src/coding-finalization-holds.test.ts \
 packages/store-sqlite/src/coding-finalization-evidence.test.ts \
 packages/store-sqlite/src/coding-finalization-migration.test.ts \
 packages/store-sqlite/src/coding-owner-grant.test.ts \
 packages/store-sqlite/src/coding-admission-receipt.test.ts \
 packages/domain/src/effect-resource-conflicts.test.ts
```

Final strict checks, all exit 0:

```text
P pnpm exec tsc -b --pretty false
P pnpm exec tsc -p tsconfig.tests.node.json --pretty false
P pnpm exec tsc -p tsconfig.tests.desktop.json --pretty false
```

Scoped lint and scoped formatting both exited 0, on exactly these 14 owned paths:

```text
P pnpm exec eslint <paths below>
P pnpm exec prettier --check <paths below>
apps/cli/src/runtime.ts
apps/cli/src/coding-turn-factory.test.ts
packages/application/src/coding-service.ts
packages/application/src/index.ts
packages/application/src/coding-resource-scope.ts
packages/application/src/coding-resource-scope.test.ts
packages/store-sqlite/src/coding-finalization-store.ts
packages/store-sqlite/src/coding-finalization-claims.ts
packages/store-sqlite/src/tool-journal-reads.ts
packages/store-sqlite/src/coding-consumer-scope.test.ts
packages/store-sqlite/src/coding-consumer-lifecycle.test.ts
packages/store-sqlite/src/coding-consumer-finalization.test.ts
packages/store-sqlite/test-fixtures/coding-consumer.ts
packages/store-sqlite/test-fixtures/coding-consumer-finalization.ts
```

Early strict test compilation exposed fixture-only missing turn fields/null stop
reason and an optional inspector invocation; these were corrected. Early scoped
lint rejected a control-character regex; equivalent character-code validation
fixed it. Final strict/lint/covering checks above are clean.

Required single final root checks, on the frozen final source:

| Command               | Exit | Result                                                                                                                                                                                                         |
| --------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P pnpm check`        | 1    | Root main/Node/Desktop typechecks and root lint passed. Source tests: 528 files passed, 1 failed, 17 skipped; 3584 tests passed, 3 failed, 44 skipped. Only the three protected catalog-lifetime cases failed. |
| `P pnpm build`        | 0    | `tsc -b` passed.                                                                                                                                                                                               |
| `P pnpm format:check` | 1    | Exactly the two protected files below failed formatting; all owned source passed.                                                                                                                              |

`pnpm check` stopped at source tests, so its `pnpm test:process` phase was **not
reached**. No process/native/live pass is claimed. Root checks were each run once;
no skips or exclusions were added to obtain the result.

The protected source failures are all in `apps/cli/src/plugin-catalog-lifetime.test.ts`:
published catalog beyond SDK TTL; explicitly stale SDK catalog; delayed stale
refresh outliving the foreground invocation. They remain the planned 18.6 semantic
port debt. Protected format debt is that same test and
`apps/cli/test-fixtures/github-session-rig.ts`.

Full local command logs: `/tmp/ocean-18.3.1-check.log`,
`/tmp/ocean-18.3.1-build.log`, `/tmp/ocean-18.3.1-format.log`. They are disposable
verification output and are not committed. Final `git diff --check` exited 0.
The report was checked separately with
`P pnpm exec prettier --check --ignore-path /dev/null .superpowers/sdd/2026-11-04-ocean-platform/task-18.3.1-report.md`
(exit 0).

## Preservation and delivery

Self-review inspected the complete owned patch, fallback behavior, exact receipt
reuse and the 300-line constraint. No helpers, subagents or reviewer were spawned.
The controller will arrange fresh independent review after the explicit-path
implementation commit. No push/merge was performed.

Protected working-tree bytes were reverified against the handoff:

```text
d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031  apps/cli/test-fixtures/github-session-rig.ts
68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3  apps/cli/src/plugin-catalog-lifetime.test.ts
```

Their existing dirty/untracked/staging state is preserved and excluded from the
owned commit. No stash, reset, clean, exclusions or added skips were used.

## Independent review correction 1

Fix base: `dcb198224398fc16cf4829637812f9edd63b16fe`. Read the complete
`task-18.3.1-review.md` and `task-18.3.1-fix1.md`. Both Important findings were
reproduced and corrected. The review's Minor M1 duplicate finalization reads remain
deferred to ledger F; this correction does not change that path.

### Changed semantics

- I1: `journalCodingApproval` now resolves a journal row's coding association by
  its existing run/attempt/invocation identity before classifying its tool name.
  An associated row with a contradictory tool or fingerprint returns contradictory
  evidence, so the existing effective reader cannot accept its raw metadata as a
  generic receipt. Its existing exact guarded receipt checks continue to apply
  both to pending normal consumers and foreign finalization claims. No new
  association mechanism, journal schema or repair operation was added.
- Legitimately unrelated generic receipts keep their own admission and grant
  accounting, including a remote tool named `coding_write`. Existing no-coding-schema
  and coding-schema colliding-name tests pass, as do two new cases beside an
  actual guarded coding claim using different invocation identities.
- I2: the small pure `qualifiedCodingResourceFootprint` predicate requires a valid
  admission containing only project/worktree selectors and canonical project/root
  facts (plus canonical worktree root for a worktree selector). Start applies it
  before requested-path inspection. Unknown, unsupported, mixed, malformed and
  incomplete footprints stop with zero project inspections, zero owner calls and
  zero lease acquisitions. The requested alias still supplies no scope; the
  existing canonical rechecks after inspection/owner awaits remain unchanged.
- Valid guarded A/disjoint B factory, grant, registered preset and owner-finalization
  positives remain green. Consumers do not rewrite A's records, release its lease,
  settle its unknown effect or infer cancellation/replay permission.

### Correction RED and GREEN

Used the same unchanged private runner `P` defined above. Before production edits:

```text
P pnpm exec vitest run --config vitest.source.config.ts \
 apps/cli/src/coding-turn-factory.test.ts \
 packages/store-sqlite/src/coding-consumer-scope.test.ts \
 packages/store-sqlite/src/coding-consumer-lifecycle.test.ts
```

Exit 1: 3 files failed, 10 tests failed and 42 passed. The tool-only pending-row
case incorrectly authorized B and allowed the normal factory to resolve. With tool
and fingerprint changed and outcome failed, B had no foreign claim hold. Seven
unqualified footprint cases each performed one inspection instead of zero.

After the minimal production edits, the same three files plus
`packages/store-sqlite/src/tool-journal.test.ts` exited 0: 4 files, 57 tests passed.
Final coverage adds direct actual finalization-service refusal for both tampered
outcomes, preservation of A's recorded state/holds/spent call, unrelated generic
receipts, and unknown/malformed/unsupported footprints.

Final covering command is the 18-file command above with
`packages/store-sqlite/src/tool-journal.test.ts` appended. Exit 0: **19 files,
226 tests passed**, no new skips. Final strict/scoped commands all exited 0:

```text
P pnpm exec tsc -b --pretty false
P pnpm exec tsc -p tsconfig.tests.node.json --pretty false
P pnpm exec tsc -p tsconfig.tests.desktop.json --pretty false
P pnpm exec eslint \
 packages/store-sqlite/src/coding-journal-receipt.ts \
 packages/application/src/coding-resource-scope.ts \
 packages/application/src/coding-service.ts \
 apps/cli/src/coding-turn-factory.test.ts \
 packages/store-sqlite/src/coding-consumer-scope.test.ts \
 packages/store-sqlite/src/coding-consumer-lifecycle.test.ts
P pnpm exec prettier --check \
 packages/store-sqlite/src/coding-journal-receipt.ts \
 packages/application/src/coding-resource-scope.ts \
 packages/application/src/coding-service.ts \
 apps/cli/src/coding-turn-factory.test.ts \
 packages/store-sqlite/src/coding-consumer-scope.test.ts \
 packages/store-sqlite/src/coding-consumer-lifecycle.test.ts
```

No root check/build/format, native, model, external-service or GUI loop was repeated.
The original root results above remain facts about the original `dcb1982` source;
this correction's current verification is the covering/strict/scoped evidence here.
All owned source remains within 300 physical lines (factory test 295, coding
service 293). `git diff --check` passed. The protected hashes listed above and
original dirty/untracked/staging state were verified unchanged again. Self-review
covered only I1/I2 and new regression risk. No helper agents/reviewer, push or merge
was used. Controller-owned fresh scoped review remains required before acceptance.
