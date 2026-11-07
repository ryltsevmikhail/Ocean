import { expect, it } from 'vitest';
import {
  type ToolEffectAdmission,
  effectResourcesConflict,
  validToolEffectAdmission,
} from './effect-resource-conflicts.js';
function tree(projectId: string, worktreeId: string | null, root: string): ToolEffectAdmission {
  return {
    scope: { kind: 'resources', resources: [{ kind: 'project-worktree', projectId, worktreeId }] },
    effectKind: 'mutation',
    grantReference: null,
    binding: { worktreeRoot: root, projectRoot: root },
  };
}
it('partitions exact leased worktrees but preserves parent, alias and unproven holds', () => {
  const a = tree('project', 'a', '/work/a');
  expect(effectResourcesConflict(a, tree('project', 'b', '/work/b'))).toBe(false);
  for (const b of [
    tree('project', 'a', '/moved'),
    tree('rebound-project', 'a', '/other-project'),
    tree('alias', 'b', '/WORK/A'),
    tree('project', 'b', '/work/a/sub'),
    tree('project', null, '/src'),
    tree('p', 'b', '/work/../other'),
    { ...tree('p', 'b', '/else'), binding: null },
    undefined,
  ])
    expect(effectResourcesConflict(a, b)).toBe(true);
  expect(effectResourcesConflict(undefined, { ...a, effectKind: 'observation' })).toBe(true);
  expect(validToolEffectAdmission({ ...a, binding: 'x'.repeat(2097152) })).toBe(false);
  expect(validToolEffectAdmission({ ...a, scope: { kind: 'resources', resources: [] } })).toBe(
    false,
  );
});
