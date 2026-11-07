import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectLocalRuntime } from '@runnets/tools-node';
import { httpFixture } from '../../../../packages/integrations-mcp/src/prototype-http-fixture.js';
import { privateRoot } from '../../test-fixtures/local-provider-host.test.js';
import {
  configureService,
  pendingService,
  journal,
} from '../../test-fixtures/service-confirmation-rig.js';

it('keeps one observing HTTP peer alive across SIGKILL and two owners without replaying an allowed card', async () => {
  const f = await privateRoot();
  const claimObservations: unknown[][] = [];
  const http = await httpFixture('defer-response', undefined, 0, () =>
    claimObservations.push(journal(f.profile)),
  );
  const start = async () => {
    const child = spawn(
      process.execPath,
      [resolve('apps/cli/test-fixtures/service-confirmation-owner.ts'), f.profile],
      { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit') as Promise<[number | null, string | null]>;
    let out = '',
      err = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      err += b.toString();
    });
    await vi.waitFor(() => expect(out, err).toBe('ready\n'), { timeout: 5000 });
    return { child, exited };
  };
  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  const clients: { close(): void }[] = [];
  try {
    first = await start();
    await configureService(f, http.url.href, 'confirm');
    const a = await connectLocalRuntime({ profile: f.profile }),
      b = await connectLocalRuntime({ profile: f.profile });
    clients.push(a, b);
    const scope = { workspaceId: 'ws_ocean', roomId: f.roomId };
    const input = { ...scope, requestId: 'crash', text: 'call' };
    const receipt = await a.submit(input),
      card = await pendingService(a, f);
    const ref = { ...scope, runId: receipt.runId!, decisionId: card.decisionId };
    const preview = await a.decisionPreview(ref);
    expect(await b.getDecision(ref)).toEqual(card);
    await a.resolveDecision({
      ...ref,
      expectedVersion: 1,
      bindingDigest: card.bindingDigest,
      choice: 'allow-once',
    });
    await vi.waitFor(() => expect(http.stats).toMatchObject({ calls: 1, effects: 1 }), {
      timeout: 5000,
    });
    expect(claimObservations).toHaveLength(1);
    expect(claimObservations[0]).toHaveLength(1);
    expect(claimObservations[0]![0]).toMatchObject({ outcome: 'started' });
    const originalJournal = journal(f.profile)[0]!;
    expect(originalJournal['outcome']).toBe('started');
    first.child.kill('SIGKILL');
    const [code, signal] = await first.exited;
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' });
    a.close();
    b.close();
    const modelBefore = readFileSync(join(f.profile, 'confirmation-model-requests'), 'utf8');
    expect(modelBefore).toBe('request\n');
    second = await start();
    const c = await connectLocalRuntime({ profile: f.profile }),
      d = await connectLocalRuntime({ profile: f.profile });
    clients.push(c, d);
    const recovered = await c.getDecision(ref);
    expect(recovered).toMatchObject({ ...card, status: 'allowed', version: 2 });
    expect(await d.getDecision(ref)).toEqual(recovered);
    expect(await d.decisionPreview(ref)).toBe(preview);
    expect(await c.getReceipt({ ...scope, requestId: 'crash' })).toEqual(receipt);
    expect(await d.submit(input)).toEqual(receipt);
    expect(await c.getRun({ ...scope, runId: receipt.runId! })).toMatchObject({
      turnStatus: 'uncertain',
      pendingDecisionIds: [],
    });
    expect(await d.getRun({ ...scope, runId: receipt.runId! })).toEqual(
      await c.getRun({ ...scope, runId: receipt.runId! }),
    );
    expect(
      await c.resolveDecision({
        ...ref,
        expectedVersion: 1,
        bindingDigest: card.bindingDigest,
        choice: 'allow-once',
      }),
    ).toEqual(recovered);
    expect(
      await d.resolveDecision({
        ...ref,
        expectedVersion: 1,
        bindingDigest: card.bindingDigest,
        choice: 'cancel',
      }),
    ).toEqual(recovered);
    const finalJournal = journal(f.profile)[0]!;
    expect({ ...finalJournal, outcome: 'started' }).toEqual(originalJournal);
    expect(finalJournal['outcome']).toBe('uncertain');
    expect(http.stats).toMatchObject({ calls: 1, effects: 1 });
    expect(readFileSync(join(f.profile, 'confirmation-model-requests'), 'utf8')).toBe(modelBefore);
    const stop = await c.stop();
    expect(stop).toMatchObject({ state: 'stopped', outcome: 'complete' });
    expect(await second.exited).toEqual([0, null]);
    console.log(
      JSON.stringify({
        scenario: 'service-confirmation-sigkill',
        firstOwner: { code, signal, confirmedStop: false },
        secondOwner: { stop },
        decisionId: card.decisionId,
        runId: receipt.runId,
        journalIdentity: {
          id: originalJournal['id'],
          taskRunId: originalJournal['task_run_id'],
          attemptId: originalJournal['attempt_id'],
        },
        peerClaimAtRequest: 'started-before-response-and-effect',
        businessRequests: http.stats.calls,
        acceptedEffects: http.stats.effects,
        metadataRequests: http.rows.filter((m) => m === 'tools/list').length,
        modelRequests: 1,
        recoveredOutcome: finalJournal['outcome'],
      }),
    );
  } finally {
    for (const c of clients) c.close();
    if (first && first.child.exitCode === null && first.child.signalCode === null) {
      first.child.kill('SIGKILL');
      await first.exited;
    }
    if (second && second.child.exitCode === null && second.child.signalCode === null) {
      second.child.kill('SIGKILL');
      await second.exited;
    }
    await http.close();
    f.dispose();
  }
}, 20000);
