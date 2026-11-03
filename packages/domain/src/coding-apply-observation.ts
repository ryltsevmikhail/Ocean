import type { CodingFileChange, CodingFileMode } from './changeset.js';
export interface CodingApplyFileObservation {
  readonly path: string;
  readonly kind: 'file' | 'missing' | 'directory' | 'unavailable';
  readonly sha256: string | null;
  readonly mode: CodingFileMode | null;
}
export type CodingApplyFileComparison = 'before' | 'after' | 'conflict' | 'unavailable';
/** File-entry comparison is diagnostic evidence, never proof that the whole tree is unchanged. */
export function classifyCodingApplyFile(
  change: CodingFileChange,
  actual: CodingApplyFileObservation,
  changes: readonly CodingFileChange[],
): CodingApplyFileComparison {
  if (actual.path !== change.path || actual.kind === 'unavailable') return 'unavailable';
  const matches = (side: 'before' | 'after') => {
    const expected = change[side];
    if (actual.kind === 'file')
      return (
        expected !== null && actual.sha256 === expected.sha256 && actual.mode === expected.mode
      );
    if (actual.kind === 'missing') return expected === null;
    return (
      expected === null &&
      changes.some((child) => child.path.startsWith(change.path + '/') && child[side] !== null)
    );
  };
  const before = matches('before'),
    after = matches('after');
  return before === after ? 'conflict' : before ? 'before' : 'after';
}
