# Ocean Terminal Clients Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. Follow Task 23 in order.

**Goal:** a project terminal and a bot terminal that attach to the existing Ocean runtime.

**Architecture:** a small terminal chooser opens the existing room TUI. Project
operations use the same SDK and owner decisions as Project Desktop. The terminal
owns only its connection and presentation state.

**Tech stack:** strict TypeScript, Node terminal streams and the existing private
runtime SDK, room TUI and durable receipts.

**Spec:** [Task 23](2026-11-04-ocean-platform.md#task-23-h-два-tui--позднее)
and [platform architecture](../../ocean/platform-architecture.md).

## Constraints and review focus

- Preserve `ocean tui --room ROOM [--task TASK]`, other CLI commands and ACP.
  Use the existing profile, runtime, provider and policies. No schedules or marketplace.
- Select only registered owner projects and current tasks; a project chat binds
  its dev room, bot and task. The assigned room's history may include other
  messages, but project cancellation and decisions must use exact task receipts.
- Scope owner decisions to the selected operation and show the exact preview
  before sending the binding digest and version. Never confirm a model's action
  automatically. Keep a failed admission distinct from an unknown effect.
- Closing a terminal detaches. Reopen against the existing profile and read the
  same run or owner card. No automatic submit or effect replay.
- Keep source files within 300 physical lines. Use pinned pnpm, literal root
  check/build/format and independent review. Run installed PTY checks separately.

## 23.1a — Open a project task in the existing terminal chat

- [ ] Add failing CLI/PTY tests for `ocean tui --projects [--profile PROFILE]`,
      including unsupported runtime, empty catalog, selection, detach and old
      flags. In `apps/cli/src/ocean/arguments.ts` and `command.ts`, reject ambiguous
      `--projects` with `--room` or `--task` before touching the profile.
- [ ] Add `apps/cli/src/ocean/project-tui.ts`: a bounded terminal chooser over
      `listCodingProjects` and `listCodingTasks`. It selects a current task, reads
      its authoritative assignment and opens `runDirectTui` with that scope.
      Reuse `RoomConnection`, `RemoteChatRunBook`, the existing coding panel and
      terminal text escaping. The selected task's submission targets its dev bot;
      use the scoped `getReceipt({ workspaceId, roomId, requestId, taskId })`
      before project cancel or resolving a dev run's decision. Project chat
      offers the selected dev scope; room-wide broadcast and service settings
      remain in the bot TUI. Preserve legacy room behavior and detach semantics.
      No new runtime method.
- [ ] Pass focused tests, exact root gates and independent review. Record commands
      and differences from the bot room mode in the integration docs.

## 23.1b — Exact project operations from the terminal

- [ ] Extend the same project selector with the existing SDK reserve, prepare,
      immutable capture/read, review and apply operations. Present a small menu
      for the selected project/task and use existing room/member lists to choose
      assignments for a new task. Use the established owner CLI for catalog setup.
- [ ] Use runtime decision preview/resolve and persisted status. Show approval
      and result separately; recover existing project cards by exact task scope.
      Keep immutable hash, review ID and base explicit. Use the existing
      `project_pre_card_` refusal distinction; unknown or stale results do not
      permit an automatic repeat or a new source effect.
- [ ] Add tests for two peers, stale/unknown decisions, exact operation preview,
      replay of a result and no source write before approval. Use a disposable
      Git fixture and scripted model. Pass exact root gates and independent review.

## 23.2 — Bot terminal entry

- [ ] Add `ocean tui --bots [--profile PROFILE]` as a room picker over the existing
      runtime room list and `runDirectTui`. Preserve the same room chat, named bots,
      history, explicit target, observation and cancellation. Reuse the terminal
      chooser and preserve the existing explicit `--room` invocation.
- [ ] Test empty/old runtime, selecting direct and group rooms, two peers and
      detach/reconnect. No change to ACP or bot Desktop. Pass exact root gates and
      independent review; document the two modes.

## 23.3 — Installed terminal acceptance

- [ ] Use exact packaged Linux CLI in a disposable prefix/profile. Start one
      runtime, launch both modes in real PTYs, observe the same durable room/run
      from another SDK client, close and reopen without replay. Exercise the
      project path through an exact owner decision and preserve unknown state.
      Verify existing room command and ACP on the same qualified bytes.
- [ ] Record source, package SHA-256, commands, checks and process retirement.
      Review the whole branch, publish accepted changes through a verified PR and
      keep the published v1.1.0 tag unchanged.
