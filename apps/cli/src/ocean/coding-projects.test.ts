import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  registerCodingProject,
  readCodingProjects,
  validateCodingProject,
} from './coding-projects.js';
it('persists only the owner-confirmed exact project configuration privately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocean-project-registry-'));
  const project = {
    id: 'ocean',
    root,
    testPresets: [{ id: 'test', program: '/toolchain/pnpm/bin/pnpm', args: ['test'], cwd: '.' }],
    mounts: [],
  };
  try {
    await expect(registerCodingProject(root, project, async () => false)).rejects.toThrow(
      'approval_required',
    );
    await expect(readFile(join(root, 'coding-projects.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await registerCodingProject(root, project, async (preview) => {
      expect(preview).toEqual(project);
      return true;
    });
    expect(await readCodingProjects(root)).toEqual([project]);
    expect((await stat(join(root, 'coding-projects.json'))).mode & 0o777).toBe(0o600);
    await expect(registerCodingProject(root, project, async () => true)).rejects.toThrow(
      'already registered',
    );
    await expect(
      validateCodingProject({
        ...project,
        testPresets: [...project.testPresets, ...project.testPresets],
      }),
    ).rejects.toThrow('preset');
    await expect(validateCodingProject({ ...project, unexpected: 'authority' })).rejects.toThrow(
      'configuration',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
