// Installed owner restart and older-peer checks, using the existing bounded session/asset helpers.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { inspectExports } from './model-handoff-assets.mjs';
import { button, selectRoom } from './room-task-setup.mjs';
export async function restartTask(inputs, root, fixture, evidence, independent) {
  let s, failure;
  try {
    s = await openModelNativeSession({ ...inputs, root, resumeProfile: fixture.profile });
    await s.runCase(async (step) => {
      const status = await step(() => s.peer.status());
      assert.notEqual(status.instanceId, evidence.instanceId);
      const task = await independent(evidence.query, step, s);
      assert.deepEqual(task.root, evidence.task.root);
      assert.deepEqual(task.history, evidence.task.history);
      await selectRoom(s.page, 'E20 native team', step);
      await step(() => button(s.page, 'Задачи команды').click());
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
    await s?.dispose(failure);
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
