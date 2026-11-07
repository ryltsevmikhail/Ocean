# Platform stage E — bot chat in the existing Desktop

E20.1 server/public-SDK discovery is accepted at `fdb8d2b` after independent review
without findings. Desktop source integration E20.2 is accepted at `ccf021b` after
one scoped correction and clean re-review. Installed GUI acceptance E20.3 remains
planned. These milestones do not qualify an installed build or stable Ocean 1.1.

## Implemented: a scoped room task index

The existing Ocean Server exposes `roomTasks.list` through public SDK
`roomTaskList`. The independent `room.task-list-v1` feature requires both
`room.tasks-v1` and `room.addressed-history-v1`. Missing support fails explicitly;
it never means an empty task list. Older chat and task operations remain compatible.

Requests specify workspace/room and optional exclusive `beforeSeq` and `limit`
(1–50, default 50). Replies contain one summary per owner root, newest first, and
an explicit continuation. Summaries expose root/start-message IDs, canonical start
sequence, status, revision and current/historical authority; no prompt, grants or
model secrets are copied into the index.

Reads use existing scoped tables and canonical start evidence. The authenticated
host supplies ownership; only an exact verified host binding is current. Historical
roots are read-only and are never adopted. Listing does not wake tasks, invoke models,
change grants or write durable state. Restore-mode/restored-host suppression follows D.

## Verification boundary

Frozen source passed `pnpm check`, `pnpm build` and `pnpm format:check`: 4122 source
and 174 process tests; 44 source and 58 process opt-in skips remain explicit. All 24
changed files are at most 298 physical lines. A separate focused source/process batch
passed 54 tests in 12 files. Final independent review found no issues.

The built owner and two independent public SDK processes demonstrate lost start ACK,
discovery before replay, owner stop/start with a new instance, stable IDs, exact replay
and changed-payload refusal. Listing preserves logical durable-table hashes and
provider/metadata counters. Owner lifetimes restart inside the fixture OS process;
this index-specific test does not claim OS-process crash or live-provider qualification.
Actual old-client negotiation and ordinary chat-history compatibility are covered.

Reproduce root gates from the workspace root, using disposable profile/environment
isolation for qualification. The focused process selector is:

```sh
pnpm build
pnpm exec vitest run --config vitest.process.config.ts \
  apps/cli/src/local-runtime/room-task-list-process.test.ts \
  apps/cli/src/local-runtime/room-tasks-process.test.ts \
  apps/cli/src/local-runtime/room-task-failures-process.test.ts
```

Assistant qualification uses the unchanged private runner for these commands and all
root gates. Earlier failed lint/exact negotiation-fixture runs were retained; the final
corrected frozen candidate passed. Native/live behavior is not inferred from these tests.

## Implemented source: team tasks in the existing Desktop

The room header opens one team-task dialog with the server index, a selected root,
and a separate text-only start form. Ordinary chat, drafts, attachments, vision,
finite broadcast and existing model/service settings retain their paths. Participants
and current service grants are explicit; an empty mandate permits conversation only.
No renderer database, provider SDK, new wire RPC or tool loop was added.

Typed IPC uses the existing authenticated SDK. Profile/instance and room/root scope
fence task reads, grants and actions; an identity mismatch leaves the task view stale.
The assembled Desktop view validates up to 512 rows separately from the 50-row wire
page. One selected root keeps at most one physical observer. Closing a window only
detaches the client. An unknown start retains its exact payload/request ID for explicit
identical replay; refresh never writes. An acknowledged root stop proves its fence,
while unknown cleanup and yielded versus answered slices remain distinct.

Service decisions reuse exact room/run/decision references and version/digest checks.
Stale decisions are visibly refused, and non-service decisions remain read-only with
the supported owner-client route. The independent review's grant-identity gap was
corrected with the existing optional binding/host guard; legacy settings reads stay
compatible. Empty-index, profile/instance mismatch and legacy positive controls passed.

Frozen `ccf021b` passed root `pnpm check`, `pnpm build`, `pnpm format:check` and
`pnpm --filter @ocean/desktop bundle` (actual Vue typecheck, Vite and preload build).
4158 source and 174 process tests passed, with 44/58 configured skips. All changed
source files are within 300 physical lines. These checks establish source integration,
not an installed window, compositor geometry or live-provider behavior.

## Planned: installed GUI acceptance

E20.3 qualifies actual paired installed GUI bytes at three widths with two windows,
keyboard/focus, attachments, restart, receipts and one-effect witnesses.

F still owns final native/preset, device identity, backup, install/rollback, live models,
whole-branch review and release. All historical deferred findings/rulings remain inputs.
