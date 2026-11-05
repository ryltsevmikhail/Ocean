import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { workspaceId } from './model-native-seed.mjs';
import { wait } from './current-window.mjs';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
/** Another profile owns a separate real GUI; a late binding receipt stays on its original bot. */
export async function recoveryContext(s, seed, inputs, step) {
  const {
    page,
    peer,
    fixture: { root },
  } = s;
  const dlg = page.getByRole('dialog', { name: 'Провайдер' });
  await step(() => dlg.press('Escape'));
  for (const { bot } of seed.bots)
    await step(() =>
      peer.openDirect({ workspaceId, requestId: 'context-' + bot.handle, botId: bot.id }),
    );
  await step(() => button(page, 'Обновить').click());
  await wait(() => step(() => button(page, 'Обновить').isEnabled()), 5000);
  await step(() => button(page, '@bot000').click());
  await step(() => button(page, 'Провайдер').click());
  await step(() =>
    dlg
      .getByText('Редактирование привязок заблокировано до успешного обновления метаданных ботов.')
      .waitFor({ state: 'hidden' }),
  );
  const card = dlg
    .locator('section.info-card')
    .filter({ has: page.locator('strong', { hasText: '@bot000 ·' }) });
  const count = readFileSync(join(root, 'held.jsonl'), 'utf8').trim().split('\n').length;
  writeFileSync(
    join(root, 'fault.json'),
    JSON.stringify({ method: 'bots.setModelBinding', release: 'reply' }),
  );
  await step(() => card.getByLabel(/^Модель/).selectOption('deepseek-v4-pro'));
  await step(() => button(card, 'Сохранить только этого бота').click());
  await wait(
    () =>
      step(() => readFileSync(join(root, 'held.jsonl'), 'utf8').trim().split('\n').length > count),
    5000,
  );
  await step(() => dlg.press('Escape'));
  await step(() => button(page, '@bot001').click());
  const other = await openModelNativeSession({ ...inputs, root: root + '-other-profile' });
  let failed;
  try {
    await other.runCase(async (otherStep) => {
      assert.notEqual(other.fixture.profile, s.fixture.profile);
      assert.notEqual(other.peer.identity.profileId, peer.identity.profileId);
      await otherStep(() => button(other.page, 'Провайдер').click());
      const otherDlg = other.page.getByRole('dialog', { name: 'Провайдер' });
      await otherStep(() =>
        otherDlg.getByRole('heading', { name: 'Подключения и модели ботов' }).waitFor(),
      );
      writeFileSync(join(root, 'release'), '');
      await step(() => button(page, 'Провайдер').click());
      await step(() => card.getByText(/Исходная привязка подтверждена/).waitFor());
      const foreignCard = dlg
        .locator('section.info-card')
        .filter({ has: page.locator('strong', { hasText: '@bot001 ·' }) });
      assert.equal(
        await step(() => foreignCard.getByText(/Исходная привязка подтверждена/).count()),
        0,
      );
      assert.doesNotMatch(
        await otherStep(() => otherDlg.innerText()),
        /Локальный исходный запрос|Исходная привязка подтверждена|Исходная операция подтверждена/,
      );
      assert.equal(
        (await otherStep(() => other.peer.listBoundBots({ workspaceId }))).items.length,
        0,
      );
      assert.ok(
        !(await otherStep(() => other.peer.listModelConnections())).items.some((x) =>
          x.connectionId.startsWith('qa-'),
        ),
      );
      await step(() => page.screenshot({ path: join(root, 'late-binding-own-bot.png') }));
      await otherStep(() =>
        other.page.screenshot({ path: join(other.fixture.root, 'separate-profile.png') }),
      );
      saveProof(root, 'context.json', {
        originalProfile: peer.identity.profileId,
        otherProfile: other.peer.identity.profileId,
        roomChangedTo: 'bot001',
        originalBot: seed.bots[0].bot.id,
        lateReceiptStayedOnOriginal: true,
        peerBots: await step(() => peer.listBoundBots({ workspaceId })),
        otherProfileEmpty: true,
      });
    });
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    await other.dispose(failed);
  }
}
