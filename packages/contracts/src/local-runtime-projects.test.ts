import { expect, it } from 'vitest';
import * as c from './index.js';

const workspaceId = 'ws_ocean';
const task = {
  id: 'task',
  status: 'reserved',
  ownerRoomId: 'dev-room',
  devBotId: 'dev',
  reviewRoomId: 'review-room',
  reviewBotId: 'review',
  worktreeReady: true,
};
const project = { id: 'project', root: '/fixture/project', presetIds: ['test'] };

it('accepts only bounded pages and registered project IDs, never paths or extra fields', () => {
  expect(c.isCodingProjectsList({ workspaceId, after: 'a-1', limit: 50 })).toBe(true);
  expect(c.isCodingTasksList({ workspaceId, projectId: 'a-1', after: 'task', limit: 1 })).toBe(
    true,
  );
  for (const extra of [
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { after: '' },
    { after: 'x'.repeat(129) },
  ]) {
    expect(c.isCodingProjectsList({ workspaceId, ...extra })).toBe(false);
    expect(c.isCodingTasksList({ workspaceId, projectId: 'project', ...extra })).toBe(false);
  }
  expect(c.isCodingProjectsList({ workspaceId, after: '/unregistered' })).toBe(false);
  expect(c.isCodingTasksList({ workspaceId, projectId: '/unregistered' })).toBe(false);
  expect(
    c.isCodingTasksList({ workspaceId, projectId: 'project', projectRoot: '/unregistered' }),
  ).toBe(false);
});

it('accepts only safe, bounded projections with a cursor matching the final row', () => {
  const projects = { workspaceId, projects: [project], nextAfter: 'project' };
  const tasks = { workspaceId, projectId: 'project', tasks: [task], nextAfter: 'task' };
  expect(c.isCodingProjectsPage(projects)).toBe(true);
  expect(c.isCodingTasksPage(tasks)).toBe(true);
  expect(c.isCodingProjectsPage({ ...projects, projects: [{ ...project, mounts: [] }] })).toBe(
    false,
  );
  expect(
    c.isCodingProjectsPage({ ...projects, projects: [{ ...project, root: 'relative' }] }),
  ).toBe(false);
  expect(
    c.isCodingProjectsPage({
      ...projects,
      projects: [{ ...project, presetIds: ['x'.repeat(129)] }],
    }),
  ).toBe(false);
  expect(c.isCodingProjectsPage({ ...projects, nextAfter: 'other' })).toBe(false);
  expect(c.isCodingTasksPage({ ...tasks, tasks: [{ ...task, lease: 'private' }] })).toBe(false);
  expect(c.isCodingTasksPage({ ...tasks, tasks: [{ ...task, status: 'unknown' }] })).toBe(false);
  expect(c.isCodingTasksPage({ ...tasks, tasks: Array(51).fill(task) })).toBe(false);
  expect(c.isCodingTasksPage({ ...tasks, tasks: [task, task] })).toBe(false);
});
