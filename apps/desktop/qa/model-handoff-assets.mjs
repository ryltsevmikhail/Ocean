import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wait } from './current-window.mjs';
import { digest, saveProof } from './model-native-paths.mjs';
import { nativeWidths } from './model-native-widths.mjs';
const button = (page, name) => page.getByRole('button', { name, exact: true });
export const image = {
  name: 'diagram.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
};
export const files = [
  image,
  {
    name: 'notes.md',
    mimeType: 'text/plain',
    buffer: Buffer.from('Exact native text card 17.5.3'),
  },
  {
    name: 'archive.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0, 1, 255, 4]),
  },
  {
    name: 'boundary.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(10485760, 113),
  },
];
export async function inspectExports(s, step, { history = false, label = 'originals' } = {}) {
  const {
    page,
    inspectMain,
    fixture: { root },
  } = s;
  // Synthetic chooser destination only; actual packaged attachment-save reads and writes originals.
  await step(() =>
    inspectMain(
      '(e.dialog.showSaveDialog = async (_w,o) => ({canceled:false,filePath:' +
        JSON.stringify(join(root, 'exports') + '/') +
        '+o.defaultPath}), true)',
    ),
  );
  const evidence = [];
  for (const file of files) {
    const scope = history ? page.locator('#history') : page.locator('#composer');
    await step(() => button(scope, 'Предпросмотр ' + file.name).click());
    const dlg = page.getByRole('dialog', { name: file.name });
    if (file === image) {
      await step(() => dlg.getByRole('img').waitFor());
      await step(() => page.screenshot({ path: join(root, label + '-image.png') }));
    }
    if (file.name === 'notes.md')
      await step(() => dlg.getByText(file.buffer.toString(), { exact: true }).waitFor());
    await step(() =>
      dlg
        .getByText('Готовим предпросмотр…', { exact: true })
        .waitFor({ state: 'hidden', timeout: 30000 }),
    );
    await step(() => button(dlg, 'Сохранить оригинал').click());
    await step(() => button(dlg, 'Сохранить оригинал').waitFor({ timeout: 30000 }));
    const path = join(root, 'exports', file.name);
    await wait(
      () => step(() => existsSync(path) && digest(readFileSync(path)) === digest(file.buffer)),
      30000,
    );
    assert.equal(digest(readFileSync(path)), digest(file.buffer));
    await step(() => dlg.press('Escape'));
    await step(() => dlg.waitFor({ state: 'hidden' }));
    evidence.push({
      name: file.name,
      bytes: file.buffer.length,
      sha256: digest(file.buffer),
      export: path,
    });
  }
  saveProof(root, label + '.json', { syntheticChooser: true, history, files: evidence });
  return evidence;
}
export async function handoffAssets(s, room, step) {
  const {
    page,
    fixture: { root },
  } = s;
  await step(() => button(page, 'Обновить').click());
  await step(() => button(page, 'Handoff files').click());
  await step(() =>
    page.waitForFunction(
      () => globalThis.document.querySelectorAll('#history article').length === 24,
    ),
  );
  const input = page.locator('#composer input[type=file]');
  await step(() =>
    input.setInputFiles({
      name: 'over.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(10485761),
    }),
  );
  await step(() => page.getByText('Один файл — не более 10 МБ.', { exact: true }).waitFor());
  assert.equal(
    await step(() => page.locator('#composer [role=alert]').innerText()),
    'Один файл — не более 10 МБ.',
  );
  assert.equal(await step(() => page.locator('#composer .attachment-card').count()), 0);
  await step(() => input.setInputFiles(files, { timeout: 60000 }));
  await step(() => button(page, 'Убрать boundary.bin').waitFor({ timeout: 60000 }));
  assert.equal(await step(() => page.locator('#composer .attachment-card').count()), 4);
  await step(() =>
    input.setInputFiles({
      name: 'fifth.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('fifth'),
    }),
  );
  await step(() =>
    page.getByText('Можно прикрепить до четырёх файлов.', { exact: true }).waitFor(),
  );
  assert.equal(await step(() => page.locator('#composer .attachment-card').count()), 4);
  assert.equal(await step(() => button(page, 'Прикрепить файл').isDisabled()), true);
  assert.equal(
    await step(() => page.locator('#composer [role=alert]').innerText()),
    'Можно прикрепить до четырёх файлов.',
  );
  await inspectExports(s, step, { label: 'draft-originals' });
  await step(() => page.locator('#history').evaluate((el) => el.scrollTo(0, el.scrollHeight)));
  await step(() =>
    page.waitForFunction(() => {
      const el = globalThis.document.querySelector('#history');
      return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    }),
  );
  const draft = 'Long native draft '.repeat(45);
  await nativeWidths(s, step, { draftText: draft, recipientValue: '' });
  const field = page.getByLabel('Сообщение', { exact: true });
  await step(() => field.fill('shift-line'));
  await step(() => field.press('Shift+Enter'));
  await step(() => field.pressSequentially('second'));
  assert.equal(await step(() => field.inputValue()), 'shift-line\nsecond');
  await step(() => field.fill('attachment note'));
  await step(() => field.press('Enter'));
  await step(() =>
    page.locator('#history').getByText('attachment note', { exact: true }).waitFor(),
  );
  await wait(
    () =>
      step(() =>
        page
          .locator('#composer .attachment-card')
          .count()
          .then((n) => n === 0),
      ),
    5000,
  );
  await step(() => field.focus());
  assert.equal(
    await step(() => field.evaluate((el) => el === globalThis.document.activeElement)),
    true,
  );
  await inspectExports(s, step, { history: true, label: 'history-originals' });
  await step(() => page.screenshot({ path: join(root, 'attachments-history.png') }));
  const history = await step(() =>
    page.evaluate(
      async (room) => globalThis.ocean.request({ op: 'history', room, after: 24 }),
      room,
    ),
  );
  assert.equal(history.ok, true);
  const message = history.data.find((m) => m.body === 'attachment note');
  assert.equal(message.attachments.length, 4);
  saveProof(root, 'assets.json', {
    room,
    message,
    fourFiles: true,
    tenMiBAccepted: true,
    tenMiBPlusOneRefused: true,
    fifthRefused: true,
    previews: true,
    enter: true,
    shiftEnter: true,
    escape: true,
    focused: true,
  });
  return message;
}
