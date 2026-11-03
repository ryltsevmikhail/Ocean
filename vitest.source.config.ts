import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';
import { processCases } from './vitest.process-cases.config.ts';

/** Cold source preset: never relies on generated package or CLI output. */
export default mergeConfig(
  base,
  defineConfig({
    test: { exclude: [...configDefaults.exclude, ...processCases], maxWorkers: 4 },
  }),
);
