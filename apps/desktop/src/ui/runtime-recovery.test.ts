import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import type * as Vue from 'vue';
import { connectLocalRuntime } from '@runnets/tools-node';
import { openOceanProfile } from '../../../cli/src/ocean/profile.js';
import { startLocalRuntime } from '../../../cli/src/local-runtime/host.js';
import { gatedProvider } from '../../../cli/test-fixtures/local-runtime-admission.test.js';
import { dispatch } from '../host/runtime-client.js';
import { commands, outputs } from '../protocol.js';
import { submitDraft } from './bridge.js';
import { useDesktop } from './state.js';
import { readRoomRuns } from './room-feed.js';
vi.mock('vue', async (original) => ({
  ...(await original<typeof Vue>()),
  onMounted() {},
  onBeforeUnmount() {},
}));

it('pages authoritative turn IDs and preserves the original draft across conflicting independent admission and preparation failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-desktop-recovery-'));
  const profile = join(root, 'profile'),
    run = join(root, 'run');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const rt = openOceanProfile(profile, true);
  await rt.ready;
  rt.conversations.execute({
    type: 'BindWorkspace',
    requestId: 'init',
    workspaceId: 'ws_ocean',
    root,
  });
  rt.close();
  const host = await startLocalRuntime({
    profile,
    provider: gatedProvider(
      async () => {},
      () => {},
    ),
  });
  const client = await connectLocalRuntime({ profile }),
    other = await connectLocalRuntime({ profile });
  let phase = 'normal';
  let original: Extract<ReturnType<typeof commands.parse>, { op: 'send' }> | undefined;
  vi.stubGlobal('window', {
    ocean: {
      async request(raw: unknown) {
        const c = commands.parse(raw);
        if (c.op === 'send' && phase === 'lost') {
          original = c;
          throw Error('connection_closed');
        }
        if (c.op === 'send' && phase === 'preparation')
          return {
            version: 1,
            ok: false,
            error: { code: 'attachment_unavailable', sendStage: 'preparation' },
          };
        try {
          return { version: 1, ok: true, data: outputs[c.op].parse(await dispatch(client, c)) };
        } catch (error) {
          return {
            version: 1,
            ok: false,
            error: {
              code: (error as Error).message,
              ...(c.op === 'send' ? { sendStage: 'refused' } : {}),
            },
          };
        }
      },
    },
  });
  try {
    const bot = await client.createBot({
      workspaceId: 'ws_ocean',
      requestId: 'bot',
      handle: 'dev',
      name: 'Dev',
      role: 'Test',
      provider: 'test',
      model: 'test',
    });
    const room = await client.openDirect({
      workspaceId: 'ws_ocean',
      requestId: 'room',
      botId: bot.data.id,
    });
    const scope = { workspaceId: 'ws_ocean', roomId: room.data.id };
    for (let i = 0; i < 17; i++) {
      const receipt = await client.submit({
        ...scope,
        requestId: crypto.randomUUID(),
        text: 'message ' + i,
      });
      await vi.waitFor(async () =>
        expect((await client.getRun({ ...scope, runId: receipt.runId! }))?.turnStatus).toBe(
          'completed',
        ),
      );
    }
    const state = useDesktop();
    state.room.value = { kind: 'direct', id: room.data.id, botId: bot.data.id };
    state.draft.value = 'original user content';
    phase = 'lost';
    await expect(state.send([])).rejects.toThrow('connection_closed');
    expect(original).toBeDefined();
    await other.submit({
      ...scope,
      requestId: original!.requestId,
      text: 'independent conflicting content',
    });
    phase = 'normal';
    await expect(state.send([])).rejects.toThrow('request_conflict');
    phase = 'preparation';
    await expect(state.send([])).rejects.toThrow('attachment_unavailable');
    expect(state.draft.value).toBe('original user content');
    expect(state.uncertain.value).toBe(true);
    expect(state.sent.value).toBe(0);
    await expect(submitDraft(original!)).rejects.toThrow('attachment_unavailable');
    // Recreate a legacy stored pair whose IDs cannot be converted by prefix removal.
    const db = new DatabaseSync(join(profile, 'runtime.sqlite'));
    let legacyRun: string;
    try {
      const first = db
        .prepare("SELECT id,task_run_id FROM ocean_chat_turns WHERE status='completed' LIMIT 1")
        .get()!;
      legacyRun = String(first['task_run_id']);
      db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
      db.prepare(
        "UPDATE ocean_chat_turns SET id='legacy_unequal',payload=json_set(payload,'$.id','legacy_unequal') WHERE id=?",
      ).run(first['id']!);
      // Seed the historical pair through inserts; current message facts cannot be updated.
      const legacyMessages = db
        .prepare('SELECT * FROM ocean_messages WHERE turn_id=?')
        .all(first['id']!);
      db.prepare('DELETE FROM ocean_messages WHERE turn_id=?').run(first['id']!);
      for (const message of legacyMessages)
        db.prepare('INSERT INTO ocean_messages VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          message['id']!,
          message['workspace_id']!,
          message['room_id']!,
          message['seq']!,
          message['author']!,
          message['target_bot_id']!,
          message['body']!,
          message['created_at']!,
          message['author_bot_id']!,
          'legacy_unequal',
        );
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const snapshots = await readRoomRuns(scope.roomId);
    expect(snapshots).toHaveLength(18);
    expect(snapshots.every((r) => r.turnId !== r.runId)).toBe(true);
    expect(snapshots.find((r) => r.runId === legacyRun)?.turnId).toBe('legacy_unequal');
  } finally {
    client.close();
    other.close();
    await host.stop();
    await host.closed;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves a legacy authoritative turn ID unrelated to the run ID in IPC projection', () => {
  const run = outputs.runs.parse([
    {
      messageId: 'message',
      roomId: 'room',
      turnId: 'legacy_turn',
      runId: 'tr_unrelated',
      version: 1,
      performerId: 'bot',
      turnStatus: 'completed',
      taskStatus: 'succeeded',
      pendingDecisionIds: [],
    },
  ])[0];
  expect(run).toHaveProperty('turnId', 'legacy_turn');
});
