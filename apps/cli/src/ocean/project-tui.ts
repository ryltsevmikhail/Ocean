import { createInterface } from 'node:readline';
import type { CodingProjectSummary, CodingTaskSummary } from '@runnets/contracts';
import { visibleControls } from '../tui/decision-panel.js';
import { runDirectTui, type DirectTuiSelector, type TuiStreams } from './tui.js';

const workspaceId = 'ws_ocean';
const limit = 10;
type Page<T> = { items: readonly T[]; nextAfter: string | null };

const chooseProjectTask: DirectTuiSelector = async (connection, input, output, signal) => {
  const reader = createInterface({ input, terminal: false, signal });
  const lines = reader[Symbol.asyncIterator]();
  async function choose<T>(
    label: (row: T) => string,
    fetch: (after?: string) => Promise<Page<T>>,
    empty: string,
  ): Promise<T | undefined> {
    let after: string | undefined;
    for (;;) {
      const { items, nextAfter } = await fetch(after);
      signal.throwIfAborted();
      if (!items.length && !nextAfter) {
        output.write(empty + '\n');
        return undefined;
      }
      output.write(
        items.map((row, i) => `${i + 1}. ${visibleControls(label(row))}\n`).join('') +
          `Choose a number${nextAfter ? ', n for more' : ''}, or q to quit: `,
      );
      for (;;) {
        const line = await lines.next();
        if (line.done || line.value.trim() === 'q') return undefined;
        const answer = line.value.trim();
        if (answer === 'n' && nextAfter) {
          after = nextAfter;
          break;
        }
        const selected = /^[1-9][0-9]?$/.test(answer) ? items[Number(answer) - 1] : undefined;
        if (selected) return selected;
        output.write('Invalid choice. Try again: ');
      }
    }
  }

  try {
    const project = await choose<CodingProjectSummary>(
      (p) => p.id,
      async (after) =>
        connection.withClient(async (c) => {
          const page = await c.listCodingProjects({
            workspaceId,
            limit,
            ...(after ? { after } : {}),
          });
          return { items: page.projects, nextAfter: page.nextAfter };
        }),
      'No registered projects.',
    );
    if (!project) return undefined;
    const task = await choose<CodingTaskSummary>(
      (t) => t.id + (t.worktreeReady ? '' : ' (worktree not prepared)'),
      async (after) =>
        connection.withClient(async (c) => {
          const page = await c.listCodingTasks({
            workspaceId,
            projectId: project.id,
            limit,
            ...(after ? { after } : {}),
          });
          return {
            items: page.tasks.filter((t) => t.status === 'reserved'),
            nextAfter: page.nextAfter,
          };
        }),
      'No current tasks.',
    );
    if (!task) return undefined;

    // Re-read the authoritative assignment after the interactive selection.
    const selected = await connection.withClient((c) =>
      c.codingRead('coding.show', { workspaceId, roomId: task.ownerRoomId, id: task.id }),
    );
    if (
      !('devBotId' in selected) ||
      selected.workspaceId !== workspaceId ||
      selected.id !== task.id ||
      selected.projectRoot !== project.root ||
      selected.ownerRoomId !== task.ownerRoomId ||
      selected.devBotId !== task.devBotId ||
      selected.status !== 'reserved'
    )
      throw Error('coding_denied');
    return {
      roomId: selected.ownerRoomId,
      project: { projectId: project.id, taskId: selected.id, devBotId: selected.devBotId },
    };
  } finally {
    reader.close();
  }
};

export function runProjectTui(options: TuiStreams): Promise<number> {
  return runDirectTui({ ...options, select: chooseProjectTask });
}
