// Installed owner restart and older-peer checks, using the existing bounded session/asset helpers.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, lstatSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { inspectExports } from './model-handoff-assets.mjs';
import { button, selectRoom } from './room-task-setup.mjs';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import process from 'node:process';
import { processIdentity } from './desktop-launcher.mjs';
export async function retireTaskSession(s, original, expectedUnknown = false) {
  try {
    await s.dispose(original);
  } catch (error) {
    if (original || !expectedUnknown) throw error;
    const proof = JSON.parse(readFileSync(join(s.fixture.root, 'cleanup.json'), 'utf8'));
    assert.equal(proof.interrupted, false);
    assert.equal(proof.failures.length, 2);
    assert.match(proof.failures[0], /'uncertain'[\s\S]*'complete'/);
    assert.match(proof.failures[1], /Desktop launcher close timed out/);
    const retired = [...proof.owner, ...proof.desktop].map(({ pid, start }) => {
      const now = processIdentity(pid),
        same = now?.start === start;
      assert.ok(!same || now.state === 'Z', 'recorded task process still live');
      return { pid, start, sameIdentity: same, state: same ? now.state : null };
    });
    assert.match(proof.short, /^\/tmp\/oa-native-[a-zA-Z0-9]+$/);
    const stat = lstatSync(proof.short);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid());
    s.fixture.retainedShort = proof.short;
    saveProof(s.fixture.root, 'uncertain-retirement.json', {
      runtimeStop: 'uncertain',
      cancellationConfirmed: false,
      retired,
      retainedExactShort: proof.short,
    });
  }
}
export function mapTaskSockets(v) {
  for (const key of ['wayland-socket', 'hypr-command-socket']) {
    const stat = lstatSync(v[key]);
    assert.ok(stat.isSocket());
    assert.equal(stat.uid, process.getuid());
  }
  assert.equal(basename(v['hypr-command-socket']), '.socket.sock');
  const signature = basename(dirname(v['hypr-command-socket']));
  assert.match(signature, /^[a-zA-Z0-9_-]+$/);
  const mapping = join(process.env.XDG_RUNTIME_DIR, 'hypr', signature);
  mkdirSync(mapping, { recursive: true, mode: 0o700 });
  symlinkSync(v['hypr-command-socket'], join(mapping, '.socket.sock'));
  process.env.HYPRLAND_INSTANCE_SIGNATURE = signature;
  process.env.WAYLAND_DISPLAY = v['wayland-socket'];
  return mapping;
}
export const independentTask = (installed, original) => async (query, step, session) => {
  const fixture = session?.fixture ?? original;
  const r = await step(() =>
    promisify(execFile)(
      process.execPath,
      [
        join(import.meta.dirname, 'room-task-peer.mjs'),
        installed,
        fixture.profile,
        JSON.stringify(query),
      ],
      { env: fixture.env, timeout: 15000, killSignal: 'SIGKILL' },
    ),
  );
  const data = JSON.parse(r.stdout);
  assert.notEqual(data.pid, process.pid);
  return data;
};
export async function restartTask(inputs, root, fixture, evidence, independent) {
  let s, failure;
  try {
    s = await openModelNativeSession({
      ...inputs,
      root,
      resumeProfile: fixture.profile,
      resumeRuntimeDirectory: fixture.env.XDG_RUNTIME_DIR,
    });
    await s.runCase(async (step) => {
      const status = await step(() => s.peer.status());
      assert.notEqual(status.instanceId, evidence.instanceId);
      const task = await independent(evidence.query, step, s);
      assert.deepEqual(task.root, evidence.task.root);
      assert.deepEqual(task.history, evidence.task.history);
      const stopped = await independent(evidence.edges.unknownQuery, step, s);
      assert.deepEqual(stopped.root, evidence.edges.stopped.root);
      await selectRoom(s.page, 'E20 native team', step);
      await step(() => button(s.page, 'Задачи команды').click());
      await step(() =>
        s.page
          .getByRole('button', {
            name: new RegExp(evidence.title ?? 'E20 task: delegate, wait, then one scoped effect'),
          })
          .click(),
      );
      await step(() =>
        s.page.getByRole('heading', { name: new RegExp(evidence.query.rootId) }).waitFor(),
      );
      await step(() => s.page.keyboard.press('Escape'));
      if (evidence.assets) {
        await selectRoom(s.page, 'Handoff files', step);
        const history = await step(() =>
          s.peer.history({ workspaceId: 'ws_ocean', roomId: evidence.assets.assetsRoom }),
        );
        assert.ok(history.some((m) => m.id === evidence.assets.message.id));
        await inspectExports(s, step, { history: true, label: 'restart-originals' });
      }
      const requests = existsSync(join(root, 'provider.jsonl'))
        ? readFileSync(join(root, 'provider.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
        : [];
      assert.equal(requests.filter((r) => r.kind === 'generation').length, 0);
      saveProof(root, 'restart-task.json', {
        stopped,
        status,
        task,
        provider: requests,
        originalProfile: fixture.profile,
      });
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (s) await retireTaskSession(s, failure, true);
    for (const owner of [fixture, s?.fixture])
      if (owner?.retainedShort && !failure) {
        rmSync(owner.retainedShort, { recursive: true });
        saveProof(owner.root, 'final-runtime-directory-cleanup.json', {
          removedExactShort: owner.retainedShort,
          afterRestartRecovery: true,
        });
      }
  }
}
export async function oldTaskPeer(inputs, root, historicalRoot) {
  let s, failure;
  try {
    s = await openModelNativeSession({ ...inputs, root, runtimeRoot: historicalRoot });
    await s.runCase(async (step) => {
      const { peer, page } = s;
      assert.ok(!peer.identity.capabilities.includes('room.task-list-v1'));
      await step(() =>
        peer.setModelConnection({
          connectionId: 'old-cloud',
          requestId: 'old-cloud',
          expectedRevision: null,
          kind: 'cloud',
          providerId: 'deepseek',
          endpoint: 'https://api.deepseek.com',
          auth: 'api_key',
          defaultModelId: 'deepseek-flash',
          key: 'synthetic-old-fixture',
        }),
      );
      assert.equal(
        (await step(() => peer.checkModelConnection({ connectionId: 'old-cloud' }))).check.outcome,
        'ok',
      );
      const bot = (
        await step(() =>
          peer.createBoundBot({
            workspaceId: 'ws_ocean',
            requestId: 'old-bot',
            handle: 'old',
            name: 'Old peer',
            role: 'Synthetic compatibility',
            binding: { connectionId: 'old-cloud', modelId: 'deepseek-flash' },
          }),
        )
      ).bot;
      const room = (
        await step(() =>
          peer.openDirect({ workspaceId: 'ws_ocean', requestId: 'old-direct', botId: bot.id }),
        )
      ).data.id;
      await step(() => button(page, 'Обновить').click());
      await selectRoom(page, '@old', step);
      await step(() => button(page, 'Задачи команды').click());
      const panel = page.getByRole('dialog', { name: 'Задачи команды', exact: true });
      await step(() => panel.getByText(/Задачи команды недоступны у этого runtime/).waitFor());
      assert.equal(await step(() => button(panel, 'Новое поручение').isDisabled()), true);
      const unsupported = await step(() => panel.innerText());
      await step(() => page.keyboard.press('Escape'));
      await step(() =>
        page.getByLabel('Сообщение', { exact: true }).fill('old peer ordinary chat'),
      );
      await step(() => button(page, 'Отправить').click());
      await step(() => page.getByText('Ordinary fixture answer', { exact: true }).waitFor());
      const history = await step(() => peer.history({ workspaceId: 'ws_ocean', roomId: room }));
      assert.ok(history.some((m) => m.body === 'Ordinary fixture answer'));
      saveProof(root, 'old-peer.json', {
        identity: peer.identity,
        historicalRoot,
        unsupported,
        history,
      });
    });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await s?.dispose(failure);
  }
}

export function taskArguments() {
  const { values: v } = parseArgs({
    options: {
      'task-only': { type: 'boolean' },
      'edge-only': { type: 'boolean' },
      ...Object.fromEntries(
        ['installed-root', 'desktop', 'root', 'wayland-socket', 'hypr-command-socket'].map((k) => [
          k,
          { type: 'string' },
        ]),
      ),
    },
  });
  const mapping = mapTaskSockets(v);
  return { v, mapping };
}
