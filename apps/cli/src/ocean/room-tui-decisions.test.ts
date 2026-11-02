import { openOceanProfile } from './profile.js';
import { startLocalRuntime } from '../local-runtime/host.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { remoteTerminal } from '../../test-fixtures/remote-terminal.test.js';
import { connectLocalRuntime } from '@runnets/tools-node';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';

it('shows every chunk of an actual scoped review decision and refreshes another owner’s winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-panel-')),
    profile = join(root, 'profile');
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  const r = openOceanProfile(profile, true);
  await r.ready;
  const request = rooms(r.conversations),
    { workspaceId, roomId } = request;
  const turn = await r.chat.send({
    ...request,
    signal: new AbortController().signal,
    emit: () => {},
    provider: {
      id: 'test',
      models: ['test'],
      capabilities: { streaming: true, usage: true, reasoning: false },
      async *stream() {
        yield { type: 'text_delta', text: 'partial' };
      },
    },
  });
  if (!turn.ok || turn.value.status === 'recorded') throw Error('fixture');
  const runId = turn.value.taskRunId;
  await r.toolJournal!.claim(
    'local-effect',
    'head\u009b\u202e' + 'X'.repeat(34000) + 'tail-marker',
    { taskRunId: runId, attemptId: 'owned' },
    'bound',
  );
  await r.toolJournal!.claim(
    'foreign-private',
    'private',
    { taskRunId: 'tr_other', attemptId: 'other' },
    'outside',
  );
  r.close();
  const host = await startLocalRuntime({ profile, provider: null }),
    peer = await connectLocalRuntime({ profile });
  const terminal = await remoteTerminal(profile, roomId);
  try {
    const { app, input, send } = terminal;
    await send('/continue text-only test');
    expect(app.frame()).toContain('Use /review');
    await send('/review');
    await send('/continue text-only end-marker');
    const cards = await peer.listDecisions({ workspaceId, roomId });
    expect(cards).toHaveLength(1);
    const card = cards[0]!,
      ref = { workspaceId, roomId, runId, decisionId: card.decisionId };
    const exact = await peer.decisionPreview(ref);
    expect(exact.length).toBeGreaterThan(32768);
    expect(exact).toContain('head\\u009b\\u202e');
    expect(exact).not.toContain('foreign-private');
    expect(app.frame()).toContain(card.decisionId);
    expect(app.frame()).toContain('pending v1');
    expect(app.frame()).toContain(String(card.expiresAt));
    input.write('y');
    await app.idle();
    expect((await peer.getDecision(ref)).status).toBe('pending');
    input.write('\x1b[F');
    input.write('y');
    await app.idle();
    expect((await peer.getDecision(ref)).status).toBe('pending');
    input.write('\x1b[H');
    const screens = [app.frame()];
    for (let i = 0; i < 55; i++) {
      input.write('\x1b[6~');
      screens.push(app.frame());
      if (screens.at(-1)?.includes('end-marker')) break;
    }
    // These fixture fields and JSON bytes are ASCII after reversible control escaping.
    const rows = [
      card.decisionId,
      card.bindingDigest,
      'expires ' + card.expiresAt,
      ...(exact.match(/.{1,128}/g) ?? []),
    ];
    for (const [page, frame] of screens.entries()) {
      const from = Math.min(page * 14, rows.length - 14);
      expect(frame.split('\n').slice(1, -1)).toEqual(rows.slice(from, from + 14));
    }
    expect(screens.length * 14).toBeGreaterThanOrEqual(rows.length);
    const display = screens.join('\n');
    expect(display).toContain('end-marker');
    expect(display.replace(/\s/gu, '')).toContain('head\\u009b\\u202e');
    expect(display).not.toMatch(/[\u009b\u202e]/u);
    expect(display).not.toContain('foreign-private');
    expect(
      await peer.resolveDecision({
        ...ref,
        choice: 'deny',
        expectedVersion: 1,
        bindingDigest: card.bindingDigest,
      }),
    ).toMatchObject({ status: 'denied' });
    await vi.waitFor(() => expect(app.frame()).toContain('denied v2'), { timeout: 4000 });
    input.write('y');
    await app.idle();
    expect(await peer.continuationApplied(ref)).toBe(false);
    app.stop();
    await app.idle();
    const reopened = await remoteTerminal(profile, roomId);
    try {
      expect(reopened.app.frame()).toContain('denied v2');
      expect(await peer.history({ workspaceId, roomId })).toHaveLength(1);
      await reopened.send('/review');
      await reopened.send('/continue text-only approved after review');
      for (let page = 0; page < 55 && !reopened.app.frame().includes('y allow once'); page++) {
        reopened.input.write('\x1b[6~');
      }
      reopened.input.write('y');
      await reopened.app.idle();
      const winner = (await peer.listDecisions({ workspaceId, roomId })).find(
        (c) => c.status === 'allowed',
      );
      expect(winner?.version).toBe(2);
      expect(await peer.continuationApplied({ ...ref, decisionId: winner!.decisionId })).toBe(true);
      reopened.input.write('\x1b');
      await vi.waitFor(() =>
        expect(
          reopened.app
            .selectedRun()
            ?.stream.some((line) => line.text.includes('future text-only messages allowed')),
        ).toBe(true),
      );
    } finally {
      reopened.app.stop();
      await reopened.app.idle();
    }
    expect(await peer.history({ workspaceId, roomId })).toHaveLength(2);
  } finally {
    terminal.app.stop();
    await terminal.app.idle();
    peer.close();
    await host.stop();
    await host.closed;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
