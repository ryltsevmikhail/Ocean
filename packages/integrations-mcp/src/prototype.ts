import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { httpCases, runHttpCase } from './prototype-http.js';
import { nativeQualification } from './prototype-stdio.js';
import { accountCase } from './prototype-accounts.js';
import { empty, type Case } from './prototype-types.js';

export async function qualifyMcpPrototype(input: {
  root: string;
  githubTokenFile?: string;
  native: boolean;
}) {
  const cases: Case[] = [];
  await mkdir(input.root, { mode: 0o700, recursive: true });
  const dir = await mkdtemp(join(input.root, 'http-'));
  for (const name of httpCases) cases.push(await runHttpCase(name, join(dir, 'dispatches')));
  cases.push(await accountCase());
  cases.push(...(await nativeQualification(input.root, input.native)));
  let github = empty('github-issue-5');
  if (!input.githubTokenFile) github.detail = 'approved token file not supplied';
  else
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL('./prototype-github.js', import.meta.url)), input.githubTokenFile],
        { timeout: 24000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } },
      );
      github = JSON.parse(stdout) as Case;
    } catch {
      github.detail = 'isolated live process did not return a report';
    }
  cases.push(github);
  return { qualified: cases.every((item) => item.status === 'passed'), sdkVersion: '2.4.0', cases };
}
