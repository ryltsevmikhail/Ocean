import { taskRunId } from '@runnets/domain';
import { TaskRunService, executeStep } from '@runnets/application';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { LocalMessage, LocalRuntimeIdentity } from '@runnets/contracts';
import { openOceanProfile } from '../ocean/profile.js';
import {
  hostedRoomTasks,
  attachRoomActor,
} from '../../../../packages/store-sqlite/test-fixtures/room-tasks.js';
import { child } from '../../test-fixtures/model-process-rpc.ts';

it.runIf(process.platform === 'linux')(
  'serves truthful addressed history over the built shared socket to independent current and frozen RC2 clients',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'oa-ah-'));
    const profile = join(root, 'p'),
      runtimeDir = join(root, 'r');
    mkdirSync(runtimeDir, { mode: 0o700 });
    const initialized = openOceanProfile(profile, true);
    await initialized.ready;
    initialized.close();
    const f = hostedRoomTasks(join(profile, 'runtime.sqlite'));
    const scope = { workspaceId: 'ws_fixture', roomId: 'room' };
    let runId: string;
    let expected: readonly LocalMessage[];
    try {
      const start = f.service.startHosted(f.input);
      if (!start.ok) throw Error('fixture_start');
      const actor = await attachRoomActor(f, start.value);
      runId = actor.taskRunId;
      f.store.conversations.atomic((tx) => {
        const source = tx.chatTurn(actor.turnId)!;
        const { roomDelivery: _delivery, ...ordinaryTurn } = source;
        tx.putChatTurn({
          ...ordinaryTurn,
          id: 'ordinary',
          requestId: 'ordinary',
          taskRunId: 'tr_ordinary',
          status: 'completed',
          text: 'ordinary',
        });
        tx.putMessage({
          ...scope,
          id: 'reply_ordinary',
          seq: 2,
          author: 'bot',
          authorBotId: 'a',
          targetBotId: 'a',
          turnId: 'ordinary',
          body: 'ordinary',
          createdAt: '2026-11-06T00:00:00Z',
        });
      });
      for (const [n, text] of ['hello B', 'second B'].entries()) {
        const sent = f.service.send(
          { ...actor, callId: actor.callId + n },
          {
            kind: 'message',
            toBotId: 'b',
            text,
          },
        );
        if (!sent.ok) throw Error('fixture_send:' + sent.error.code);
      }
      const tasks = new TaskRunService({
        log: f.store.log,
        clock: f.service.deps.clock,
        ids: { commandId: () => 'unused', eventId: () => 'unused' },
      });
      const id = taskRunId(actor.taskRunId),
        activation = f.store.conversations.atomic((tx) => tx.chatTurn(actor.turnId)!.activation!);
      for (const [type, payload] of [
        [
          'StartModelRequest',
          { attemptId: actor.attemptId, ordinal: 2, activation, startedAt: '2026-11-06T00:00:03Z' },
        ],
        [
          'SettleModelRequest',
          {
            attemptId: actor.attemptId,
            ordinal: 2,
            finishedAt: '2026-11-06T00:00:04Z',
            completion: { kind: 'terminal', stopReason: 'stop' },
            usage: { kind: 'actual', tokens: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          },
        ],
      ] as const)
        expect(
          (await executeStep(tasks, id, type, payload, (await tasks.state(id)).version)).ok,
        ).toBe(true);
      const preparedVersion = (await tasks.state(id)).version;
      f.store.conversations.atomic((tx) =>
        tx.putChatTurn({
          ...tx.chatTurn(actor.turnId)!,
          status: 'prepared',
          text: 'final',
          preparedVersion,
        }),
      );
      expect(
        (
          await executeStep(
            tasks,
            id,
            'Complete',
            { attemptId: actor.attemptId, summary: 'final' },
            preparedVersion,
          )
        ).ok,
      ).toBe(true);
      f.store.conversations.atomic((tx) => {
        tx.putMessage({
          ...scope,
          id: 'reply_' + actor.turnId,
          seq: 5,
          author: 'bot',
          authorBotId: 'a',
          targetBotId: 'a',
          turnId: actor.turnId,
          body: 'final',
          createdAt: '2026-11-06T00:00:00Z',
        });
        const current = tx.chatTurn(actor.turnId)!;
        tx.putChatTurn({ ...current, status: 'completed' });
        tx.roomTasks!.consume(current.roomDelivery!.deliveryId);
        const task = tx.roomTasks!.task(current.roomDelivery!.taskId)!;
        if (task.kind !== 'bot') throw Error('fixture_assignment');
        tx.roomTasks!.advanceTask(
          { ...task, status: 'completed', lastDeliverySeq: current.readThroughSeq },
          task.revision,
        );
      });
      expected = f.store.conversations.atomic((tx) => tx.history(scope.roomId, 0, 50));
    } finally {
      f.close();
    }
    const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
    const owner = spawn(
      process.execPath,
      [resolve('apps/cli/dist/main.js'), 'runtime', 'start', '--profile', profile, '--json'],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    owner.stdout.on('data', (b: Buffer) => {
      output += b.toString();
    });
    owner.stderr.on('data', (b: Buffer) => {
      errors += b.toString();
    });
    const exited = new Promise<number | null>((done) => owner.once('close', done));
    const peers: ReturnType<typeof child>[] = [];
    try {
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(Error('owner_ready_timeout:' + errors)), 10000);
        const read = () => {
          if (!output.includes('\n')) return;
          clearTimeout(timer);
          owner.stdout.off('data', read);
          const first = JSON.parse(output.split('\n')[0]!) as { data?: { state: string } };
          if (first.data?.state !== 'ready') reject(Error('owner_not_ready:' + output));
          else done();
        };
        owner.stdout.on('data', read);
        read();
      });
      const connect = async (mode: string) => {
        const peer = child('model-process-client.test.ts', [profile, mode], env);
        peers.push(peer);
        const info = (await peer.ready) as {
          pid: number;
          identity: LocalRuntimeIdentity;
          endpoint: string;
          sdk: string;
        };
        expect(info.pid).not.toBe(process.pid);
        expect(info.pid).not.toBe(owner.pid);
        expect(info.endpoint.startsWith(runtimeDir + '/')).toBe(true);
        expect(statSync(info.endpoint).isSocket()).toBe(true);
        expect(info.sdk).toContain('/dist/');
        return { ...peer, info };
      };
      const modern = await connect('sdk'),
        legacy = await connect('rc2'),
        unknown = await connect('unknown');
      expect(legacy.info.endpoint).toBe(modern.info.endpoint);
      expect(unknown.info.endpoint).toBe(modern.info.endpoint);
      await expect(legacy.call('history', { ...scope, limit: 3 })).rejects.toThrow(
        'client_upgrade_required',
      );
      for (const p of [modern, legacy, unknown]) {
        const capabilities = p.info.identity.capabilities;
        expect(capabilities.slice(0, 2)).toEqual(['status', 'stop']);
        expect(capabilities.length).toBeLessThanOrEqual(p === modern ? 80 : 64);
        expect(capabilities.includes('room.addressed-history-v1')).toBe(p === modern);
        expect(await p.call('status')).toMatchObject({ capabilities });
        expect(await p.call('history', { ...scope, limit: 2 })).toEqual(expected.slice(0, 2));
      }
      const rawPage = (p: typeof legacy, params: object) =>
        p.call('raw', { method: 'history.list', params });
      const ordinaryWire = await rawPage(legacy, { ...scope, limit: 2 });
      expect(JSON.stringify(await rawPage(unknown, { ...scope, limit: 2 }))).toBe(
        JSON.stringify(ordinaryWire),
      );
      expect(ordinaryWire).toEqual(
        expected.slice(0, 2).map(({ body, ...m }) => ({
          ...m,
          bodyBase64: Buffer.from(body, 'utf8').toString('base64'),
        })),
      );
      // A candidate page containing peers refuses as a whole, even with an ordinary prefix.
      await expect(legacy.call('history', { ...scope, limit: 3 })).rejects.toThrow(
        'client_upgrade_required',
      );
      await expect(legacy.call('history', { ...scope, after: 2, limit: 1 })).rejects.toThrow(
        'client_upgrade_required',
      );
      await expect(rawPage(unknown, { ...scope, after: 2, limit: 1 })).rejects.toThrow(
        'client_upgrade_required',
      );
      // Retrying the unchanged cursor still refuses; the server never advances it past a row.
      await expect(legacy.call('history', { ...scope, after: 2, limit: 1 })).rejects.toThrow(
        'client_upgrade_required',
      );
      expect(await legacy.call('history', { ...scope, limit: 2 })).toEqual(expected.slice(0, 2));
      const recovered: LocalMessage[] = [];
      while (true) {
        const page = await modern.call<LocalMessage[]>('history', {
          ...scope,
          after: recovered.at(-1)?.seq ?? 0,
          limit: 2,
        });
        if (!page.length) break;
        recovered.push(...page);
      }
      expect(recovered).toEqual(expected);
      expect(recovered.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(recovered.slice(2, 4)).toMatchObject([
        { author: 'bot', authorBotId: 'a', targetBotId: 'b', body: 'hello B' },
        { author: 'bot', authorBotId: 'a', targetBotId: 'b', body: 'second B' },
      ]);
      for (const p of [modern, legacy]) {
        expect(await p.call('getResult', { ...scope, runId })).toEqual(expected[4]);
        expect(await p.call('history', { ...scope, after: 4, limit: 1 })).toEqual([expected[4]]);
      }
      expect(await modern.call('stop')).toMatchObject({ state: 'stopped', outcome: 'complete' });
      expect(await exited).toBe(0);
      expect(errors).toBe('');
    } finally {
      for (const p of peers.reverse()) await p.kill();
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
