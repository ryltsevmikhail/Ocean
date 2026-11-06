import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
it.each(['http', 'revoke', 'refresh', 'drop'])(
  'qualifies normal owner/socket and independent client: %s',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-process-'));
    try {
      const child = await exec(
        process.execPath,
        [resolve('apps/cli/test-fixtures/mcp-normal-host.ts'), dir, mode],
        { timeout: 30000 },
      );
      const result = JSON.parse(child.stdout) as {
        model: number;
        calls: number;
        effects: number;
        preparedClaims: number;
        stopped: { outcome: string };
      };
      expect(result.model).toBe(mode === 'drop' ? 1 : 2);
      expect(result.calls).toBe(['http', 'drop'].includes(mode) ? 1 : 0);
      expect(result.effects).toBe(result.calls);
      if (mode === 'revoke' || mode === 'refresh') expect(result.preparedClaims).toBe(1);
      if (mode === 'drop') {
        const script = `import {startLocalRuntime} from './apps/cli/dist/local-runtime/host.js';import {DatabaseSync} from 'node:sqlite';
      const profile=process.argv[1];const host=await startLocalRuntime({profile,provider:null});
      const db=new DatabaseSync(profile+'/runtime.sqlite');const rows=db.prepare("SELECT outcome FROM tool_invocations_v2 WHERE outcome='uncertain'").all();db.close();
      console.log(JSON.stringify({rows,stop:await host.stop()}));`;
        const restart = await exec(
          process.execPath,
          ['--input-type=module', '-e', script, join(dir, 'profile')],
          { timeout: 20000 },
        );
        expect(JSON.parse(restart.stdout)).toMatchObject({
          rows: [{ outcome: 'uncertain' }],
          stop: { outcome: 'complete' },
        });
        expect(await readFile(join(dir, 'received'), 'utf8')).toBe('tools/call\n');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);
