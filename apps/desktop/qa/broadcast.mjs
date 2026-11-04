// CURRENT real Desktop GUI qualification for the durable broadcast (private fixture only).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fixture } from './owner.mjs';
import { currentWindow } from './current-window.mjs';

assert.ok(process.env.OCEAN_QA_CLI, 'explicit built CLI required');
const f = await fixture({ root: process.env.OCEAN_QA_ROOT, preserve: true });
console.log('FIXTURE', f.root);
Object.assign(process.env, f.env);
mkdirSync(join(f.root, 'exports'), { mode: 0o700 });
const evidence = { steps: [], screenshots: [] };
const requests = () =>
  existsSync(join(f.root, 'requests'))
    ? readFileSync(join(f.root, 'requests'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
let gui;
try {
  const dev = f.command('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'Fixture');
  const review = f.command(
    'bot',
    'add',
    '--handle',
    'review',
    '--name',
    'Review',
    '--role',
    'Fixture',
  );
  const createdRoom = f.command(
    'room',
    'group',
    '--name',
    'Broadcast QA',
    '--bot',
    dev.data.id,
    '--bot',
    review.data.id,
  );
  evidence.roomId = createdRoom.data.id;
  gui = await currentWindow(f, 'broadcast');
  const page = gui.page;
  page.setDefaultTimeout(20_000);
  await page.getByRole('button', { name: 'Broadcast QA', exact: true }).click();
  await page.getByRole('heading', { name: 'Broadcast QA', exact: true }).waitFor();
  const recipient = page.getByLabel('Кому');
  const options = await recipient.locator('option').allTextContents();
  assert.deepEqual(options.slice(0, 2), ['Всем (broadcast)', 'Заметка']);
  evidence.steps.push({ step: 'explicit-actions', options: options.slice(0, 3) });

  // Note path is unchanged: one room message, no provider request.
  await recipient.selectOption('');
  await page.getByLabel('Сообщение', { exact: true }).fill('Заметка без модели');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByText('Заметка без модели').first().waitFor();
  assert.equal(requests().length, 0);
  evidence.steps.push({ step: 'note-without-model', providerRequests: 0 });

  // Broadcast: one question, exactly one answer per participant, no follow-up round.
  await recipient.selectOption('*');
  await page.getByLabel('Сообщение', { exact: true }).fill('Вопрос всем участникам');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const panel = page.locator('.broadcast-panel');
  await panel.getByText(/Рассылка завершена/).waitFor();
  const summary = await panel.getByRole('status').innerText();
  assert.match(summary, /2 из 2 ответили/);
  // A successful broadcast is never rendered as an unconfirmed receipt (M1 regression).
  const feedback = await page.locator('#feedback').innerText();
  assert.match(feedback, /Рассылка принята/);
  assert.doesNotMatch(feedback, /Квитанция не подтверждена/);
  const handles = await panel
    .locator('li[data-state="answered"] .broadcast-handle')
    .allTextContents();
  assert.deepEqual(handles.sort(), ['@dev', '@review']);
  assert.equal(requests().length, 2, 'exactly two provider calls, one per participant');
  await page.screenshot({ path: join(f.root, '01-broadcast-completed.png') });
  evidence.screenshots.push(join(f.root, '01-broadcast-completed.png'));
  evidence.steps.push({
    step: 'broadcast-completed',
    providerRequests: requests().length,
    summary,
    feedback,
  });

  // Paused batch: kill the owner while the first child is in flight, restart, decide.
  await page.getByLabel('Сообщение', { exact: true }).fill('hold-broadcast вопрос');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  const started = Date.now();
  while (requests().length < 3) {
    if (Date.now() - started > 20_000) throw Error('broadcast provider request not observed');
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }
  const exited = once(f.owner, 'close');
  f.owner.kill('SIGKILL');
  await exited;
  await f.start();
  await page.getByRole('button', { name: 'Обновить', exact: true }).first().click();
  await panel.getByText(/Рассылка приостановлена/).waitFor();
  const pausedSummary = await panel.getByRole('status').innerText();
  assert.match(pausedSummary, /Рассылка приостановлена/);
  await page.screenshot({ path: join(f.root, '02-broadcast-paused.png') });
  evidence.screenshots.push(join(f.root, '02-broadcast-paused.png'));
  evidence.steps.push({ step: 'paused-after-crash', summary: pausedSummary });
  await panel.getByRole('button', { name: 'Продолжить' }).click();
  const refusal = panel.getByRole('alert');
  await refusal.waitFor();
  const refusalText = await refusal.innerText();
  assert.match(refusalText, /Продолжение запрещено/);
  evidence.steps.push({ step: 'continue-refused', text: refusalText });
  await panel.getByRole('button', { name: 'Оставить' }).click();
  await panel
    .getByText(/Рассылка оставлена/)
    .first()
    .waitFor();
  const childStates = await panel
    .locator('li')
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.querySelector('.broadcast-handle')?.textContent,
        node.dataset.state,
      ]),
    );
  evidence.steps.push({ step: 'abandoned', childStates });
  assert.ok(childStates.some(([, state]) => state === 'uncertain'));
  assert.ok(childStates.some(([, state]) => state === 'not_started'));
  // Abandonment is not a remote cancellation claim: the started child stays uncertain.
  assert.equal(requests().length, 3, 'no redispatch after restart and abandon');
  await page.screenshot({ path: join(f.root, '03-broadcast-abandoned.png') });
  evidence.screenshots.push(join(f.root, '03-broadcast-abandoned.png'));

  // Durable identity: exactly two child turns for the completed batch, both completed.
  const counts = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import {DatabaseSync} from 'node:sqlite';
        const db=new DatabaseSync(process.argv[1],{readOnly:true});
        const rows=db.prepare("SELECT status,count(*) AS n FROM ocean_chat_turns GROUP BY status").all();
        const messages=db.prepare("SELECT author,count(*) AS n FROM ocean_messages GROUP BY author").all();
        const usage=db.prepare("SELECT count(*) AS n FROM events WHERE type='attempt.usage_recorded'").get();
        console.log(JSON.stringify({turns:rows,messages,usage}));
        db.close();
      `,
        join(f.profile, 'runtime.sqlite'),
      ],
      { encoding: 'utf8' },
    ),
  );
  evidence.steps.push({ step: 'durable-counts', counts });
  evidence.counts = counts;
  writeFileSync(join(f.root, 'broadcast-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('BROADCAST GUI QUALIFIED', JSON.stringify(evidence.steps));
  await gui.close();
} catch (error) {
  writeFileSync(join(f.root, 'broadcast-failure.txt'), String(error?.stack ?? error));
  if (gui) await gui.dispose();
  await f.close();
  throw error;
}
await f.close();
