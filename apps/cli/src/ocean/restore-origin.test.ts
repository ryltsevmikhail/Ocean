import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { backupProfile, restoreProfile, digest } from './snapshots.js';
import { codingWorkflowFixture } from './coding-workflow-fixture.js';
import { readCodingBackupInventory } from '@runnets/store-sqlite';
import { createRuntime } from '../runtime.js';
import * as tools from '@runnets/tools-node';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
// Whole native Git/SQLite recovery lifecycle; measured above the 5s unit-test default.
it('retains independently verifiable frozen origin after source deletion and mutable profile use', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'origin-'));
  roots.push(root);
  const home = join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  const f = await codingWorkflowFixture('direct');
  try {
    fs.writeFileSync(join(f.worktree, 'answer.txt'), 'recovered frozen edit\n');
    const artifact = await f.capture('origin-capture');
    f.runtime.close();
    fs.chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
    const inventory = readCodingBackupInventory(join(f.directory, 'runtime.sqlite'));
    fs.writeFileSync(
      join(f.directory, 'coding-projects.json'),
      JSON.stringify([
        {
          id: 'project',
          root: f.project,
          testPresets: inventory.tasks[0]!.policy.testPresets,
          mounts: [],
        },
      ]),
      { mode: 0o600 },
    );
    const archive = join(root, 'archive');
    const manifest = await backupProfile(f.directory, archive, {
      managedDirectory: join(f.directory, 'worktrees'),
    });
    fs.rmSync(f.project, { recursive: true });
    fs.rmSync(f.directory, { recursive: true });
    const profile = join(root, 'restored');
    restoreProfile(archive, profile);
    fs.rmSync(archive, { recursive: true });
    if (manifest.format !== 2) throw Error('expected format 2');
    const verified = tools.verifyRestoredProfileOrigin?.(profile, manifest);
    expect(verified?.catalog.inventory.changesets[0]?.hash).toBe(artifact.hash);
    expect(fs.existsSync(join(profile, 'restore-origin', 'runtime.sqlite'))).toBe(true);
    expect(digest(join(profile, 'restore-origin', 'runtime.sqlite'))).toBe(manifest.sha256);
    expect(
      JSON.parse(fs.readFileSync(join(profile, 'restore-origin', 'snapshot.json'), 'utf8')),
    ).toEqual(manifest);
    expect(fs.readFileSync(join(profile, 'assets', 'evidence', 'catalog.json'), 'utf8')).toContain(
      artifact.hash,
    );
    const runtime = createRuntime({
      dbPath: join(profile, 'runtime.sqlite'),
      restoredAccess: true,
    });
    await runtime.ready;
    const sent = await runtime.chat.send({
      workspaceId: 'ws_ocean',
      roomId: f.room,
      requestId: 'new-restored-text',
      text: 'new text under quarantine',
      provider: {
        id: 'fixture',
        models: ['fixture'],
        capabilities: { streaming: true, reasoning: false, usage: true },
        async *stream() {
          yield { type: 'text_delta', text: 'local synthetic response' };
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
        },
      },
      signal: new AbortController().signal,
      emit: () => {},
    });
    expect(sent.ok).toBe(true);
    runtime.close();
    expect(digest(join(profile, 'restore-origin', 'runtime.sqlite'))).toBe(manifest.sha256);
    fs.unlinkSync(join(profile, 'restore-guard.json'));
    let refusal = '';
    try {
      const bypass = createRuntime({ dbPath: join(profile, 'runtime.sqlite') });
      await bypass.ready;
      bypass.close();
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBe('restore_restricted');
    for (const bytes of ['{}', '{"state":"restoring"}', '{"state":"ready","format":9}']) {
      fs.writeFileSync(join(profile, 'restore-guard.json'), bytes, { mode: 0o600 });
      let rejected = false;
      try {
        const opened = createRuntime({
          dbPath: join(profile, 'runtime.sqlite'),
          restoredAccess: true,
        });
        await opened.ready;
        opened.close();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }
  } finally {
    f.close();
  }
}, 30_000);
