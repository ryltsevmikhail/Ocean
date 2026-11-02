# Coding changeset review development

Status: stage 6 in progress. Immutable review, durable apply orchestration and
Linux file application are implemented in development source. TUI presentation,
complete dev/review/apply acceptance and stage-7 recovery/release gates remain
open. Ocean 1.0 is the separate released baseline.

## Owner commands

- `ocean coding diff TASK` captures the complete stable changeset.
- `ocean coding review TASK --to REVIEWER` captures and owner-confirms the exact
  handoff, then runs the assigned reviewer separately through the metered model
  path. It requires an explicitly configured provider.
- `ocean coding apply TASK --changeset HASH --review-request ID` uses the saved
  exact artifact and verdict; it never recaptures a different artifact or calls
  the provider. A second interactive owner confirmation displays the exact
  task, changeset and verdict. Redirected stdin/non-interactive terminals cannot
  approve. No model toolset exposes application.

The runtime shares these services with conversation tools. Apply exists only
in durable runtime. Restored profiles cannot exercise coding authority, including
when explicitly opened for restricted read access.

## Immutable review and test evidence

Review binding identifies task, changeset hash, base commit, after-tree hash and
ordered test-evidence hashes. Findings anchor to an existing path, before/after
side and line in that complete immutable artifact. Changed artifact/base/tree
or evidence makes the verdict stale. One request stores at most one verdict.

Owner-confirmed handoff defaults to no private conversation history; explicit
context grants are immutable. The reviewer receives the artifact, bound evidence
and grant only, with no write/read/command tools or dev history. ModelCodingReviewer
uses a separate TaskRun and one metered request, bounded strict JSON parsing,
and host-side exact finding validation. Dispatching intent precedes the model
call; interrupted/failed observation stays uncertain rather than redispatching.

Test evidence binds the approval, registered preset ID, invocation, source and
dependency hashes, exit reason/code, cleanup and retained output. Dispatch records
it before effect settlement. Passed evidence requires exit 0, confirmed cleanup,
untruncated output, unchanged dependencies and exactly the approved source before
and after. Older records without a preset ID cannot establish verification.
Application requires a current approve verdict and passed current evidence for
every registered preset, matching workspace/task/room/bot/worktree/policy.

## Application authority and effects

Admission checks original profile owner, reserved task, ready worktree binding,
current dev/review memberships, both live project/worktree leases and no global
unresolved effect. The service checks clean original base and current task tree
before and after confirmation, obtains the shared effect claim, then repeats
both observations under that claim before any file is marked started. This
closes the concurrent check/claim race found during independent review. Changed
state at that point records not_started with confirmed no file effects.

Schema 9 stores immutable evidence and review requests/verdicts. Schema 10 adds
application receipts. Migration is additive and transactional. SQLite commits
initial receipt plus shared claim atomically; terminal receipt plus journal
settlement are atomic too. Per-file transitions are pending→started→completed,
or started→uncertain. Terminal receipts cannot reopen or replay. Deletions run
deepest first before additions/replacements while retaining original artifact
indexes in the receipt. Multi-file application is not atomic; a partial failure
preserves completed files and a globally blocking uncertain effect.

Linux GitCodingApplyProject observes the verified task tree and applies files
through pinned directory FDs. It rejects links, special/oversized files and
changed preimage bytes/modes. New destinations use link-without-overwrite.
Existing read/write access bits stay private; executable bits follow readable
classes. Added files start at 0600 or 0700. File↔directory refactors remove only
bounded empty directory trees; nonempty/protected directories and links refuse.
Parent/root replacement fails conservatively. No checkout/filter, staging,
commit, push, deploy, stash, reset or clean is invoked.

Recovery intents, staged bytes and retained displaced originals live in the Git
common directory's private ocean-apply-recovery directory on the same filesystem.
Cross-device recovery is refused. Intent/data/directory fsync precede publication;
completion updates the intent by atomic rename. Original inodes are retained
even after success, preserving later writes through an old descriptor. No backup
is deleted or replayed automatically. Stage 7 must include these assets in full
backup/recovery and reconcile unfinished per-file effects.

## Verification and remaining gates

Domain/application regressions cover exact/stale evidence, owner refusal,
per-file state, and concurrent application with deferred source observation.
SQLite disk-reopen tests cover atomic rollback, partial receipts, immutable
transitions, global holds and schema migration failures. Deterministic reviewer
fixtures contain a seeded defect and verify isolation, anchors and metering.

Real temporary Git runtime tests cover application, dirty original, denial,
restored authority, stale worktree, lost lease and both deep file/directory
refactors. They verify original HEAD/index are unchanged and no unresolved claim
is lost. Syscall-boundary fault injection covers concurrent destination/parent
replacement and backup fsync; an open-writer test proves displaced bytes survive.
These do not qualify power loss durability on the target filesystem.

Full stage-6 acceptance still needs real task-bound dev tests followed by seeded
review finding, repair, fresh review and owner apply, plus TUI changeset display.
Native interactive terminal acceptance, crash/backup qualification, installed
Linux candidate and explicitly budgeted live-provider acceptance remain open.
