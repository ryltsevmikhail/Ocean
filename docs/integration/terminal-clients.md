# Ocean terminal clients

The terminal clients attach to the same private owner runtime as Desktop.
Start that runtime for the profile before opening a terminal client.

## Implemented: open a project task

```sh
ocean tui --projects --profile /path/to/profile
```

Choose a registered project and one of its current tasks. The chooser reads
the assignment again before opening the existing room TUI. It submits dev
messages with the selected task and assigned bot. The history is the assigned
room's history; cancellation and dev decisions require a receipt for the
selected task. Room-wide broadcast and service controls remain in the room
TUI. This mode requires a runtime with `coding.workspace-v1`.

Closing the terminal detaches. Reopening the task reads the same run and
receipt. The existing `ocean tui --room ROOM [--task TASK]` command keeps its
previous behavior. `--projects` cannot be combined with `--room` or `--task`.

The exact implementation at `206eac6` passed independent review and root
check/build/format (4,269 source and 221 process tests). Built PTY tests cover
the selector-to-chat handoff, hangup and reattachment. The selected dev
handle's explicit `@mention` behavior follows in the next step.

## Planned

The exact owner operation menu, bot room picker and installed PTY acceptance
follow in the [terminal client plan](../superpowers/plans/2026-11-07-ocean-terminal-clients.md).
