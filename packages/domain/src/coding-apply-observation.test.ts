import { expect, it } from 'vitest';
import type { CodingFileChange } from './changeset.js';
import { classifyCodingApplyFile } from './coding-apply-observation.js';
const before = { text: 'before', sha256: 'before-hash', mode: '100644' as const };
const after = { text: 'after', sha256: 'after-hash', mode: '100755' as const };
const change: CodingFileChange = { path: 'file', before, after };
it('compares exact recorded bytes and modes, distinguishing conflict and unavailable observations', () => {
  expect(
    classifyCodingApplyFile(
      change,
      { path: 'file', kind: 'file', sha256: before.sha256, mode: before.mode },
      [change],
    ),
  ).toBe('before');
  expect(
    classifyCodingApplyFile(
      change,
      { path: 'file', kind: 'file', sha256: after.sha256, mode: after.mode },
      [change],
    ),
  ).toBe('after');
  expect(
    classifyCodingApplyFile(
      change,
      { path: 'file', kind: 'file', sha256: after.sha256, mode: before.mode },
      [change],
    ),
  ).toBe('conflict');
  expect(
    classifyCodingApplyFile(change, { path: 'file', kind: 'missing', sha256: null, mode: null }, [
      change,
    ]),
  ).toBe('conflict');
  expect(
    classifyCodingApplyFile(
      change,
      { path: 'file', kind: 'unavailable', sha256: null, mode: null },
      [change],
    ),
  ).toBe('unavailable');
});
it('handles additions, deletions and declared file/directory refactors without treating arbitrary directories as missing', () => {
  const added = { ...change, before: null },
    deleted = { ...change, after: null };
  const missing = { path: 'file', kind: 'missing' as const, sha256: null, mode: null };
  expect(classifyCodingApplyFile(added, missing, [added])).toBe('before');
  expect(classifyCodingApplyFile(deleted, missing, [deleted])).toBe('after');
  const directory = { ...missing, kind: 'directory' as const };
  expect(classifyCodingApplyFile(added, directory, [added])).toBe('conflict');
  expect(
    classifyCodingApplyFile(added, directory, [added, { path: 'file/old', before, after: null }]),
  ).toBe('before');
  expect(
    classifyCodingApplyFile(deleted, directory, [
      deleted,
      { path: 'file/new', before: null, after },
    ]),
  ).toBe('after');
  expect(classifyCodingApplyFile(change, { ...missing, path: 'other' }, [change])).toBe(
    'unavailable',
  );
});
