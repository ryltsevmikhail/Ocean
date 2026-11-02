import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
it('typechecks number, void and literal-false framing callbacks under strict TypeScript', () => {
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      '--noEmit',
      '--strict',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      '--noUncheckedIndexedAccess',
      '--exactOptionalPropertyTypes',
      'packages/tools-node/test-fixtures/local-runtime-callbacks.test.ts',
      'packages/tools-node/src/local-runtime-security.test.ts',
    ],
    { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
