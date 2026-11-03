// Exercise two different refusal boundaries in the disposable GUI and listening owner.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import console from 'node:console';

export async function damagedPreparation(page, f, userData, room, original, committed) {
  const folder = join(
    userData,
    'conversation',
    'profiles',
    f.command('runtime', 'status').profileId,
    'attachments',
    room,
  );
  const path = join(folder, original + '.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const changed = await page.evaluate(async (c) => globalThis.ocean.request(c), {
    op: 'send',
    room,
    requestId: original,
    to: 'dev',
    text: 'changed input',
    attachments: record.ids,
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'request_conflict');
  assert.equal(changed.error.sendStage, 'preparation');
  writeFileSync(path, JSON.stringify({ ...record, prepared: record.prepared + 'corrupt' }));
  const draft = page.getByLabel('Сообщение', { exact: true });
  const retry = page.getByRole('button', { name: 'Повторить исходный запрос' });
  const feedback = page.locator('#feedback');
  const drop = join(f.root, 'requests.drop');
  writeFileSync(drop, ''); // Also lose one receipt lookup, after the local retry failure.
  try {
    await retry.click();
    await page.waitForFunction(
      () => !globalThis.document.querySelector('#composer button.send')?.disabled,
    );
    assert.equal(
      await draft.isDisabled(),
      true,
      'a local preparation error must retain the earlier unconfirmed submission',
    );
    assert.ok((await feedback.innerText()).includes(original));
    assert.equal(existsSync(drop), false, 'the retry must read the scoped owner receipt');
    // A rebound local record reports request_conflict before admission. It must
    // neither discard the pending UUID nor turn a lookup into changed-input success.
    writeFileSync(path, JSON.stringify({ ...record, to: 'review' }));
    writeFileSync(drop, '');
    await retry.click();
    await feedback.filter({ hasText: 'request_conflict' }).waitFor();
    assert.equal(await draft.isDisabled(), true);
    assert.ok((await feedback.innerText()).includes(original));
    assert.ok(existsSync(drop), 'a binding conflict must not consume an owner receipt');
    unlinkSync(drop);
    // A missing receipt and blob also prevent preparation. Recover the original
    // admission without the local bytes, then restore them for the reopen checks.
    unlinkSync(path);
    const blobPath = join(folder, record.ids[0], 'blob');
    const bytes = readFileSync(blobPath);
    unlinkSync(blobPath);
    try {
      const changedText = await page.evaluate(async (c) => globalThis.ocean.request(c), {
        op: 'send',
        room,
        requestId: original,
        to: 'review',
        text: 'changed owner binding',
      });
      assert.deepEqual(changedText.error, { code: 'request_conflict', sendStage: 'refused' });
      await retry.click();
      await feedback
        .getByText('Принято · ' + committed.messageId + ' · ' + committed.runId)
        .waitFor();
    } finally {
      writeFileSync(blobPath, bytes);
    }
  } finally {
    writeFileSync(path, JSON.stringify(record));
  }
  console.log(
    'Corrupt preparation and lost receipt read retained UUID; missing local bytes recovered the original scoped receipt; changed send refused',
  );
}

export async function contextRefusal(page, f) {
  const room = f.command(
    'room',
    'group',
    '--name',
    'Context fixture',
    '--bot',
    'dev',
    '--bot',
    'review',
  ).data.id;
  for (let i = 0; i < 4; i++)
    f.command('send', room, '--text', 'a'.repeat(16000), '--request-id', 'context-note-' + i);
  const dispatches = () =>
    readFileSync(join(f.root, 'requests'), 'utf8').trimEnd().split('\n').length;
  const before = dispatches();
  const button = (name) => page.getByRole('button', { name, exact: true });
  await button('Обновить').click();
  await button('Context fixture').click();
  const draft = page.getByLabel('Сообщение', { exact: true });
  await page.getByLabel('Кому').selectOption('dev');
  const long = 'x'.repeat(2000);
  await draft.fill(long);
  await button('Отправить').click();
  await page
    .locator('#feedback')
    .filter({ hasText: 'История превысила лимит контекста модели.' })
    .waitFor();
  assert.equal(await draft.inputValue(), long);
  assert.equal(
    await draft.isEditable(),
    true,
    'definitive owner context_limit must leave the original draft editable',
  );
  assert.equal(await page.getByLabel('Кому').inputValue(), 'dev');
  assert.equal(f.command('history', room).length, 4);
  assert.equal(dispatches(), before);
  await draft.fill('--help');
  await button('Отправить').click();
  await page.locator('#feedback').filter({ hasText: 'Проверьте поля.' }).waitFor();
  assert.equal(await draft.inputValue(), '--help');
  assert.equal(
    await draft.isEditable(),
    true,
    'renderer validation before IPC must leave the draft editable',
  );
  assert.equal(await page.getByLabel('Кому').inputValue(), 'dev');
  assert.equal(f.command('history', room).length, 4);
  assert.equal(dispatches(), before);
  await draft.fill('short valid turn');
  await button('Отправить').click();
  await page
    .locator('#history')
    .getByText('Test provider · short valid turn', { exact: true })
    .waitFor();
  assert.deepEqual(
    f.command('history', room, '--after', '4').map((m) => m.body),
    ['short valid turn', 'Test provider · short valid turn'],
  );
  assert.equal(dispatches(), before + 1);
  console.log(
    'Owner context_limit and renderer validation kept drafts editable; zero refused admissions or dispatches, one edited turn and reply',
  );
}
