import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import type { CodingProjectPort } from '@runnets/application';
const exec = promisify(execFile);
/** Inspect only; never creates a worktree, stages files or runs repository hooks. */
export class GitCodingProject implements CodingProjectPort {
  async inspect(path: string): ReturnType<CodingProjectPort['inspect']> {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw Error('Project directory required');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
    };
    const filterOverrides: string[] = [];
    const git = async (args: string[]) => {
      const r = await exec(
        '/usr/bin/git',
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.untrackedCache=false',
          '-c',
          'core.quotePath=true',
          '-C',
          root,
          ...filterOverrides,
          ...args,
        ],
        { env, timeout: 5000, maxBuffer: 1048576 },
      );
      return r.stdout.trim();
    };
    if ((await realpath(await git(['rev-parse', '--show-toplevel']))) !== root)
      throw Error('Select repository root');
    const baseCommit = await git(['rev-parse', '--verify', 'HEAD']);
    if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw Error('Invalid project revision');
    try {
      const names = await git([
        'config',
        '--includes',
        '--null',
        '--name-only',
        '--get-regexp',
        '^filter[.].*[.](clean|process|required)$',
      ]);
      for (const name of names.split('\0').filter(Boolean)) {
        const prefix = name.slice(0, name.lastIndexOf('.'));
        filterOverrides.push(
          '-c',
          prefix + '.clean=',
          '-c',
          prefix + '.process=',
          '-c',
          prefix + '.required=false',
        );
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error;
    }
    const status = await git(['status', '--porcelain=v1', '--untracked-files=all']);
    return { root, baseCommit, clean: status === '' };
  }
}
