import type { CodingBackupInventory, ProfileRebindComparison } from '@runnets/domain';
import { observeCodingFiles } from './coding-apply-observation.js';

/** These are facts about the explicitly selected root only. They never settle original effects. */
export function observeRebindFiles(
  root: string,
  inventory: CodingBackupInventory,
  taskId: string,
): readonly ProfileRebindComparison[] {
  const changes = inventory.changesets.filter((c) => c.taskId === taskId);
  const paths = [...new Set(changes.flatMap((c) => c.files.map((f) => f.path)))];
  let observed: ReturnType<typeof observeCodingFiles> = [];
  if (paths.length <= 1000) {
    try {
      observed = observeCodingFiles(root, paths);
    } catch {
      /* Unsupported evidence stays unknown. */
    }
  }
  const byPath = new Map(observed.map((o) => [o.path, o]));
  return changes.map((c) => {
    const states = c.files.map((f) => {
      const o = byPath.get(f.path);
      if (!o || o.kind === 'unavailable') return { unknown: true, before: false, after: false };
      const matches = (d: typeof f.before) =>
        d === null
          ? o.kind === 'missing'
          : o.kind === 'file' && o.sha256 === d.sha256 && o.mode === d.mode;
      return { unknown: false, before: matches(f.before), after: matches(f.after) };
    });
    const comparison: ProfileRebindComparison['comparison'] = states.some((s) => s.unknown)
      ? 'unknown'
      : states.every((s) => s.before)
        ? 'before'
        : states.every((s) => s.after)
          ? 'after'
          : states.every((s) => s.before || s.after)
            ? 'mixed'
            : 'conflicting';
    return {
      changesetHash: c.hash,
      comparison,
      scope: 'selected-project-only',
      settlesEffect: false,
    };
  });
}
