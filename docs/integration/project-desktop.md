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

## Planned

Remaining owner operations, the separate project window and its installed acceptance
follow in the [project Desktop plan](../superpowers/plans/2026-11-07-ocean-project-desktop.md).
The published Ocean 1.1.0 bot Desktop stays on its own release revision.
