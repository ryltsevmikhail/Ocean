import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});
import { withProfileArchive } from './profile-backup-verify.js';
import { ProfileBackupBudget } from './profile-backup-session.js';
import { profileArchiveContext } from './profile-archive-context.js';
const roots: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function archive() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-metadata-'));
  roots.push(root);
  return root;
}
it('reserves combined JSON bodies before any archive body reader or consumer', async () => {
  const root = archive(),
    actual = await vi.importActual<typeof fs>('node:fs');
  fs.mkdirSync(join(root, 'assets'), { mode: 0o700 });
  for (const name of ['snapshot.json', 'assets/catalog.json'])
    fs.writeFileSync(join(root, name), JSON.stringify('x'.repeat(6000)), { mode: 0o600 });
  let reads = 0,
    reached = false;
  vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (actual.realpathSync('/proc/self/fd/' + args[0]).startsWith(root + '/')) reads++;
    return actual.readSync(...args);
  }) as typeof fs.readSync);
  expect(() =>
    profileArchiveContext.run(
      { budget: new ProfileBackupBudget({ metadata: 12000 }), roots: [] },
      () =>
        withProfileArchive(root, () => {
          reached = true;
        }),
    ),
  ).toThrow('profile_backup_limit');
  expect(reads).toBe(0);
  expect(reached).toBe(false);
});
it('charges one original metadata identity once across nested repeated verification', () => {
  const root = archive();
  fs.mkdirSync(join(root, 'assets'), { mode: 0o700 });
  fs.writeFileSync(join(root, 'assets/catalog.json'), JSON.stringify('x'.repeat(14000)), {
    mode: 0o600,
  });
  let reached = 0;
  profileArchiveContext.run(
    { budget: new ProfileBackupBudget({ metadata: 25000 }), roots: [] },
    () =>
      withProfileArchive(root, () => {
        for (let i = 0; i < 3; i++) withProfileArchive(join(root, 'assets'), () => reached++);
      }),
  );
  expect(reached).toBe(3);
});

it('sums different archive occurrences instead of deduplicating equal JSON content', () => {
  const first = archive(),
    second = archive(),
    body = JSON.stringify('x'.repeat(6000));
  for (const root of [first, second])
    fs.writeFileSync(join(root, 'catalog.json'), body, { mode: 0o600 });
  let reached = 0;
  expect(() =>
    profileArchiveContext.run(
      { budget: new ProfileBackupBudget({ metadata: 14000 }), roots: [] },
      () => {
        withProfileArchive(first, () => reached++);
        withProfileArchive(second, () => reached++);
      },
    ),
  ).toThrow('profile_backup_limit');
  expect(reached).toBe(1);
});
