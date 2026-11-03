import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { CodingBackupInventory } from '@runnets/domain';
import { observeRebindFiles } from './profile-rebind-observe.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const content = (text: string) => ({ mode: '100644' as const, sha256: sha(text) });
function project(entries: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rebind-observe-'));
  roots.push(root);
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const inventory = (
  files: readonly {
    path: string;
    before: { mode: '100644'; sha256: string } | null;
    after: ReturnType<typeof content> | null;
  }[],
): CodingBackupInventory =>
  ({
    format: 1,
    hash: 'a'.repeat(64),
    tasks: [],
    worktrees: [],
    changesets: [
      {
        hash: 'c'.repeat(64),
        taskId: 'task',
        baseCommit: 'b'.repeat(40),
        beforeTreeHash: 'd'.repeat(64),
        afterTreeHash: 'e'.repeat(64),
        files,
      },
      {
        hash: 'f'.repeat(64),
        taskId: 'other',
        baseCommit: 'b'.repeat(40),
        beforeTreeHash: 'd'.repeat(64),
        afterTreeHash: 'e'.repeat(64),
        files: [{ path: 'other.txt', before: content('x'), after: content('y') }],
      },
    ],
    applications: [],
  }) as unknown as CodingBackupInventory;

it.each([
  {
    name: 'before',
    root: () => project({ 'a.txt': 'base\n' }),
    files: [{ path: 'a.txt', before: content('base\n'), after: content('changed\n') }],
    expected: ['before'],
  },
  {
    name: 'after',
    root: () => project({ 'a.txt': 'changed\n' }),
    files: [{ path: 'a.txt', before: content('base\n'), after: content('changed\n') }],
    expected: ['after'],
  },
  {
    name: 'mixed',
    root: () => project({ 'a.txt': 'base\n', 'b.txt': 'changed\n' }),
    files: [
      { path: 'a.txt', before: content('base\n'), after: content('changed\n') },
      { path: 'b.txt', before: content('base\n'), after: content('changed\n') },
    ],
    expected: ['mixed'],
  },
  {
    name: 'conflicting',
    root: () => project({ 'a.txt': 'neither\n' }),
    files: [{ path: 'a.txt', before: content('base\n'), after: content('changed\n') }],
    expected: ['conflicting'],
  },
  {
    name: 'unknown for an unavailable path',
    root: () => {
      const root = project({ 'real/a.txt': 'base\n' });
      symlinkSync(join(root, 'real'), join(root, 'linked'));
      return root;
    },
    files: [{ path: 'linked/a.txt', before: content('base\n'), after: content('changed\n') }],
    expected: ['unknown'],
  },
  {
    name: 'unknown for a missing selected root',
    root: () => {
      const root = project({ 'a.txt': 'base\n' });
      rmSync(root, { recursive: true });
      return root;
    },
    files: [{ path: 'a.txt', before: content('base\n'), after: content('changed\n') }],
    expected: ['unknown'],
  },
] as const)(
  'classifies selected-project changesets as $name without settling external effects',
  ({ root, files, expected }) => {
    const comparisons = observeRebindFiles(root(), inventory(files), 'task');
    expect(comparisons.map((c) => c.comparison)).toEqual(expected);
    expect(comparisons.map((c) => c.changesetHash)).toEqual(['c'.repeat(64)]);
    // Diagnostics are scope-limited facts. They never claim the inaccessible original
    // interval or external provider/test effects were reconciled.
    for (const comparison of comparisons) {
      expect(comparison).toEqual({
        changesetHash: 'c'.repeat(64),
        comparison: expected[0],
        scope: 'selected-project-only',
        settlesEffect: false,
      });
    }
  },
);

it('distinguishes both states in one changeset from mixed file states', () => {
  const root = project({ 'a.txt': 'base\n', 'b.txt': 'changed\n' });
  const comparisons = observeRebindFiles(
    root,
    inventory([
      { path: 'a.txt', before: content('base\n'), after: null },
      { path: 'b.txt', before: null, after: content('changed\n') },
    ]),
    'task',
  );
  // a.txt matches before, b.txt matches after: one changeset is mixed, not after.
  expect(comparisons.map((c) => c.comparison)).toEqual(['mixed']);
});

it('reports an unsupported observation root as unknown rather than inferring a state', () => {
  // A relative path is not the canonical absolute project root required by the reader.
  const comparisons = observeRebindFiles(
    '.',
    inventory([{ path: 'a.txt', before: content('base\n'), after: content('changed\n') }]),
    'task',
  );
  expect(comparisons.map((c) => c.comparison)).toEqual(['unknown']);
  expect(comparisons[0]).toMatchObject({ scope: 'selected-project-only', settlesEffect: false });
});
