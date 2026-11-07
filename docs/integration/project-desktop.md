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

## Planned

Owner operations, the separate project window and its installed acceptance
follow in the [project Desktop plan](../superpowers/plans/2026-11-07-ocean-project-desktop.md).
The published Ocean 1.1.0 bot Desktop stays on its own release revision.
