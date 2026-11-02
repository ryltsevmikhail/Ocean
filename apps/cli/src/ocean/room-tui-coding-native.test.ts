import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ProviderPort } from '@runnets/application';
import { connectLocalRuntime } from '@runnets/tools-node';
import { codingWorkflowFixture, repairedMath } from './coding-workflow-fixture.js';
import { registerCodingProject } from './coding-projects.js';
import { remoteTerminal } from '../../test-fixtures/remote-terminal.test.js';
import { startLocalRuntime } from '../local-runtime/host.js';

it.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'a task-bound room TUI allows exact write and test cards, then F6 reads current and stale test evidence',
  async () => {
    const f = await codingWorkflowFixture('direct');
    const task = f.runtime.coding.inspect('ws_ocean', 'task');
    if (!task.ok) throw Error('fixture task');
    await registerCodingProject(
      f.directory,
      { id: 'fixture', root: f.project, testPresets: task.value.policy.testPresets, mounts: [] },
      async () => true,
    );
    f.runtime.close();
    chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const run = join(f.directory, 'run');
    mkdirSync(run, { mode: 0o700 });
    vi.stubEnv('XDG_RUNTIME_DIR', run);
    const content = repairedMath + '// actual preview \u009b\u202e\n';
    const calls = [
      { id: 'r', name: 'read_file', arguments: '{"path":"math.cjs"}' },
      { id: 'w', name: 'write_file', arguments: JSON.stringify({ path: 'math.cjs', content }) },
      { id: 't', name: 'run_test', arguments: '{"presetId":"test"}' },
    ];
    let i = 0;
    const provider: ProviderPort = {
      id: 'fixture',
      models: ['fixture'],
      capabilities: { streaming: true, reasoning: false, usage: true, toolCalls: true },
      async *stream() {
        const call = calls[i++];
        if (call) yield { type: 'tool_call', call };
        else yield { type: 'text_delta', text: 'ready' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield {
          type: 'completed',
          stopReason: call ? 'tool_calls' : 'stop',
          rawStopReason: call ? 'tool_calls' : 'stop',
        };
      },
    };
    const host = await startLocalRuntime({ profile: f.directory, provider }),
      observer = await connectLocalRuntime({ profile: f.directory });
    const ui = await remoteTerminal(f.directory, f.room, 'task'),
      scope = { workspaceId: 'ws_ocean', roomId: f.room };
    try {
      await ui.send('repair and test');
      for (const kind of ['write', 'test']) {
        const card = await vi.waitFor(
          async () => {
            const c = (await observer.listDecisions(scope)).find((r) => r.kind === kind);
            if (!c) throw Error('waiting ' + kind);
            return c;
          },
          { timeout: 12000 },
        );
        await ui.send('/decision ' + card.decisionId);
        expect(ui.app.frame()).toContain(card.decisionId);
        let rendered = ui.app.frame();
        for (let j = 0; j < 100 && !ui.app.frame().includes('y allow once'); j++) {
          ui.input.write('\x1b[6~');
          rendered += ui.app.frame();
        }
        expect(rendered.replace(/\s/gu, '')).toContain(
          kind === 'write' ? 'actualpreview' : '/toolchain/node',
        );
        expect(rendered).not.toMatch(/[\u009b\u202e]/u);
        ui.input.write('a');
        await ui.app.idle();
        expect((await observer.listDecisions(scope)).find((r) => r.kind === kind)?.status).toBe(
          'pending',
        );
        ui.input.write('y');
        await ui.app.idle();
        expect(ui.app.frame()).toContain('allowed v2');
        ui.input.write('\x1b');
        await vi.waitFor(() => expect(ui.app.frame()).not.toContain('Esc close'));
      }
      await vi.waitFor(() => expect(ui.app.selectedRun()?.remote?.turnStatus).toBe('completed'), {
        timeout: 8000,
      });
      expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(content);
      ui.input.write('\x1b[17~');
      await ui.app.idle();
      expect(ui.app.selectedRun()?.codingLines?.join('\n')).toMatch(
        /test: passed; captured tree[\s\S]*evidence [a-f0-9]{64}[\s\S]*exit=0/,
      );
      writeFileSync(join(f.worktree, 'math.cjs'), content + '// changed\n');
      ui.input.write('\x1b[17~');
      await ui.app.idle();
      expect(ui.app.selectedRun()?.codingLines?.join('\n')).toContain('STALE binding/tree');
      expect((await observer.history(scope)).map((m) => m.body)).toEqual([
        'repair and test',
        'ready',
      ]);
    } finally {
      ui.app.stop();
      await ui.app.idle();
      observer.close();
      await host.stop();
      await host.closed;
      vi.unstubAllEnvs();
      f.close();
    }
  },
  30000,
);
