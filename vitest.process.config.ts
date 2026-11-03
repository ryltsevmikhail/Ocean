import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';
import { processCases } from './vitest.process-cases.config.ts';

/** Run with pnpm test:process, which builds its own child entry points first. */
export default defineConfig({
  ...base,
  test: { ...base.test, include: processCases, maxWorkers: 2 },
});
