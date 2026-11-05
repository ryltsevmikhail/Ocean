import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bounded } from './current-window.mjs';
import { saveProof } from './model-native-paths.mjs';

// A delayed observation never authorizes a new action after the owning case expires.
export function writeHandoffMarker(root, name, step) {
  return step(() => writeFileSync(join(root, name), ''));
}

// Every owned cleanup is attempted even when an earlier disposer rejects.
export async function retireHandoff({ terminal, terminalClosed, gui, session, original, root }) {
  const failures = [];
  let tui;
  async function attempt(action) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (terminal)
    await attempt(async () => {
      if (terminal.exitCode === null && terminal.signalCode === null) terminal.kill('SIGTERM');
      const wrapper = await bounded(terminalClosed, 12000, 'TUI wrapper cleanup/join');
      tui = JSON.parse(readFileSync(join(root, 'tui-retirement.json'), 'utf8'));
      assert.equal(tui.wrapperPid, terminal.pid);
      assert.equal(tui.joined, true, 'installed TUI child cleanup not witnessed');
      tui.wrapperExit = wrapper;
    });
  if (gui !== session.desktop) await attempt(() => gui.dispose());
  await attempt(() => session.dispose(original));
  await attempt(() =>
    saveProof(root, 'handoff-retirement.json', {
      primary: original && String(original),
      failures: failures.map(String),
      wrapper: terminal && {
        pid: terminal.pid,
        exitCode: terminal.exitCode,
        signalCode: terminal.signalCode,
      },
      tui,
    }),
  );
  if (failures.length) {
    const error = new AggregateError(failures, 'handoff retirement: ' + failures.join('; '));
    if (original) original.handoffCleanupError = error;
    else throw error;
  }
}
