import { it, expect, vi } from 'vitest';
import { chmodSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { remoteTerminal } from '../../test-fixtures/remote-terminal.test.js';
import { DatabaseSync } from 'node:sqlite';
it('reads the complete task-bound F6 diff without publishing a changeset or exposing the owner view in another room', async () => {
  const f = await codingWorkflowFixture('direct');
  writeFileSync(join(f.worktree, 'math.cjs'), 'a'.repeat(40000) + 'FINAL-DIFF\n');
  const expected = await f.capture('baseline');
  const other = f.runtime.conversations.rooms('ws_ocean');
  if (!other.ok) throw Error('rooms');
  const foreign = other.value.find((r) => r.id !== f.room)!.id;
  f.runtime.close();
  chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
  const run = join(f.directory, 'run');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const host = await startLocalRuntime({ profile: f.directory, provider: null });
  try {
    for (const id of [f.room, foreign]) {
      const ui = await remoteTerminal(f.directory, id, 'task');
      try {
        ui.input.write('\x1b[17~');
        await ui.app.idle();
        const lines = ui.app.selectedRun()?.codingLines?.join('\n');
        if (id === f.room) {
          expect(lines).toContain(expected.hash);
          expect(lines).toContain('FINAL-DIFF');
          expect(lines).toContain('test: no recorded result');
          ui.input.write('\x1b[F');
          expect(ui.app.frame()).toContain('FINAL-DIFF');
        } else {
          expect(lines).toContain('coding_denied');
          expect(lines).not.toContain(expected.hash);
        }
      } finally {
        ui.app.stop();
        await ui.app.idle();
      }
    }
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS n FROM ocean_capture_receipts').get()?.['n']).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await host.stop();
    await host.closed;
    vi.unstubAllEnvs();
    f.close();
  }
});
