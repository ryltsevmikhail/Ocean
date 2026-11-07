# Platform stage E — bot chat in the existing Desktop

E20.1 server/public-SDK discovery is accepted at `fdb8d2b` after independent review
without findings. Desktop integration E20.2 and installed GUI acceptance E20.3 remain
planned. This milestone does not qualify an installed build or stable Ocean 1.1.

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

## Planned: current Desktop and installed acceptance

E20.2 adds the server-backed team dialog, separate text-only task input, truthful
work/wait/result/decision states and reconnect/two-client behavior. Existing chat drafts,
attachments, vision, settings and finite broadcast remain. No renderer database or tool
loop is added. E20.3 qualifies actual paired installed GUI bytes at three widths with
two windows, keyboard/focus, attachments, restart, receipts and one-effect witnesses.

F still owns final native/preset, device identity, backup, install/rollback, live models,
whole-branch review and release. All historical deferred findings/rulings remain inputs.
