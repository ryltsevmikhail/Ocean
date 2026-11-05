import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it.each(['metadata', 'execution', 'categories'])(
  'qualifies built model %s canonical snapshots',
  async (scenario) => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../test-fixtures/model-process-scenario.test.ts', import.meta.url),
        ),
        scenario,
      ],
      {
        timeout: 90000,
        env: {
          NODE_NO_WARNINGS: '1',
          LANG: 'C.UTF-8',
          ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
        },
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ scenario });
    console.log(result.stdout.trim());
  },
  95000,
);
