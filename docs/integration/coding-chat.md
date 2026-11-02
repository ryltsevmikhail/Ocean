# Coding conversation integration

Status: stage 5 in progress.

Chat requests can bind an explicit taskId. That identity is included in request
deduplication and persisted as codingTaskId on the admitted turn. A plain chat
retains its historical receipt identity and receives no tools. Task-bound sends
require an injected host factory; a group message without a selected recipient
cannot carry task execution authority.

The common direct/group service requests tools from the factory only for a
fresh admitted task turn. Duplicate receipts never create another factory or
provider dispatch. The factory must recheck current task authority, project
lease, restored state and pending effects. Production factory and command
parsing remain pending. A durable chat regression verifies explicit factory
requirement, task persistence and refusal to reuse a receipt for another task.

CodingTurnTools now provides the shared turn-level tool port. It exposes file
tools and run_test(presetId), expands exact registered argv only in application
code, routes mutations through durable approvals, rejects foreign run contexts
and deduplicates invocation identities. Raw run_command and extra test arguments
are refused before preparation. Uncertain results hold the turn instance.
Regression tests verify preset-only schema/translation and duplicate refusal.
Production host factory wiring remains pending.

The host factory resolves the authoritative task and ready worktree, verifies
project-read admission before and after sandbox qualification, uses complete
Git snapshot manifests, and builds CodingTurnTools over one qualified session.
Owner sandbox/dependency configuration remains an injected host port.
Preparation now binds the actual turn attempt ID; a native session assertion
covers it. Factory injection into runtime/CLI and full direct/group conversation
qualification remain pending.

Durable runtime now accepts explicit owner-supplied sandbox and approval ports
through codingTools options and composes the host factory into its common chat
service. Restored/task authority checks remain in the factory and approval
service. Cancellation is passed from send to the factory's owner port.
Coding tools provide task-specific model instructions using run_test preset
IDs, replacing legacy unrestricted-command instructions for these turns.
A durable chat regression verifies the injected task instructions reach the
provider. CLI configuration and full native direct/group flows remain pending.

CLI send now parses and forwards --task with duplicate, empty and misplaced
option refusal. Legacy send option parsing remains unchanged. Profile opening
can receive trusted codingTools configuration from the host command API.
Without that configuration a task send fails closed. Persistent owner-managed
project/dependency registration and end-user coding start/show commands remain
pending; no automatic toolchain mount selection was introduced.

CLI now exposes coding start with --project, --dev, --review, --room,
--review-room and optional --task-id. It resolves named bots, uses trusted
interactive reservation/worktree previews and calls the existing task/worktree
services. coding show TASK reads the owner-profile task. No bulk confirmation
flag exists and redirected input refuses ownership confirmation.
Presets currently remain empty for this direct-project start path; persistent
project registration, owner-managed dependency configuration and full command
acceptance remain pending.
