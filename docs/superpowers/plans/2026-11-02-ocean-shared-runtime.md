# Ocean shared local runtime Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development, as already selected by the owner. Implement task-by-task with fresh implementation and independent spec/quality review. Steps use checkbox syntax.

**Goal:** Deliver one local profile runtime, the standard room TUI as its client, and a tested desktop client contract with explicit GUI qualification status.

**Architecture:** Preserve Ocean domain/application services, atomic admission/receipts, effect journal and startup recovery. A Linux Unix-socket host exclusively owns the profile and execution. TUI and desktop observe and decide through one authenticated versioned contract; disconnection does not own execution lifetime.

**Tech Stack:** TypeScript strict, Node26 on Omarchy Linux x86_64, pinned pnpm12.16.1, existing SQLite, Node net and existing PTY/test infrastructure. Desktop UI is already imported in `apps/desktop`; this plan adds no schedules.

**Spec:** [Shared runtime design and acceptance](../../ocean/shared-runtime.md), derived from the owner's 2026-11-02 request. Reference Runne checkout `b0e23ae6`, ExternalLocal/CLI exec, not a new engine implementation.

## Global Constraints

- Domain remains pure; application depends only on domain; I/O stays in adapters; packages use public exports.
- Strict TypeScript; no source file exceeds 300 physical lines; regression tests for behavior changes.
- Persist authoritative state before external effects. Unknown effects never automatically retry; disconnect and process exit do not prove cancellation/descendant termination.
- Room/task/operation/expiry/owner checks and one-use effect claims remain mandatory. Models cannot grant permissions or receive owner connection credentials.
- Installed Ocean1.0 and parallel desktop checkout/branch remain untouched. No automatic stash/reset/clean or credential copying. No live provider calls under expired budgets.
- Preserve existing ACP wire behavior and public formats. New local protocol is version1, distinct from ACP1 and snapshot formats.
- Runtime socket0600, owned endpoint directory0700, descriptor0600. Verify profile/protocol/auth before data. Frame max2MiB, page max200, wait max30seconds; bound client queues.
- Each task: failing regression → minimal implementation → focused GREEN → exact-path commit → independent review. Required final pnpm check, pnpm build, pnpm format:check; native/process qualification separately.

## Review Focus

1. Same requestId after lost acknowledgement or crash must return the original receipt, including the interval before TaskRun creation (Task2/8).
2. Wrong profile, stale socket descriptor, auth/version failure must never fall back to local SQLite ownership (Task1/5).
3. Slow/reconnecting clients cannot block execution, duplicate history or lose pending decisions (Task3/4/8).
4. Concurrent decisions and restored/expired approvals cannot authorize a second effect (Task4/8).
5. Terminal/window close and runtime shutdown must not masquerade as confirmed cancellation; real runtime death keeps unknown outcomes held (Task5/6/8).

## File structure and interfaces

Paths below are planned, not claims of existing modules. Split modules as needed to respect 300 lines; update this map when a reviewed interface changes.

- `packages/contracts/src/local-runtime.ts`, `local-runtime-decisions.ts`, `local-runtime-validation.ts`: protocol DTOs/validation, separately exported from ACP.
- `packages/application/src/room-runtime.ts`, `room-runtime-runs.ts`, `runtime-decisions.ts`, `runtime-decision-ports.ts`: host-neutral admission, snapshot/cancel and decision orchestration; no Node/client DTO imports.
- `packages/store-sqlite/src/runtime-decisions.ts`, versioned schema migration plus memory equivalent: durable decision projection/CAS, reusing coding approval authority.
- `packages/tools-node/src/local-runtime-client.ts`, `local-runtime-framing.ts`, `local-runtime-endpoint.ts`: transport/endpoint adapters, public exports.
- `apps/cli/src/local-runtime/{server,dispatch,lifecycle,connection,owner}.ts`: socket host composed over existing `Runtime` and provider; bounded routing, no duplicate domain logic.
- `apps/cli/src/ocean/{runtime-command,remote-command,remote-chat-book}.ts`: process commands, CLI routing, RunBookPort adapter.
- Existing `ocean/tui.ts`, `tui/options.ts`, `tui/app.ts`, `tui/runs.ts`: narrow renderer ports; no direct profile/provider ownership on room path. Legacy TUI remains compatible.
- `apps/cli/test-fixtures/local-runtime-*.ts`, process tests and PTY acceptance driver: synthetic provider/effect gates, persisted counters, separate client processes.
- `examples/local-runtime-client.mjs`, `docs/integration/local-runtime.md`: desktop-compatible runnable protocol example, reproducible commands/evidence.

Original protocol sketch (implemented names and parameters are recorded in [the integration contract](../../integration/local-runtime.md)): `hello`, `rooms.list`, `rooms.members`, `history.list`, `conversations.execute`, `turns.submit`, `receipts.get`, `runs.list`, `runs.get`, `runs.events`, `observe`, `runs.cancel`, `decisions.list`, `decisions.get`, `decisions.decide`, `runtime.status`, `runtime.stop`. Additional v1 methods are `coding.show`, `coding.diff`, `coding.pending`, `coding.inspectApply`, `reviews.room`, `reviews.run`, `reviews.acknowledge`. They expose existing authorized reads and exact text-only continuation with durable owner decision; never a generic function/path executor. Coding start/review/apply/reconcile-apply are explicitly offline maintenance operations in v1; they do not get mutation RPCs in this delivery.

`LocalRuntimeClient` provides those typed async methods, `close():void` detaches only. Submit input is existing DirectChatRequest data; receipt includes requestId, roomId, messageId/turnId and `runId:string|null`. Run snapshot includes committed version/state/result and pending decision references. `observe({workspaceId,roomId,runId?,cursor?,waitMs?})` returns the authoritative watermarks and a scoped cursor or explicit resync. Numeric history and event positions are paged separately. `decisions.resolve({workspaceId,roomId,runId,decisionId,expectedVersion,bindingDigest,choice})` returns persisted winner/current conflict. Transport authenticates trusted client role; no caller owner boolean.

## Task 1: Profile endpoint and explicit runtime lifecycle

**Files:** contracts local-runtime + validation; tools-node endpoint/framing/client; CLI local-runtime lifecycle/server and ocean/runtime-command; argument/main routing; focused endpoint/process tests.

**Produces:** `startLocalRuntime({profile,provider?}):Promise<LocalRuntimeHost>` for composition/test injection; public client `connectLocalRuntime({profile}):Promise<LocalRuntimeClient>`; host ready/status/stop and verified instance identity.

- [x] Write failing socket/process tests for two clients/one owner, recovery before ready, wrong auth/profile/version, insecure/symlink/stale endpoint, overlong socket path, oversized/fragmented frames and foreign stale-file preservation.
- [x] Run focused tests and record RED. Implement handshake, bounded framing and safe publication/cleanup after existing exclusive `runtime.ready`; no automatic stealing/unlinking live endpoints.
- [x] Add `ocean runtime start|status|stop --profile PATH` (start foreground). Concurrent start refuses; status never opens DB. Restored profile start refuses restore_restricted before provider dispatch/usable endpoint, preserving offline restored read/text-only consent behavior. Stop tracks drain/uncertainty independently of connection close.
- [x] Verify GREEN, run required gates, document lifecycle commands and commit `feat: host one authenticated local runtime per profile`; review.

## Task 2: Durable submit acknowledgement and runtime-owned turns

Implementation and independent review completed through `a042e02`. Application and SQLite recovery are
qualified separately from actual stale-endpoint restart, retained for Tasks 6/8.

**Files:** application room-runtime modules and direct-chat.ts/admission/publication as required; host dispatch/owner; contracts receipts/runs; memory/SQLite tests.

**Consumes:** Task1 transport; existing atomic admitChat receipt path, TaskRunService and recovery.
**Produces:** application admission receipt before awaitable execution; fresh-only runtime-owned execution; read-only receipt/run access with explicit admitted-before-run state.

- [x] RED tests: drop connection from onAdmitted/after commit before response; retry identical request across clients returns original runId; changed text/to/task/room refuses. Unaddressed group submit has runId null, no model dispatch.
- [x] Separate durable acceptance from completion while preserving existing synchronous admission transaction and prepared-answer publication; do not introduce a second unbound dedup store. Register controllers/promises under runtime, not socket. Observe duplicate without dispatch.
- [x] RED→GREEN process restart between admission and TaskRun creation and after dispatch claim: recover conservatively, never resume unknown provider action. Room contention and separate-room isolation stay intact.
- [x] Required gates; commit `feat: acknowledge durable room turns before runtime execution`; review.

## Task 3: Run observation, reconnect and cancellation

Implementation and independent review completed through `579d858`. The wire method `observe` supplies room or run snapshots and an opaque, scope- and instance-bound cursor. `history.list`, `runs.events` and `runs.result` supply committed data. Task 6/8 still owns killed-listener restart and real entry-point qualification.

**Files:** application room-runtime-runs; contracts snapshots/cursors; host dispatch/observation; client; process tests.

**Produces:** room/history/run queries, persisted result snapshots, cursor-based bounded wait/resync and versioned explicit cancel.

- [x] RED tests: disconnect during stream, attach second process to same run, reconstruct history/result once; stale/unknown cursor causes explicit resync, bounded slow observer does not delay provider completion or retain unbounded output.
- [x] Implement snapshot-first reconnect over existing committed events/history. Keep transient chunks optional and private tool data excluded. Runtime restart changes instance identity while durable run cursors remain interpretable.
- [x] RED→GREEN cancellation request/retry/version conflict, provider failure, cleanup uncertain and client detach: only explicit cancel touches controller; never infer confirmed stop from acknowledgement.
- [x] Required gates; commit `feat: observe and cancel durable runs across local clients`; review.

## Task 4: Runtime-owned durable decisions

Independent review passed through `fcaf7e2`. Schema 11 persists owner cards and
CAS outcomes. Shared coding and review ports are available through the SDK.
Task 5 covers the standard TUI decision presentation.

**Files:** application runtime-decision modules, coding-approval and room review owner adapters; domain decision types if needed; memory/SQLite store+migration; host/client decision methods. Task 5 owns the presentation regression for remote decision content.

**Produces:** durable decision identity/version/projection and CAS resolution; trusted runtime owner adapter for existing approval/review services, no UI-local authority.

- [x] RED two-client test: same exact preview/id/version; concurrent allow/deny resolves once; loser sees winner, stale version cannot create permission; effect count at most1.
- [x] Preserve binding/room/task/expiry300000ms/lease/current-source checks and existing consume+journal claim. Persist resolution before waking waiter; race disconnect, expiry, binding mutation and consumption.
- [x] Add transactional schema migration and memory/SQLite equivalence. Restart/restored allowed/pending/consumed decisions cannot revive grants or replay work. Do not rewrite old schema versions in place.
- [x] Cover all existing room TUI coding and review owner prompts explicitly; model cannot invoke decision endpoints or acquire owner credential. Required gates; commit `feat: persist owner decisions independently of clients`; review.

## Task 5: Standard room TUI as a remote client

**Files:** ocean/tui.ts, remote-chat-book, chat-book compatibility path, narrow tui app/options/runs ports; TUI/PTY regression tests.

**Consumes:** Tasks1–4 client; keeps existing RunBookPort renderer semantics and F6/review features through typed remote queries.

- [x] RED PTY test launches standard `ocean tui --profile PATH --room ROOM`, submits input, captures admitted runId, closes terminal while provider is gated. A second process sees same running run and one final response/provider call1.
- [x] Remove openOceanProfile/provider construction/runtime.close from room TUI path. Retain requestId+exact payload until receipt certainty; on reconnect observe original run rather than generating another identity. Distinguish UI quit/detach from explicit cancel key/action.
- [x] Render pending decisions from runtime state and send id/version/binding decisions; reconnect refreshes resolved cards. Add a presentation regression for the full remote preview, visible control escapes, scrolling and card state after another client resolves it. Narrow TuiApp service port without fabricating a TaskRunService to satisfy options.
- [x] GREEN existing room/group/history/coding panel/review tests and legacy terminal behavior. Required gates and implementation commit. Independent review follows the Task 5 report.

## Task 6: CLI ownership routing, ACP and shutdown compatibility

**Files:** ocean/command.ts, arguments, remote-command, operations/profile boundaries; acp compatibility tests; lifecycle recovery tests/docs.

- [ ] RED integration matrix while runtime active: bot add/list, room direct/group/list/members, history, send (including --task), run list/show/review/acknowledge, coding show/diff/pending/inspect-apply route remotely. Exact review and text-only acknowledgement still require runtime-owned owner decisions. coding start/review/apply/reconcile-apply, init/project add/backup/restore and ownership-taking doctor refuse maintenance_required without opening DB. Static doctor checks may run without ownership. No auth/protocol failure falls back to local profile ownership; implement the complete matrix in the design.
- [ ] Preserve documented offline one-shot commands when no runtime exists; standard room TUI requires explicit start. Expose requestId and receipt/runId consistently; CLI interruption policy documented separately from TUI detach.
- [ ] Preserve ACP initialize/session/prompt/update/permission/cancel stdio contracts and safe owner_busy for competing same-profile ownership. Do not advertise shared-room ACP support or remove existing capability checks.
- [ ] Test graceful stop and deadline with active run/decision/sandbox descendants: reject new admissions, retain uncertain cleanup, never close DB under active work or report false confirmed cancellation. Required gates; commit `feat: route profile commands through the active runtime`; review.

## Task 7: Desktop contract and real entry-point qualification

**Files:** apps/desktop/src/host/main.ts and worker/client boundary; examples/local-runtime-client.mjs; docs/integration/local-runtime.md and desktop-client.md; independent-client process tests. Preserve imported attachment behavior. No edits to external desktop checkout or installed application.

- [ ] RED→GREEN independent client process uses only versioned public contract to authenticate, list rooms/history, submit/resume/get result, observe and decide; no Runtime/SQLite/application internals imported. Document a raw-wire hello/submit/read/observe/decision transcript.
- [ ] Migrate the imported `apps/desktop` worker-per-request host (`1c8d8c3`) to the delivered authenticated client port. Qualify штатный `pnpm --filter @ocean/desktop start` against an isolated test profile and deterministic provider. Preserve source checkout/branch/installed app; never use real credentials or user's live profile. Keep scoped attachment import/receipts/history/preview/export; current providers remain text-only, and CLI backup still excludes attachment bytes.
- [ ] Add explicit endpoint/profile configuration to the in-repository host; its current `main.ts`/`worker.ts` has no such seam. Verify window close detaches rather than killing execution. If GUI qualification cannot run, record exact incompatibility and GUI NOT VERIFIED with reason while independent protocol client is verified.
- [ ] Required gates; commit `docs: qualify desktop shared-runtime client contract`; review. GUI status is an explicit acceptance result, not silently omitted.

## Task 8: Four process acceptance cases and candidate evidence

**Files:** local-runtime acceptance tests/drivers, fixture workers/provider counters; docs/integration/local-runtime.md RC evidence and parent Ocean1.1 plan.

- [ ] Run standard TUI PTY detach case and independent second-client reconnect: identical runId, one committed answer, provider counter1.
- [ ] Kill transport after durable submit before receipt: same requestId gives same runId, changed binding refuses, provider counter1. Repeat around runtime restart and admitted-before-run gap.
- [ ] Show pending operation to two separate clients; race decisions, check persisted winner visible to both, stale decision rejected, effect count1.
- [ ] SIGKILL actual runtime after journal started before effect result. Restart/attach both clients; same uncertain outcome, no repeated effect and no confirmed cancellation without evidence. Retain application hold and no-auto-retry.
- [ ] Run root pnpm check, pnpm build, pnpm format:check; record exact test commands/output/counters/platform, ACP and ordinary CLI matrix, socket access negatives, desktop GUI result separately. Live providers not required/authorized for these deterministic gates.
- [ ] Review whole shared-runtime branch scope, fix findings, commit `test: qualify shared runtime tui and desktop protocol`. Only then mark this first delivery complete. Resume remaining Ocean1.1 stage7 backup/restore/installed/liveRC work with runtime ownership assumptions updated. Schedules remain a later explicitly separate stage.

## Execution state

Tasks 1–4 passed independent review. Task 5 implements the standard room TUI migration and awaits independent review. CLI routing, Desktop migration,
killed-listener restart and shared-runtime release acceptance remain open.
The existing Desktop UI was imported from `1c8d8c3`.
Ocean1.1 previous checkpoint: `5d032ae`, 1032 passed/41 skipped, build/format and
14 native tests recorded; these are previous coding recovery evidence, not proof
of shared-runtime acceptance. Workpackage7.5 was stopped before implementation:
its agent reports no source changes, tests, staging or commit. Preserve its brief
and handoff for later resumption. Complete this shared-runtime delivery first,
then continue the still-open Ocean1.1 release gates.
