// Fixture-only faults target the runtime-owned preparation operation, never legacy userData.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import console from 'node:console';

export async function damagedPreparation(page, f, _userData, room, original, committed) {
  const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'));
  const binding = JSON.parse(
    db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get().value,
  );
  assert.ok(binding.root.startsWith(f.profile + '/desktop-'));
  const operation = 'prepare:' + room + ':' + original;
  const stored = db.prepare('SELECT * FROM ocean_desktop_operations WHERE id=?').get(operation);
  const record = JSON.parse(stored.result);
  const receiptPath = join(binding.root, room, original + '.json');
  const bytesPath = join(binding.root, room, record.ids[0], 'blob');
  const fileReceipt = readFileSync(receiptPath),
    bytes = readFileSync(bytesPath);
  const restore = () =>
    db
      .prepare('UPDATE ocean_desktop_operations SET binding=?,state=?,result=? WHERE id=?')
      .run(stored.binding, stored.state, stored.result, operation);
  const draft = page.getByLabel('Сообщение', { exact: true });
  const retry = page.getByRole('button', { name: 'Повторить исходный запрос' });
  const feedback = page.locator('#feedback');
  const drop = join(f.root, 'requests.drop');
  async function retained(expected) {
    writeFileSync(drop, '');
    await retry.click();
    await page.waitForFunction(
      () => !globalThis.document.querySelector('#composer button.send')?.disabled,
    );
    await feedback.filter({ hasText: expected }).waitFor();
    assert.equal(await draft.isEditable(), false);
    assert.ok((await feedback.locator('p[title]').getAttribute('title')).includes(original));
    assert.ok(existsSync(drop), 'preparation failure must not reach admission/identity receipt');
    unlinkSync(drop);
  }
  try {
    const changed = await page.evaluate(async (c) => globalThis.ocean.request(c), {
      op: 'send',
      room,
      requestId: original,
      to: 'dev',
      text: 'changed input',
      attachments: record.ids,
    });
    assert.deepEqual(changed.error, { code: 'request_conflict', sendStage: 'preparation' });
    db.prepare('UPDATE ocean_desktop_operations SET result=? WHERE id=?').run(
      JSON.stringify({ ...record, prepared: record.prepared + 'corrupt' }),
      operation,
    );
    await retained('Квитанция не подтверждена');
    db.prepare('UPDATE ocean_desktop_operations SET binding=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(stored.binding), to: 'review' }),
      operation,
    );
    await retained('request_conflict');
    restore();
    db.prepare("UPDATE ocean_desktop_operations SET state='started',result=NULL WHERE id=?").run(
      operation,
    );
    await retained('Квитанция не подтверждена');
    restore();
    // The canonical durable operation owns the frozen binding; old local receipts
    // and even missing canonical file bytes cannot authorize changed input.
    unlinkSync(receiptPath);
    unlinkSync(bytesPath);
    await retry.click();
    await feedback
      .locator('p[title="Принято · ' + committed.messageId + ' · ' + committed.runId + '"]')
      .waitFor();
    assert.equal(await draft.inputValue(), '');
    console.log(
      'Canonical corrupt/missing operation retained UUID; changed body/recipient refused; durable frozen preparation retried without file receipt/blob',
      binding.root,
    );
  } finally {
    restore();
    db.close();
    writeFileSync(receiptPath, fileReceipt, { mode: 0o600 });
    writeFileSync(bytesPath, bytes, { mode: 0o600 });
    if (existsSync(drop)) unlinkSync(drop);
  }
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
