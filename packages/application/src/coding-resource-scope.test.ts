import { expect, it } from 'vitest';
import { effectResourcesConflict } from '@runnets/domain';
import { codingResourceAdmission } from './coding-resource-scope.js';
it('builds only a conservative mutation conflict probe with both canonical footprints', () => {
  expect(codingResourceAdmission('/source', 'project', { id: 'task', root: '/worktree' })).toEqual({
    scope: {
      kind: 'resources',
      resources: [
        { kind: 'project-worktree', projectId: 'project', worktreeId: null },
        { kind: 'project-worktree', projectId: 'project', worktreeId: 'task' },
      ],
    },
    effectKind: 'mutation',
    grantReference: null,
    binding: { projectRoot: '/source', worktreeRoot: '/worktree' },
  });
});
it.each([
  '',
  'relative',
  '/source/../other',
  '/source/.',
  '/source//child',
  '/source/',
  '/source\0',
])('refuses noncanonical root %j', (root) => {
  expect(codingResourceAdmission(root, 'project')).toBeUndefined();
  expect(codingResourceAdmission('/source', 'project', { id: 'task', root })).toBeUndefined();
});
it('keeps project/worktree identity contradictions and overlaps conservative', () => {
  const a = codingResourceAdmission('/source-a', 'a', { id: 'task-a', root: '/work-a' });
  expect(
    effectResourcesConflict(
      a,
      codingResourceAdmission('/source-b', 'b', { id: 'task-b', root: '/work-b' }),
    ),
  ).toBe(false);
  for (const b of [
    codingResourceAdmission('/source-b', 'a', { id: 'task-b', root: '/work-b' }),
    codingResourceAdmission('/source-b', 'b', { id: 'task-a', root: '/work-b' }),
    codingResourceAdmission('/source-b', 'b', { id: 'task-b', root: '/WORK-A' }),
    codingResourceAdmission('/source-a/child', 'b', { id: 'task-b', root: '/work-b' }),
    codingResourceAdmission('/source-b', ''),
    undefined,
  ])
    expect(effectResourcesConflict(a, b)).toBe(true);
});
