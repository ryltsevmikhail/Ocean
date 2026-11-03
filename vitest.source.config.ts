import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config.ts';
import { processCases } from './vitest.process-cases.config.ts';

/** Cold source preset: never relies on generated package or CLI output. */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    exclude: [...configDefaults.exclude, ...processCases],
    maxWorkers: 4,
    reporters: ['dot'],
  },
});
