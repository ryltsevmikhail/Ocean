# Ocean Project Desktop Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. Follow Task 22 of the [platform plan](2026-11-04-ocean-platform.md) in order.

**Goal:** an independent graphical project client for the existing Ocean runtime:
project → task → dev run → diff → review → explicit apply.

**Architecture:** a separate Desktop entry point shares the Electron shell and
public local SDK. All reads and operations remain in the one runtime that owns
the profile. The first project list uses the existing owner-registered project
catalog; configuration still uses the supported owner CLI.

**Tech stack:** strict TypeScript, Vue/Electron, the existing private Unix
protocol, SQLite and Ocean coding services. No additional database, runner or
model adapter.

**Spec:** [platform architecture](../../ocean/platform-architecture.md),
[Task 22](2026-11-04-ocean-platform.md#task-22-g-графический-клиент-проектов--приоритет-2-после-f).

## Constraints and review focus

- Preserve the published 1.1.0 artifact and the bot Desktop, current CLI/TUI and
  ACP paths. Work in `codex/ocean-project-desktop`; leave the audit checkout alone.
- Keep renderer input behind strict DTOs. A profile, project ID, task, room and
  actor must match authoritative runtime records. No renderer file access or
  lease/capability/token exposure.
- Keep effects behind existing scoped coding services. Dev touches only its
  worktree; review is read-only and sees the selected immutable changeset.
  Apply to source requires a separate owner confirmation of exact base, hash and
  verdict. A model cannot confirm an operation.
- Keep request IDs and effect evidence durable. Reattach or repeat an unchanged
  request to read its facts; a changed request or a stale decision refuses.
  Never replay a marked/unknown effect. A closed window is a client detach.
- New source files ≤300 physical lines; pin pnpm; run root check/build/format
  before accepting each code stage. Keep native/real GUI evidence separate.

## 22.1 — Read the registered projects and tasks through the SDK

- [x] Add RED protocol and store tests. An authenticated new client can page
      registered projects and their current owner tasks; a foreign workspace,
      unknown project, invalid cursor/page and unnegotiated peer refuse.
      An old peer still reads rooms and existing `coding.show`/`coding.diff`.
- [x] Add one negotiated `coding.workspace-v1` marker and strict DTOs in
      `packages/contracts/src/local-runtime-projects.ts`, with bounded
      `coding.projects.list` and `coding.tasks.list`. Add matching methods in
      `packages/tools-node/src/local-project-client.ts` and the existing client
      composition. Check server/SDK capability limits and negotiation per socket.
- [x] Add a small `apps/cli/src/local-runtime/projects-read.ts` host adapter
      using `readCodingProjects` and owner-scoped `ProfileReads`. Extend the
      existing SQLite read projection (split if needed) with a bounded exact
      workspace + registered root + owner + dev room membership query.
      Return only project ID/root/preset IDs and task ID/status/room/bot
      assignments/worktree readiness; never return leases, command argv, mounts
      or secret references. Reuse current chunked coding detail/diff reads.
      Reject malformed or unavailable catalog; never treat it as an empty list.
- [x] Cover two clients and restart via the real built local SDK process
      fixtures. Preserve old/nonnegotiated and restore/drain restrictions.
      Verify strict types, root gates and independent review before 22.2.

Accepted after independent review at `c438756`: root check/build/format 0
(4,198 source and 187 process tests passed). See the
[implemented SDK boundary](../../integration/project-desktop.md).

## 22.2 — Route exact owner operations through the same runtime

- [ ] Reuse `CodingTaskService.start` and `CodingChangesetService.prepare`
      as separate owner decisions, with registered project selection and
      explicit dev/review room + bot IDs. Reuse runtime `turns.submit` with
      `taskId` for dev; preserve room-run receipts, observation and cancellation.
- [ ] Use the current preview read and explicit immutable capture, then
      `CodingReviewService.request/dispatch` on the exact hash via the assigned
      bot's current authorized binding and existing review-only provider path.
      Present review state and tests, including stale status.
- [ ] Route apply to the existing apply service with exact base, changeset and
      review. Use the runtime's durable owner cards and existing operation
      receipts/journal for result reads. Show a decision result separately
      from the effect outcome. Carry no owner waiters across runtime restart;
      preserve current interruption/unknown recovery. Add no generic operation
      framework. Pin exact method DTOs and card types in the task brief after
      22.1 establishes the negotiated read seam.
- [ ] Regressions: scoped roles, exact one-time decisions across two clients,
      identical request receipt and changed request refusal, stale review/apply,
      durable committed recovery and unknown refusal, no bypass of sandbox or
      write to source before allow. Root gates and independent review.

## 22.3 — The project client

- [ ] Add a distinct `--projects` entry point in `apps/desktop/src/host/main.ts`
      and separate `ProjectWorkspace.vue` renderer root. Reuse the existing
      IPC/SDK boundary and client recovery. Keep bot Desktop and project
      renderer state separate; provide separate user data for the two windows.
- [ ] Reuse the existing design tokens, focus styles and scroll structure. Show
      project/task picker, task chat and run status, diff and test evidence,
      review/verdict and exact confirmation/result. Keep all information usable
      at 1024 px. Empty catalog points to owner CLI setup; no new project
      permissions editor or Git client.
- [ ] Component and bridge regressions for stale/error/loading/unsupported
      states, approval races, renderer restrictions, attach and resync. Run
      root gates, Desktop bundle and independent review.

## 22.4 — Installed acceptance

- [ ] Build and launch the actual packaged Project Desktop, bot Desktop and an
      independent peer on one disposable runtime. Use a real Git fixture,
      authorized native worktree/sandbox presets and synthetic model inputs
      for reproducibility. Create/prepare a task, start dev, inspect diff/tests,
      request read-only review, refuse stale apply, then approve exact apply
      and check the source bytes once. Restart/reconnect and verify no replay,
      same task/receipts and correct unknown state.
- [ ] Record precise source/artifacts, root gates, scope and results; publish
      accepted changes through the working branch/PR. Keep 1.1.0 tag unchanged.
      Continue to Task 23 only after acceptance.
