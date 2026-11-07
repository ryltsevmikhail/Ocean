# Project Desktop

The project client uses the same private Ocean runtime and profile as the bot
Desktop. Its planned flow is project → task → dev run → diff → review → apply.

## Implemented: SDK discovery

A client that negotiates `coding.workspace-v1` can use
`listCodingProjects({ workspaceId, after?, limit? })` and
`listCodingTasks({ workspaceId, projectId, after?, limit? })`. The limit is 1–50
and the next page uses the returned `nextAfter`. Project IDs and canonical roots
come from the existing owner catalog. Task summaries are scoped to that
workspace, registered root, current owner and dev room membership.
Existing `coding.show` and `coding.diff` read task details and previews.

Discovery reads configuration. It does not scan dependency contents, qualify
the sandbox or grant execution. An absent catalog is empty; an invalid or
unavailable catalog is reported separately. Old clients retain their previous
room and coding reads. Restore maintenance and draining runtimes do not
accept the new reads.

The implementation at `c438756` passed independent review and root
check/build/format (4,198 source and 187 process tests). The process tests use
two SDK clients and an owner restart.

## Implemented: reserve with an owner decision

The negotiated SDK now exposes `reserveCodingTask` (`coding.tasks.reserve`).
Supply the workspace, registered project ID, request ID, task ID, and exact
owner/dev and review room/bot IDs. The existing coding service retains strict
workspace-root equality and the CLI's scoped coding policy and test presets.

The runtime saves a `project-setup` card containing the exact reserve request,
service input, project base and policy before acknowledging pending state.
Use the existing decision preview and resolve methods to vote. The response
keeps the decision separate from reservation evidence: `reserved` requires the
exact service receipt, `allowed` is still running, and `unconfirmed` means the
allowed operation has ended without a confirmed receipt. The task metadata
contains no lease or preparation claim.

Identical requests read the saved card and original receipt even after catalog
changes or restart; changed inputs conflict. Disconnect leaves the runtime job
running. Shutdown cancels pending decisions and joins active jobs. Restart
retires pending cards and never resumes or retries an allowed unknown operation.
Clients without `coding.workspace-v1` cannot see or resolve setup cards.
The reserve-only implementation at `7eaa1c1` passed independent review and
root check/build/format (4,212 source and 193 process tests).

## Implemented: prepare with a separate owner decision

`prepareCodingTask` (`coding.tasks.prepare`) accepts only `workspaceId`,
`roomId`, `taskId`, `requestId` and `expectedPolicyVersion`. The runtime resolves
the assigned dev and project from the task, then uses the existing changeset
service. Its separate setup card binds the task, canonical project root/base,
policy and exact worktree root, branch and Git common directory. Neither the
preview nor the public result contains lease material.

The same bounded setup lane owns reserve and prepare jobs. `prepared` requires
an allowed matching card plus a read-only proof of the persisted ready worktree,
current scope/leases and Git binding. `allowed` alone is not completion;
`unconfirmed` means no ready proof after the job ended. Repeating the same
request reads the original card and verifies the worktree again. Changed inputs
conflict. A worktree prepared previously through the CLI returns `existing`
with no new decision or effect. Interrupted, uncertain or stale preparations
are never retried by this route, including after restart. Disconnect detaches;
shutdown cancels pending cards and joins active jobs.

Preparation uses the existing durable worktree intent and source mutation guard.
It does not run a dev turn, edit source files, capture a review or apply changes.
The preparation implementation at `b0f6dec` passed independent review and
root check/build/format (4,226 source and 199 process tests). Native/GUI and live
provider qualification remain separate.

## Implemented: capture and read an immutable diff

A client with `coding.workspace-v1` can use
`captureCodingChangeset({ workspaceId, roomId, taskId, requestId, expectedPolicyVersion })`
(`coding.changesets.capture`) to save the task's current dev worktree snapshot.
The runtime resolves the project and dev scope from stored records. The
explicit capture needs no separate confirmation. The response contains the
scope, hash, base commit, before and after tree hashes, and file count.

Use `readCodingChangeset({ workspaceId, roomId, taskId, hash })`
(`coding.changesets.read`) to read that metadata and its unified diff through
the existing bounded chunk protocol. Repeating the same capture request
returns the original snapshot even after worktree edits or a runtime restart.
Use a new request ID to capture a fresh snapshot. Changed bindings and
unauthorized scopes refuse. Capture leaves the Git worktree and source
checkout unchanged; it does not run a model or apply the diff.
`coding.diff` continues to provide the existing live preview and history.

The capture implementation at `0c8d5e4` passed independent review and root
check/build/format (4,227 source and 202 process tests). Built SDK tests use
two clients and a disposable Git repository to verify that exact-hash reads
return the saved bytes after edits and restart.

## Implemented: owner-approved review of one snapshot

Use `requestCodingReview({ workspaceId, roomId, taskId, requestId, hash })`
(`coding.reviews.request`) with the task's assigned review room and the selected
immutable hash. The pending `project-setup` card binds the snapshot, test
evidence, assigned bot and model. The owner can inspect and resolve it with
the existing decision API. The runtime rechecks that binding and the room's
transfer policy before dispatch. Review uses one metered model request with
the immutable artifact and evidence, without tools or room history.

Repeat the same request to read its current status and recorded verdict.
Changed inputs conflict. The test status describes whether the recorded
evidence matches the snapshot; it does not claim that those tests passed.
The `stale` flag compares stored task and evidence facts. Apply will check
the live trees separately. A verdict has no authority to apply changes.

Closing the client leaves the review with the runtime. Restart preserves
recorded verdicts and unknown outcomes without restarting the model call.
Shutdown waits for active work and distinguishes a settled request from an
unknown external outcome. Older peers cannot see the new review operation.

The implementation at `4ac81a6` passed independent review and root
check/build/format (4,227 source and 210 process tests). The first full check
hit a timeout in an unchanged SQLite race test; that test passed in isolation,
and an unchanged full rerun passed. Provider tests used scripted responses.

## Implemented: apply one approved snapshot

Use `applyCodingChangeset({ workspaceId, roomId, taskId, requestId,
expectedBase, changesetHash, reviewRequestId })` (`coding.changesets.apply`)
from the task's owner/dev room with `coding.workspace-v1`. For an SDK review,
use the completed review's `decision.decisionId` as `reviewRequestId`. The
review must approve that immutable hash, and the task's required passing
test evidence must match the reviewed tree. The runtime checks the live Git
base, source cleanliness and worktree tree hash when opening and resolving
the separate apply card. The apply service rechecks before writing.

The `project-setup` preview shows the source project root, expected base,
changeset hash, file count and exact verdict identity and binding. Use the
existing decision API to confirm it. The apply response keeps the decision
separate from the effect: `completed` requires a recorded receipt, and an
allowed card with no receipt is `unconfirmed`. The receipt includes file
counts and an application ID for the existing `coding.inspect-apply` read.
An interrupted or invalidated card records no application; an uncertain
receipt or orphaned in-progress receipt reports `outcome_unknown`.

Repeating the exact request reads the card and receipt without inspecting Git
again. Changed inputs conflict. Disconnect detaches; shutdown joins the
runtime job. Restart never resumes an approved operation or retries unknown
effects. Native test presets, installed acceptance and the project window are
separate stages.

The implementation at `e86394d` passed independent review and root
check/build/format (4,227 source and 219 process tests). The first full check
hit a timeout in an unchanged SQLite lifecycle test; the isolated test file
and an unchanged full rerun passed. The disposable Git tests cover two peers,
changed inputs, stale evidence and trees, and process kills before a claim
and after file publication. A pre-claim read failure permits clean shutdown
when the journal proves there is no outstanding effect.

## Planned

The project window and its installed acceptance
follow in the [project Desktop plan](../superpowers/plans/2026-11-07-ocean-project-desktop.md).
The published Ocean 1.1.0 bot Desktop stays on its own release revision.
