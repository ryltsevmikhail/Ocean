import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';
import { DesktopAttachmentClient } from '@runnets/tools-node';
import { wait } from './current-window.mjs';
export async function currentAssets(page, f, room) {
  const button = (name) => page.getByRole('button', { name, exact: true });
  const input = page.locator('#composer input[type=file]');
  await page.waitForFunction(
    () => !globalThis.document.querySelector('#composer input[type=file]').disabled,
  );
  // Refused input never reaches IPC; construct its size inside the isolated page.
  await page.evaluate(() => {
    const input = globalThis.document.querySelector('#composer input[type=file]');
    const data = new globalThis.DataTransfer();
    data.items.add(new globalThis.File([new Uint8Array(10485761)], 'over.bin'));
    input.files = data.files;
    input.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.getByText('Один файл — не более 10 МБ.', { exact: true }).waitFor();
  assert.equal(await page.locator('#composer .attachment-card').count(), 0);
  const image = readFileSync(join(f.root, 'exports', 'fixture-large.png'));
  assert.ok(image.length > 1048576 && image.length <= 10485760);
  const files = [
    { name: 'large.png', mimeType: 'image/png', buffer: image },
    {
      name: 'notes.md',
      mimeType: 'text/plain',
      buffer: Buffer.from('GUI drop exact text contents 7.13'),
    },
    {
      name: 'archive.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from([0, 1, 255, 0, 4]),
    },
    {
      name: 'boundary.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(10485760, 113),
    },
  ];
  await input.setInputFiles(files[0], { timeout: 60000 });
  await button('Предпросмотр large.png').locator('img').waitFor();
  await button('Предпросмотр large.png').click();
  await page.getByRole('dialog', { name: 'large.png' }).getByRole('img').waitFor();
  await button('Закрыть предпросмотр').click();
  for (const [event, file] of [
    ['drop', files[1]],
    ['paste', files[2]],
  ]) {
    await page.evaluate(
      ({ event, name, mime, data }) => {
        const transfer = new globalThis.DataTransfer();
        transfer.items.add(
          new globalThis.File(
            [Uint8Array.from(globalThis.atob(data), (c) => c.charCodeAt(0))],
            name,
            { type: mime },
          ),
        );
        const synthetic =
          event === 'drop'
            ? new globalThis.DragEvent('drop', {
                dataTransfer: transfer,
                bubbles: true,
                cancelable: true,
              })
            : new globalThis.ClipboardEvent('paste', {
                clipboardData: transfer,
                bubbles: true,
                cancelable: true,
              });
        globalThis.document.querySelector('#composer').dispatchEvent(synthetic);
      },
      { event, name: file.name, mime: file.mimeType, data: file.buffer.toString('base64') },
    );
    await button('Убрать ' + file.name).waitFor();
  }
  await button('Предпросмотр notes.md').click();
  await page
    .getByRole('dialog', { name: 'notes.md' })
    .getByText(files[1].buffer.toString(), { exact: true })
    .waitFor();
  await button('Закрыть предпросмотр').click();
  await page.evaluate(() => {
    const input = globalThis.document.querySelector('#composer input[type=file]');
    const data = new globalThis.DataTransfer();
    data.items.add(new globalThis.File([new Uint8Array(10485760).fill(113)], 'boundary.bin'));
    input.files = data.files;
    input.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await button('Убрать boundary.bin').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('#composer .attachment-card').count(), 4);
  await input.setInputFiles({
    name: 'fifth.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('refuse fifth'),
  });
  await page.getByText('Можно прикрепить до четырёх файлов.', { exact: true }).waitFor();
  assert.equal(await page.locator('#composer .attachment-card').count(), 4);
  await page.getByLabel('Кому').selectOption('');
  await page.getByLabel('Сообщение', { exact: true }).fill('attachment note');
  await button('Отправить').click();
  await page.locator('#history').getByText('attachment note', { exact: true }).waitFor();
  assert.equal(await page.locator('#composer .attachment-card').count(), 0);
  const db = new DatabaseSync(join(f.profile, 'runtime.sqlite'), { readOnly: true });
  const binding = JSON.parse(
    db.prepare("SELECT value FROM meta WHERE key='desktop_assets_binding'").get().value,
  );
  const row = db
    .prepare(
      "SELECT * FROM ocean_desktop_operations WHERE id LIKE 'prepare:%' AND result LIKE '%attachment note%'",
    )
    .get();
  const prep = JSON.parse(row.result);
  assert.ok(binding.root.startsWith(f.profile + '/desktop-'));
  const client = await connectLocalRuntime({ profile: f.profile });
  const media = new DesktopAttachmentClient(client);
  const evidence = [];
  try {
    for (const [index, file] of files.entries()) {
      const id = prep.ids[index];
      const read = await media.read(room, id);
      assert.deepEqual(read.data, file.buffer);
      assert.equal(read.info.sha256, createHash('sha256').update(file.buffer).digest('hex'));
      assert.deepEqual(readFileSync(join(binding.root, room, id, 'blob')), file.buffer);
      await page
        .locator('#history')
        .getByRole('button', { name: 'Предпросмотр ' + file.name })
        .click();
      if (file.name === 'notes.md')
        await page
          .getByRole('dialog', { name: file.name })
          .getByText(file.buffer.toString(), { exact: true })
          .waitFor();
      await button('Сохранить оригинал').click();
      const output = join(f.root, 'exports', file.name);
      await wait(() => existsSync(output));
      assert.deepEqual(readFileSync(output), file.buffer);
      await button('Закрыть предпросмотр').click();
      evidence.push({
        ...read.info,
        room,
        canonicalBlob: join(binding.root, room, id, 'blob'),
        export: output,
      });
    }
  } finally {
    client.close();
    db.close();
  }
  writeFileSync(
    join(f.root, 'asset-proof.json'),
    JSON.stringify({ binding, preparation: prep, files: evidence }, null, 2),
  );
  return evidence;
}
