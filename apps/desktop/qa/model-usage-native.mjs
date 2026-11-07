import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { seedModelSettings, workspaceId } from './model-native-seed.mjs';
import { wait } from './current-window.mjs';
const { values } = parseArgs({
  options: {
    'installed-root': { type: 'string' },
    desktop: { type: 'string' },
    root: { type: 'string' },
  },
});
const root = values.root;
const s = await openModelNativeSession({
  installedRoot: values['installed-root'],
  desktopExecutable: values.desktop,
  root,
  ownerHook: join(import.meta.dirname, 'model-recovery-transport.mjs'),
});
const { page, peer } = s;
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
let original;
try {
  await s.runCase(async (step) => {
    const seed = await seedModelSettings(peer, { connectionCount: 2, botCount: 2, step });
    const bot = seed.bots[1].bot;
    const direct = await step(() =>
      peer.openDirect({ workspaceId, requestId: 'usage-room', botId: bot.id }),
    );
    const scope = { workspaceId, roomId: direct.data.id };
    await step(() => button(page, 'Обновить').click());
    await step(() => button(page, '@bot001').click());
    const proofs = [];
    for (const mode of ['actual', 'estimated', 'unavailable', 'held']) {
      writeFileSync(join(root, 'provider-mode'), mode);
      const receipt = await step(() =>
        peer.submit({ ...scope, requestId: 'usage-' + mode, text: 'Synthetic ' + mode }),
      );
      assert.ok(receipt.runId);
      const query = { ...scope, runId: receipt.runId };
      if (mode === 'held') {
        await wait(
          async () =>
            (await step(() => peer.getRunModelExecution(query))).execution?.startedRequests === 1,
          5000,
        );
        const pending = await step(() => peer.getRunModelExecution(query));
        assert.equal(pending.execution.usage.requestCounts.pending, 1);
        const rebound = await step(() =>
          peer.setBotModelBinding({
            workspaceId,
            requestId: 'usage-rebind',
            botId: bot.id,
            expectedProfileVersion: 1,
            binding: { connectionId: 'qa-000', modelId: 'qwen3:1.7b' },
          }),
        );
        writeFileSync(join(root, 'provider-release'), '');
        proofs.push({ pending, rebound });
      }
      await wait(
        async () => (await step(() => peer.getRun(query)))?.turnStatus === 'completed',
        10000,
      );
      const execution = await step(() => peer.getRunModelExecution(query));
      const run = await step(() => peer.getRun(query));
      const result = await step(() => peer.getResult(query));
      const category = mode === 'held' ? 'actual' : mode;
      assert.equal(execution.execution.lastRequest.settlement.usage.kind, category);
      assert.equal(execution.execution.usage.requestCounts[category], 1);
      assert.equal(execution.execution.identity.connectionId, 'qa-001');
      assert.equal(execution.execution.identity.connectionRevision, 1);
      assert.equal(execution.execution.identity.modelId, 'deepseek-flash');
      assert.equal(execution.execution.identity.botProfileVersion, 1);
      assert.ok(result);
      await step(() => button(page, 'Обновить').click());
      await wait(() => step(() => button(page, 'Обновить').isEnabled()), 5000);
      await step(() => button(page, 'Задачи комнаты').click());
      const dlg = page.getByRole('dialog', { name: 'Задачи комнаты' });
      const details = dlg
        .locator('details')
        .filter({ has: page.locator('strong', { hasText: receipt.runId }) });
      await step(() => details.locator('summary').click());
      await step(() => button(details, 'Показать факты модели этого запуска').click());
      const usage =
        category === 'unavailable'
          ? /Последнее использование: unavailable/
          : new RegExp('Последнее использование: ' + category + ': 0');
      await step(() => details.getByText(usage).waitFor());
      await step(() =>
        details
          .getByText('qa-001 · cloud · версия подключения 1 · профиль 1', { exact: true })
          .waitFor(),
      );
      await step(() => page.screenshot({ path: join(root, 'usage-' + mode + '.png') }));
      proofs.push({
        mode,
        receipt,
        run,
        result,
        execution,
        gui: await step(() => details.innerText()),
      });
      await step(() => button(dlg, 'К разговору').click());
    }
    await assert.rejects(
      step(() =>
        peer.getRunModelExecution({
          ...scope,
          roomId: 'other-room',
          runId: proofs[0].receipt.runId,
        }),
      ),
      /unknown_run/,
    );
    saveProof(root, 'usage.json', { synthetic: true, proofs });
    // Hold a real run-facts response, then navigate to another room/bot before it arrives.
    const other = await step(() =>
      peer.openDirect({ workspaceId, requestId: 'facts-other-room', botId: seed.bots[0].bot.id }),
    );
    await step(() => button(page, 'Обновить').click());
    await wait(() => step(() => button(page, 'Обновить').isEnabled()), 5000);
    await step(() => button(page, 'Задачи комнаты').click());
    const dlg = page.getByRole('dialog', { name: 'Задачи комнаты' });
    const first = dlg
      .locator('details')
      .filter({ has: page.locator('strong', { hasText: proofs[0].receipt.runId }) });
    await step(() => first.locator('summary').click());
    writeFileSync(
      join(root, 'fault.json'),
      JSON.stringify({ method: 'runs.modelExecution', release: 'reply' }),
    );
    await step(() => button(first, 'Показать факты модели этого запуска').click());
    await wait(() => step(() => existsSync(join(root, 'held.jsonl'))), 5000);
    await step(() => button(dlg, 'К разговору').click());
    await step(() => button(page, '@bot000').click());
    writeFileSync(join(root, 'release'), '');
    await step(() => button(page, 'Задачи комнаты').click());
    await step(() => dlg.getByText('В этой комнате ещё нет запусков.').waitFor());
    assert.doesNotMatch(await step(() => dlg.innerText()), /qa-001|Последнее использование|tr_/);
    await step(() => page.screenshot({ path: join(root, 'late-facts-other-room.png') }));
    saveProof(root, 'late-facts.json', {
      otherRoom: other.data.id,
      heldRun: proofs[0].receipt.runId,
      newRoomHasNoOriginalFeedback: true,
      held: JSON.parse(readFileSync(join(root, 'held.jsonl'), 'utf8').trim()),
    });
    assert.ok(!existsSync(join(root, 'page-errors.log')));
    const console = existsSync(join(root, 'renderer-console.log'))
      ? readFileSync(join(root, 'renderer-console.log'), 'utf8')
      : '';
    assert.doesNotMatch(console, /^error:/m);
    assert.equal(
      await step(() =>
        page.locator('vite-error-overlay,webpack-dev-server-client-overlay').count(),
      ),
      0,
    );
    saveProof(root, 'health.json', { console, errors: 0, overlays: 0 });
  });
} catch (error) {
  original = error;
  saveProof(root, 'failure.json', {
    error: String(error),
    stack: error.stack,
    body: s.signal.aborted
      ? 'interrupted'
      : await page
          .locator('body')
          .innerText({ timeout: 2000 })
          .catch(() => 'unavailable'),
  });
  throw error;
} finally {
  await s.dispose(original);
}
