import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { seedModelSettings, cloud, local, workspaceId } from './model-native-seed.mjs';
import { recoveryContext } from './model-recovery-context.mjs';
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
const rows = (name) =>
  existsSync(join(root, name))
    ? readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse)
    : [];
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
let original;
try {
  await s.runCase(async (step) => {
    const seed = await seedModelSettings(peer, { connectionCount: 2, botCount: 2, step });
    await step(() => button(page, 'Провайдер').click());
    const dlg = page.getByRole('dialog', { name: 'Провайдер' });
    const selector = dlg.getByLabel(/^Подключение/).first(),
      key = dlg.getByLabel('Ключ API');
    await step(() => selector.selectOption('qa-001'));
    writeFileSync(
      join(root, 'fault.json'),
      JSON.stringify({ method: 'modelConnections.set', release: 'drop' }),
    );
    await step(() => key.fill('synthetic-recovery-original'));
    await step(() => button(dlg, 'Сохранить').click());
    await wait(() => step(() => rows('held.jsonl').length === 1), 5000);
    const held = rows('held.jsonl')[0];
    assert.equal(await step(() => key.inputValue()), '');
    assert.ok(await step(() => button(dlg, 'Сохранить').isDisabled()));
    const committed = (await step(() => peer.listModelConnections())).items.find(
      (x) => x.connectionId === 'qa-001',
    );
    assert.equal(committed.revision, 2);
    await step(() => page.screenshot({ path: join(root, 'key-cleared-in-flight.png') }));
    writeFileSync(join(root, 'release'), '');
    await step(() => dlg.getByText(/Исход операции неизвестен/).waitFor());
    const input = { ...held.input, key: 'synthetic-recovery-original' };
    delete input.keySha256;
    await assert.rejects(
      step(() => peer.setModelConnection({ ...input, defaultModelId: 'deepseek-v4-pro' })),
      /request_conflict/,
    );
    await assert.rejects(
      step(() => peer.setModelConnection({ ...input, key: 'synthetic-wrong' })),
      /request_conflict/,
    );
    const later = await step(() =>
      peer.setModelConnection({
        ...cloud,
        connectionId: 'qa-001',
        expectedRevision: 2,
        requestId: 'later-metadata',
        defaultModelId: 'deepseek-v4-pro',
      }),
    );
    assert.equal(later.revision, 3);
    await step(() => button(dlg, 'Обновить метаданные').click());
    await step(() => key.fill('synthetic-wrong-resupply'));
    await step(() => button(dlg, 'Завершить точный исходный запрос').click());
    await wait(() => step(() => button(dlg, 'Завершить точный исходный запрос').isEnabled()), 5000);
    assert.equal(await step(() => key.inputValue()), '');
    assert.equal(
      rows('rpc.jsonl')
        .filter((x) => x.input.requestId === input.requestId)
        .at(-1).response.error.code,
      'request_conflict',
    );
    await step(() => key.fill('synthetic-recovery-original'));
    await step(() => button(dlg, 'Завершить точный исходный запрос').click());
    await step(() => dlg.getByText(/Исходная операция подтверждена/).waitFor());
    const replay = rows('rpc.jsonl')
      .filter((x) => x.input.requestId === input.requestId && x.response.result)
      .at(-1);
    assert.deepEqual(replay.response.result, held.response.result);
    const attempts = rows('rpc.jsonl').filter((x) => x.input.requestId === input.requestId);
    assert.equal(attempts.length, 5); // original, two explicit peer mismatches, wrong GUI key, exact GUI recovery
    const current = (await step(() => peer.listModelConnections())).items.find(
      (x) => x.connectionId === 'qa-001',
    );
    assert.equal(current.revision, 3);
    assert.equal(current.defaultModelId, 'deepseek-v4-pro');
    saveProof(root, 'recovery.json', {
      held,
      committed,
      later,
      replay,
      current,
      attempts,
      synthetic: true,
    });
    await step(() => page.screenshot({ path: join(root, 'recovered-original.png') }));
    // The second authenticated owner changes both guards while this GUI keeps stale snapshots.
    const changed = await step(() =>
      peer.setModelConnection({
        ...cloud,
        connectionId: 'qa-001',
        expectedRevision: 3,
        requestId: 'conflict-other',
        defaultModelId: 'deepseek-flash',
      }),
    );
    await step(() => button(dlg, 'Сохранить').click());
    await step(() => dlg.getByText(/Данные изменены в другом окне/).waitFor());
    assert.equal(
      (await step(() => peer.listModelConnections())).items.find((x) => x.connectionId === 'qa-001')
        .revision,
      changed.revision,
    );
    await step(() => button(dlg, 'Обновить метаданные').click());
    assert.equal(
      await step(() => dlg.getByLabel('Модель по умолчанию').inputValue()),
      'deepseek-flash',
    );
    await step(() =>
      dlg
        .getByText(
          'Редактирование привязок заблокировано до успешного обновления метаданных ботов.',
        )
        .waitFor({ state: 'hidden' }),
    );
    const target = seed.bots[0];
    const rebound = await step(() =>
      peer.setBotModelBinding({
        workspaceId,
        requestId: 'peer-rebind',
        botId: target.bot.id,
        expectedProfileVersion: 1,
        binding: seed.connections[1],
      }),
    );
    const card = dlg
      .locator('section.info-card')
      .filter({ has: page.locator('strong', { hasText: '@bot000 ·' }) });
    await step(() => button(card, 'Сохранить только этого бота').click());
    await step(() => card.getByText(/Данные изменены в другом окне/).waitFor());
    assert.deepEqual(
      (await step(() => peer.listBoundBots({ workspaceId }))).items.find(
        (x) => x.bot.id === target.bot.id,
      ),
      rebound,
    );
    await step(() => button(dlg, 'Обновить метаданные').click());
    await step(() => page.screenshot({ path: join(root, 'conflicts.png') }));
    // Both public validator and actual GUI enforce the 256-byte model-ID boundary.
    const boundary = {
      ...local,
      connectionId: 'utf8',
      requestId: 'utf8-128',
      expectedRevision: null,
      defaultModelId: 'я'.repeat(128),
    };
    // Valid input reaches the owner; this product milestone's backend allowlist still rejects it.
    await assert.rejects(
      step(() => peer.setModelConnection(boundary)),
      /provider_invalid_model/,
    );
    await assert.rejects(
      step(() =>
        peer.setModelConnection({
          ...boundary,
          connectionId: 'utf8-bad',
          requestId: 'utf8-129',
          defaultModelId: 'я'.repeat(129),
        }),
      ),
      /invalid_params/,
    );
    await step(() => selector.selectOption('qa-001'));
    await step(() => dlg.getByLabel('Модель по умолчанию').fill('я'.repeat(129)));
    await step(() => button(dlg, 'Сохранить').click());
    await step(() => dlg.getByText(/Проверьте поля/).waitFor());
    await step(() => dlg.getByLabel('Модель по умолчанию').fill('я'.repeat(128)));
    await step(() => button(dlg, 'Сохранить').click());
    await step(() => dlg.getByText(/Выбранная модель не объявлена провайдером/).waitFor());
    assert.equal(
      (await step(() => peer.listModelConnections())).items.find((x) => x.connectionId === 'qa-001')
        .revision,
      4,
    );
    await step(() => key.fill('synthetic-close'));
    await step(() => dlg.press('Escape'));
    await step(() => button(page, 'Провайдер').click());
    assert.equal(await step(() => key.inputValue()), '');
    await step(() => key.fill('synthetic-select'));
    await step(() => selector.selectOption(''));
    assert.equal(await step(() => key.inputValue()), '');
    await step(() => key.fill('synthetic-button-close'));
    await step(() => button(dlg, 'Закрыть провайдера').click());
    await step(() => button(page, 'Провайдер').click());
    assert.equal(await step(() => key.inputValue()), '');
    saveProof(root, 'conflicts-boundary.json', {
      changed,
      rebound,
      utf8PublicValidationAccepted: 256,
      utf8Rejected: 258,
      backendAllowlistRefused: true,
      escapeClears: true,
      selectionClears: true,
      closeClears: true,
    });
    await step(() => page.screenshot({ path: join(root, 'boundary-clearing.png') }));
    await recoveryContext(
      s,
      seed,
      { installedRoot: values['installed-root'], desktopExecutable: values.desktop },
      step,
    );
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
