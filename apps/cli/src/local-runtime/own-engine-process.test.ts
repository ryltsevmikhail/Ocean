import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LocalTurnReceipt } from '@runnets/contracts';
import { ownEngineFixture } from '../../test-fixtures/own-engine-process.js';

it.runIf(process.platform === 'linux')(
  'keeps one local-engine generation after its first independent client disconnects without Codex/Claude',
  async () => {
    const f = await ownEngineFixture('success');
    try {
      await f.owner.ready();
      // Keep the first client connected until the provider is actually streaming, then close it.
      const first = await f.client<{ receipt: LocalTurnReceipt; pid: number }>(`(async()=>{
        const receipt=await client.submit(request);
        const fs=await import('node:fs/promises');
        const deadline=Date.now()+4000;
        while(await fs.readFile(process.argv[1]+'/calls','utf8')!=='dispatch\\n'){
          if(Date.now()>deadline)throw Error('provider did not enter');
          await new Promise(r=>setTimeout(r,10));
        }
        client.close();return {receipt,pid:process.pid};
      })()`);
      expect(first.pid).not.toBe(process.pid);
      expect(first.pid).not.toBe(f.owner.p.pid);
      const receipt = first.receipt;
      const ref = { ...f.scope, runId: receipt.runId };
      expect(await f.peer('getRun', ref)).toMatchObject({
        turnStatus: 'dispatching',
        taskStatus: 'running',
      });
      expect(await f.peer('submit', f.request)).toEqual(receipt);
      f.owner.p.send('success');
      await vi.waitFor(async () =>
        expect(await f.peer('getRun', ref)).toMatchObject({ turnStatus: 'completed' }),
      );
      expect(await f.peer('getReceipt', { ...f.scope, requestId: f.request.requestId })).toEqual(
        receipt,
      );
      const result = await f.peer('getResult', ref);
      expect(result).toMatchObject({
        id: 'reply_' + receipt.turnId,
        body: 'native fixture answer',
      });
      expect(await f.peer('history', f.scope)).toMatchObject([
        { id: receipt.messageId, body: f.request.text },
        result,
      ]);
      expect(readFileSync(join(f.profile, 'calls'), 'utf8')).toBe('dispatch\n');
    } finally {
      await f.close();
    }
  },
  15000,
);
it.runIf(process.platform === 'linux')(
  'retries an actually dropped committed receipt with its original run and conflicts without redispatch',
  async () => {
    const f = await ownEngineFixture('lost');
    try {
      await f.owner.ready();
      const drop = join(f.profile, 'ack.drop');
      writeFileSync(drop, '');
      await expect(f.peer('submit', f.request)).rejects.toThrow('connection_closed');
      expect(existsSync(drop)).toBe(false);
      const receipt = await f.peer('getReceipt', { ...f.scope, requestId: f.request.requestId });
      // The suppressed frame follows the persisted admission; inspect the committed row independently.
      const rows = f.db
        .prepare('SELECT reply FROM ocean_receipts WHERE request_id=?')
        .all(f.request.requestId);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]!['reply']))).toMatchObject({
        kind: 'turn',
        data: {
          requestId: receipt.requestId,
          workspaceId: receipt.workspaceId,
          roomId: receipt.roomId,
          id: receipt.turnId,
          inboundMessageId: receipt.messageId,
          taskRunId: receipt.runId,
        },
      });
      expect(await f.peer('submit', f.request)).toEqual(receipt);
      for (const changed of [{ text: 'changed' }, { to: 'ops' }, { roomId: f.groupId }])
        await expect(f.peer('submit', { ...f.request, ...changed })).rejects.toThrow(
          'request_conflict',
        );
      const ref = { ...f.scope, runId: receipt.runId };
      f.owner.p.send('success');
      await vi.waitFor(async () =>
        expect(await f.peer('getRun', ref)).toMatchObject({ turnStatus: 'completed' }),
      );
      expect(await f.peer('submit', f.request)).toEqual(receipt);
      expect(await f.peer('history', f.scope)).toHaveLength(2);
      expect(readFileSync(join(f.profile, 'calls'), 'utf8')).toBe('dispatch\n');
    } finally {
      await f.close();
    }
  },
  15000,
);
it.runIf(process.platform === 'linux')(
  'recovers an actual durable effect claim as unknown with no replay or confirmed cancellation',
  async () => {
    const f = await ownEngineFixture('claimed');
    try {
      await f.owner.ready();
      const receipt = await f.peer('submit', f.request);
      const ref = { ...f.scope, runId: receipt.runId };
      const claims = () =>
        f.db
          .prepare(
            'SELECT id,tool,task_run_id,attempt_id,fingerprint,outcome FROM tool_invocations_v2',
          )
          .all();
      await vi.waitFor(() => {
        expect(claims()).toMatchObject([{ task_run_id: receipt.runId, outcome: 'started' }]);
        expect(readFileSync(join(f.profile, 'effects'), 'utf8')).toBe('effect\n');
      });
      const original = claims();
      expect(original).toHaveLength(1);
      expect(await f.owner.kill()).toBe('SIGKILL');
      const successor = f.launch('successor');
      await successor.ready();
      expect(await f.peer('submit', f.request)).toEqual(receipt);
      expect(await f.peer('getRun', ref)).toMatchObject({
        turnStatus: 'uncertain',
        resultMessageId: null,
      });
      expect(await f.peer('reviewRoom', f.scope)).toMatchObject({
        runId: receipt.runId,
        turnStatus: 'uncertain',
        relatedPendingEffects: 1,
        effects: [{ id: 'effect', tool: 'fixture', outcome: 'uncertain' }],
      });
      expect(claims()).toEqual(original.map((claim) => ({ ...claim, outcome: 'uncertain' })));
      expect(await f.peer('getResult', ref)).toBeNull();
      const events: { type: string }[] = await f.peer('listEvents', ref);
      expect(
        events.some((e) => ['task_run.cancelling', 'task_run.cancelled'].includes(e.type)),
      ).toBe(false);
      await expect(f.peer('submit', { ...f.request, requestId: 'fresh' })).rejects.toThrow(
        'recovery_required',
      );
      expect(await f.peer('history', f.scope)).toMatchObject([{ id: receipt.messageId }]);
      expect(readFileSync(join(f.profile, 'calls'), 'utf8')).toBe('dispatch\n');
      expect(readFileSync(join(f.profile, 'effects'), 'utf8')).toBe('effect\n');
      expect(readFileSync(join(f.profile, 'successor.calls'), 'utf8')).toBe('');
    } finally {
      await f.close();
    }
  },
  15000,
);
it.runIf(process.platform === 'linux')(
  'lets a frozen RC2 wire client chat while refusing future/plugin operations without authority changes',
  async () => {
    const f = await ownEngineFixture('success');
    try {
      await f.owner.ready();
      const authority = () =>
        [
          'ocean_bots',
          'ocean_plugin_versions',
          'ocean_plugin_connections',
          'ocean_plugin_consents',
          'ocean_plugin_grants',
          'ocean_plugin_confirmations',
          'ocean_plugin_operations',
          'ocean_owner_decisions',
          'ocean_coding_approvals',
          'ocean_coding_approval_claims',
        ].map((table) => f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
      const before = authority();
      const status = await f.legacy<{ result: { capabilities: string[]; state: string } }>(
        'status',
        {},
      );
      expect(status.result.state).toBe('ready');
      expect(status.result.capabilities.some((c) => c.startsWith('plugin.'))).toBe(false);
      expect(await f.legacy('future.operation', { authority: 'all' })).toMatchObject({
        error: { code: 'method_not_found' },
      });
      expect(await f.legacy('plugin.install', { pluginId: 'github' })).toMatchObject({
        error: { code: 'plugin_runtime_upgrade_required' },
      });
      const { result: receipt } = await f.legacy<{ result: LocalTurnReceipt }>(
        'turns.submit',
        f.request,
      );
      expect(receipt.runId).toEqual(expect.any(String));
      const ref = { ...f.scope, runId: receipt.runId };
      expect(
        await f.legacy('receipts.get', { ...f.scope, requestId: f.request.requestId }),
      ).toMatchObject({ result: receipt });
      f.owner.p.send('success');
      await vi.waitFor(async () =>
        expect(await f.legacy('runs.get', ref)).toMatchObject({
          result: { turnStatus: 'completed' },
        }),
      );
      expect(await f.peer('history', f.scope)).toMatchObject([
        { id: receipt.messageId, body: f.request.text },
        { id: 'reply_' + receipt.turnId, body: 'native fixture answer' },
      ]);
      expect(authority()).toEqual(before);
      expect(readFileSync(join(f.profile, 'calls'), 'utf8')).toBe('dispatch\n');
    } finally {
      await f.close();
    }
  },
  15000,
);
