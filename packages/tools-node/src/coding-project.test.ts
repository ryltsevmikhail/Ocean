import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { GitCodingProject } from './coding-project.js';
const roots: string[] = [];
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ocean-project-'));
  roots.push(dir);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(dir, 'file.txt'), 'original\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  return { dir, git };
}
it('canonicalizes a root alias, detects untracked/modified files and rejects a subdirectory', async () => {
  const { dir } = setup(),
    port = new GitCodingProject();
  const clean = await port.inspect(dir);
  expect(clean.clean).toBe(true);
  expect(clean.baseCommit).toMatch(/^[a-f0-9]{40,64}$/);
  const alias = dir + '-alias';
  symlinkSync(dir, alias);
  roots.push(alias);
  expect((await port.inspect(alias)).root).toBe(dir);
  writeFileSync(join(dir, 'new.txt'), 'untracked');
  expect((await port.inspect(dir)).clean).toBe(false);
  await expect(port.inspect(join(dir, '.git'))).rejects.toThrow();
});
it('never executes repository fsmonitor or clean/process filters during inspection', async () => {
  const { dir, git } = setup();
  const marker = join(dir, 'should-not-run');
  git('config', 'core.fsmonitor', 'touch ' + marker);
  git('config', 'filter.evil.clean', 'touch ' + marker);
  git('config', 'filter.evil.process', 'touch ' + marker);
  git('config', 'filter.evil.required', 'true');
  writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n');
  writeFileSync(join(dir, 'file.txt'), 'changed\n');
  const state = await new GitCodingProject().inspect(dir);
  expect(state.clean).toBe(false);
  expect(existsSync(marker)).toBe(false);
});

it('disables same-size clean filters from Git worktree configuration too', async () => {
  const { dir, git } = setup(),
    marker = join(dir, 'worktree-filter-must-not-run');
  git('config', 'extensions.worktreeConfig', 'true');
  git('config', '--worktree', 'filter.evil.clean', 'touch ' + marker + '; cat');
  git('config', '--worktree', 'filter.evil.required', 'true');
  writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n');
  writeFileSync(join(dir, 'file.txt'), 'modified\n');
  const state = await new GitCodingProject().inspect(dir);
  expect(state.clean).toBe(false);
  expect(existsSync(marker)).toBe(false);
});
