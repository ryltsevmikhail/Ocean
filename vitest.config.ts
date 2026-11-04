import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests run against package sources (not built output) so the suite does not
 * require `tsc -b` first. Type-level guarantees still come from `pnpm typecheck`.
 */
const source = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@runnets/domain': source('domain'),
      '@runnets/application': source('application'),
      '@runnets/store': source('store'),
      '@runnets/tools-node': source('tools-node'),
      '@runnets/store-sqlite': source('store-sqlite'),
      '@runnets/contracts': source('contracts'),
      '@runnets/provider-core': source('provider-core'),
      '@runnets/provider-deepseek': source('provider-deepseek'),
      '@runnets/provider-openai': source('provider-openai'),
      '@runnets/integrations-executor': source('integrations-executor'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    setupFiles: ['./test-fixtures/no-network.ts'],
    reporters: ['default'],
  },
});
