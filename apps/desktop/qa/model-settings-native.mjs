import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { seedModelSettings, readPages, workspaceId, local } from './model-native-seed.mjs';
import { nativeWidths } from './model-native-widths.mjs';

const requests = (root) =>
  existsSync(join(root, 'requests.jsonl'))
    ? readFileSync(join(root, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    : [];
const button = (locator, name) => locator.getByRole('button', { name, exact: true });
async function choose(locator, binding, step) {
  await step(() => locator.getByLabel(/^Подключение/).selectOption(binding.connectionId));
  await step(() => locator.getByLabel(/^Модель/).selectOption(binding.modelId));
}
async function settings({ page, peer, fixture: { root } }, seed, step) {
  const before = await readPages(peer, step);
  assert.deepEqual(before.bots.map((x) => x.bot.id).sort(), seed.bots.map((x) => x.bot.id).sort());
  const seedIds = seed.connections.map((x) => x.connectionId);
  assert.ok(seedIds.every((id) => before.connections.some((x) => x.connectionId === id)));
  const first = seed.connections[0],
    last = seed.connections.at(-1);
  assert.ok(before.lastConnections.some((x) => x.connectionId === last.connectionId));
  const baseline = requests(root);
  await step(() => button(page, 'Провайдер').click());
  const dialog = page.getByRole('dialog', { name: 'Провайдер' });
  await step(() => dialog.getByRole('heading', { name: 'Подключения и модели ботов' }).waitFor());
  const selector = dialog.getByLabel(/^Подключение/).first();
  for (const item of [first, last]) {
    await step(() => selector.selectOption(item.connectionId));
    assert.equal(
      await step(() => dialog.getByLabel('ID подключения').inputValue()),
      item.connectionId,
    );
  }
  assert.equal(await step(() => dialog.getByLabel(/^Cloud \/ Local/).inputValue()), 'cloud');
  assert.equal(await step(() => dialog.getByLabel(/^Авторизация/).inputValue()), 'api_key');
  await step(() => button(dialog, 'Обновить метаданные').click());
  await step(() => selector.selectOption(first.connectionId));
  assert.equal(await step(() => dialog.getByLabel(/^Авторизация/).inputValue()), 'none');
  assert.deepEqual(
    (
      await step(() => selector.locator('option').evaluateAll((nodes) => nodes.map((x) => x.value)))
    ).filter(Boolean),
    before.connections.map((x) => x.connectionId),
  );
  assert.equal(
    await step(() => dialog.getByRole('button', { name: 'Сохранить только этого бота' }).count()),
    before.bots.length,
  );
  assert.deepEqual(requests(root), baseline);
  const target = before.lastBots[0];
  const card = dialog
    .locator('section.info-card')
    .filter({ has: page.locator('strong', { hasText: '@' + target.bot.handle + ' ·' }) });
  const binding = target.binding.connectionId === last.connectionId ? first : last;
  await choose(card, binding, step);
  await step(() => button(card, 'Сохранить только этого бота').click());
  await step(() => card.getByText(/Исходная привязка подтверждена/).waitFor());
  const after = await readPages(peer, step);
  const changed = after.bots.find((x) => x.bot.id === target.bot.id);
  assert.deepEqual(changed.binding, binding);
  assert.equal(changed.bot.profileVersion, target.bot.profileVersion + 1);
  assert.deepEqual(
    after.bots.filter((x) => x.bot.id !== target.bot.id),
    before.bots.filter((x) => x.bot.id !== target.bot.id),
  );
  await step(() => selector.selectOption(''));
  await step(() => dialog.getByLabel('ID подключения').fill('absent-qa'));
  await step(() => button(dialog, 'Сохранить').click());
  await step(() => selector.locator('option[value="absent-qa"]').waitFor({ state: 'attached' }));
  assert.match(await step(() => selector.locator('option:checked').innerText()), /отсутствует/);
  assert.ok(!(await readPages(peer, step)).connections.some((x) => x.connectionId === 'absent-qa'));
  await step(() => selector.selectOption(''));
  assert.ok(await step(() => dialog.getByLabel('ID подключения').isEnabled()));
  await step(() => dialog.getByLabel(/^Cloud \/ Local/).selectOption('local'));
  await step(() => dialog.getByLabel(/^Авторизация/).selectOption('none'));
  assert.equal(await step(() => dialog.getByLabel('Ключ API').count()), 0);
  await step(() => dialog.getByLabel(/^Cloud \/ Local/).selectOption('cloud'));
  assert.equal(await step(() => dialog.getByLabel(/^Авторизация/).inputValue()), 'api_key');
  assert.ok(await step(() => dialog.getByLabel('Ключ API').isVisible()));
  await step(() => dialog.getByLabel(/^Cloud \/ Local/).selectOption('local'));
  await step(() => dialog.getByLabel(/^Авторизация/).selectOption('none'));
  await step(() => dialog.getByLabel('ID подключения').fill('ui-local'));
  await step(() => dialog.getByLabel('Провайдер / backend').fill(local.providerId));
  await step(() => dialog.getByLabel('Endpoint').fill(local.endpoint));
  await step(() => dialog.getByLabel('Модель по умолчанию').fill(local.defaultModelId));
  await step(() => button(dialog, 'Сохранить').click());
  await step(() => dialog.getByText(/Исходная операция подтверждена/).waitFor());
  const saved = (await readPages(peer, step)).connections.find(
    (x) => x.connectionId === 'ui-local',
  );
  assert.ok(saved && !saved.lastCheck && !saved.localQualification && saved.auth === 'none');
  assert.deepEqual(requests(root), baseline);
  await step(() => button(dialog, 'Проверить явно').click());
  await step(() => dialog.getByText(/Записанная квалификация/).waitFor());
  const checked = (await readPages(peer, step)).connections.find(
    (x) => x.connectionId === 'ui-local',
  );
  assert.equal(checked.lastCheck.outcome, 'ok');
  assert.equal(checked.localQualification.modelId, local.defaultModelId);
  const explicit = requests(root).slice(baseline.length);
  assert.equal(explicit.length, 3);
  assert.ok(explicit.every((x) => x.served));
  await step(() => page.screenshot({ path: join(root, 'settings.png') }));
  saveProof(root, 'settings.json', {
    pages: [before.connections.length, before.bots.length],
    lastConnection: last,
    tailBots: before.lastBots.map((x) => x.bot.id),
    selectedBot: target,
    changed,
    unchanged: after.bots.length - 1,
    metadataTransportCalls: 0,
    saved,
    checked,
    explicit,
    absentIdReturnedToNew: true,
  });
  await step(() => dialog.press('Escape'));
  await step(() => dialog.waitFor({ state: 'hidden' }));
  return { first, last };
}
async function creation({ page, peer, fixture: { root } }, { first, last }, step) {
  await step(() => button(page, 'Обновить').click());
  await step(() => button(page, 'Локальный профиль').click());
  await step(() => button(page, 'Профили ботов').click());
  const dlg = page.getByRole('dialog', { name: 'Создание' }),
    create = button(dlg, 'Создать');
  await step(() => dlg.getByLabel('Идентификатор').fill('dev'));
  await step(() => dlg.getByLabel('Имя', { exact: true }).fill('Native Dev'));
  await step(() => dlg.getByLabel('Роль').fill('Fixture'));
  assert.ok(await step(() => create.isDisabled()));
  await choose(dlg, first, step);
  await step(() => create.click());
  await step(() => dlg.waitFor({ state: 'hidden' }));
  const bot = (await readPages(peer, step)).bots.find((x) => x.bot.handle === 'dev');
  assert.deepEqual(bot.binding, first);
  await step(() => button(page, 'Создать комнату').click());
  await step(() => dlg.getByLabel(/^Тип/).selectOption('group'));
  await step(() => dlg.getByLabel('Название').fill('Native group'));
  for (const handle of ['dev', 'bot000'])
    await step(() => dlg.getByLabel('@' + handle, { exact: true }).check());
  await step(() => create.click());
  await step(() => page.getByRole('heading', { name: 'Native group', exact: true }).waitFor());
  const group = (await step(() => peer.listRooms({ workspaceId }))).find(
    (x) => x.title === 'Native group',
  );
  const members = await step(() => peer.listMembers({ workspaceId, roomId: group.id }));
  assert.deepEqual(members.map((x) => x.handle).sort(), ['bot000', 'dev']);
  await step(() => button(page, 'Создать Ocean Team').click());
  assert.equal(await step(() => dlg.locator('section.info-card').count()), 1);
  await step(() => dlg.getByText('@review', { exact: true }).waitFor());
  assert.ok(await step(() => create.isDisabled()));
  await choose(dlg, last, step);
  await step(() => create.click());
  await step(() => page.getByRole('heading', { name: 'Ocean Team', exact: true }).waitFor());
  const team = (await step(() => peer.listRooms({ workspaceId }))).find(
    (x) => x.title === 'Ocean Team',
  );
  const teamMembers = await step(() => peer.listMembers({ workspaceId, roomId: team.id }));
  assert.deepEqual(teamMembers.map((x) => x.handle).sort(), ['dev', 'review']);
  const final = (await readPages(peer, step)).bots;
  assert.deepEqual(
    final.find((x) => x.bot.id === bot.bot.id),
    bot,
  );
  assert.deepEqual(final.find((x) => x.bot.handle === 'review').binding, last);
  saveProof(root, 'creation.json', {
    bot,
    group,
    members,
    team,
    teamMembers,
    review: final.find((x) => x.bot.handle === 'review'),
  });
}
const { values } = parseArgs({
  options: {
    'qualification-parent': { type: 'string' },
    'installed-root': { type: 'string' },
    desktop: { type: 'string' },
    root: { type: 'string' },
  },
});
const session = await openModelNativeSession({
  qualificationParent: values['qualification-parent'],
  installedRoot: values['installed-root'],
  desktopExecutable: values.desktop,
  root: values.root,
});
let original;
try {
  await session.runCase(async (step) => {
    const seed = await seedModelSettings(session.peer, { connectionCount: 51, botCount: 51, step });
    const picks = await settings(session, seed, step);
    await creation(session, picks, step);
    await nativeWidths(session, step);
    const lines = requests(values.root);
    assert.deepEqual(
      lines.slice(-3).map((x) => x.route),
      [
        'GET http://127.0.0.1:11434/api/version',
        'GET http://127.0.0.1:11434/api/tags',
        'POST http://127.0.0.1:11434/api/show',
      ],
    );
    assert.equal(lines.length, 56);
    assert.ok(lines.every((x) => x.served));
    assert.ok(!existsSync(join(values.root, 'page-errors.log')));
    const consoleFile = join(values.root, 'renderer-console.log');
    const messages = existsSync(consoleFile) ? readFileSync(consoleFile, 'utf8') : '';
    assert.doesNotMatch(messages, /^error:/m);
    assert.equal(
      await step(() =>
        session.page.locator('vite-error-overlay,webpack-dev-server-client-overlay').count(),
      ),
      0,
    );
    saveProof(values.root, 'health.json', {
      requests: lines.length,
      console: messages,
      pageErrors: 0,
      overlays: 0,
    });
  });
} catch (error) {
  original = error;
  process.stderr.write(String(error) + '\n');
  const { page } = session;
  try {
    saveProof(values.root, 'failure.json', {
      error: String(error),
      cleanup: error.cleanupError && String(error.cleanupError),
      drain: error.drainError && String(error.drainError),
      body: session.signal.aborted
        ? 'diagnostics skipped after interruption'
        : await page
            .locator('body')
            .innerText({ timeout: 2000 })
            .catch(() => 'unavailable'),
    });
  } catch (diagnostic) {
    error.diagnosticError = diagnostic;
  }
  if (!session.signal.aborted)
    await page
      .screenshot({ path: join(values.root, 'failure.png'), timeout: 2000 })
      .catch(() => {});
  throw error;
} finally {
  await session.dispose(original);
}
