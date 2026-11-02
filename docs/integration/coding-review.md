# Coding changeset review development

Status: stage 6 in progress.

Domain review bindings identify exact task, changeset hash, base commit,
after-tree hash and ordered test evidence hashes. Findings anchor to a path,
before/after side and line in the immutable complete changeset. Missing paths,
absent file sides and invalid lines are refused. A changed artifact, base,
tree or evidence list makes a review stale.

Domain regression tests pass with root check and build. Root formatting is
currently blocked by an unrelated untracked design-assets/character-atlas
file; formatting of the changed domain files passes. Durable handoff/verdict
storage, isolated reviewer input and exact owner-approved application remain
pending.

The application service now creates an owner-confirmed immutable review request
with artifact/test binding and explicit context grants, then validates reviewer
identity, finding anchors and evidence freshness before persisting a verdict.
No conversation-history or tool executor port enters reviewer handoff.
Regression tests verify default empty context, exact seeded-defect artifact,
stale-evidence refusal and one verdict per request. Concrete durable storage,
provider review dispatch and exact application remain pending.
Root check/build pass; global formatting is still blocked by parallel untracked
character-atlas files, while the changed source formatting passes.

Test evidence now has a domain representation binding exact approval identity,
invocation/source/dependency hashes, exit/termination status, cleanup and retained
output. codingTestPassed requires exit 0, confirmed cleanup, untruncated output,
unchanged dependencies and the exact approved source before/after hashes.
Regression cases reject zero-exit results with stale source or incomplete
cleanup/logs. Durable evidence recording and review consumption remain pending.
Root check and build pass; global format check remains blocked by parallel
design-assets files, while changed source formatting passes.

Schema 9 adds immutable test evidence plus review request/verdict tables through
the existing migration transaction. Public SQLite storage can append/list
task-scoped evidence and refuses ID/hash replacement. A disk-backed regression
verifies exact evidence after reopen and task filtering. Existing migration and
restore compatibility now includes schema 9. Root check/build pass; formatting
remains blocked by parallel design-assets/vitest configuration changes outside
this task. Changed store files pass formatting. Runtime evidence capture and
review table adapters remain pending.

Prepared tests now attach a host-owned evidence recorder. Dispatch persists the
validated sandbox result and its content hash before settling the shared effect
claim; recorder failure leaves uncertainty. Durable runtime supplies the SQLite
port and exposes evidence for later review. Native direct/group acceptance
asserts one passed persisted record for allow-once and no record for denial.
Typecheck, ordinary tests, native flows, build and changed-source formatting
pass. Full root check is blocked by parallel design-assets import-rule errors;
lint with that unrelated directory excluded passes.

Public SQLite storage now exposes codingReviews with transaction-local
task/artifact/evidence reads and immutable handoff transitions. Verdicts bind
an explicit request ID and can be inserted only once for its exact reviewer,
room and artifact binding. Completion requires a stored verdict. Disk-backed
tests verify rollback of verdict plus completion, duplicate/mutation refusal
and exact data after reopen. Root check is still blocked by parallel asset lint
errors; scoped lint, full tests, build and changed-source formatting pass.

Reviewer dispatch now persists requested→dispatching before invoking its
host-owned read-only reviewer port. The port receives the immutable changeset,
bound evidence and explicit context grant, with no tools/history dependency.
Success stores an exact verdict; provider/record failure retains uncertainty.
Dispatching, completed and uncertain requests cannot be automatically replayed.
Tests verify intent precedes the external call and both success/failure refuse
second dispatch. SQLite enforces the new irreversible state transitions.
Scoped validation passes; parallel asset/config formatting still blocks the
whole-workspace formatting gate.

ModelCodingReviewer now runs the read-only review through a separate TaskRun
using the normal metered runTurn path with no tool executor/definitions and
one model request. Input contains only the immutable handoff/evidence. Its
bounded JSON parser refuses unknown fields and malformed findings; exact
artifact anchors remain validated before verdict storage.
A deterministic-provider integration test checks a seeded defect, no tools,
isolated input and terminal succeeded TaskRun. No external provider is called.
Typecheck, scoped lint, tests and build pass; whole-workspace lint/format gates
remain blocked by parallel design-assets/config changes.

Durable runtime now composes CodingReviewService over SQLite. CLI coding diff
TASK captures the complete current artifact; coding review TASK --to REVIEWER
checks the exact assigned reviewer/provider, owner-confirms the frozen handoff
and dispatches a separate metered reviewer run with cancellation.
Native direct/group fixtures now exercise CLI diff against real changed/new
artifact capture, checking exact before/after source. No live provider is used.
Typecheck, scoped lint, tests, build and global formatting pass in the current
workspace; root check still fails on unrelated design-assets import restrictions.
