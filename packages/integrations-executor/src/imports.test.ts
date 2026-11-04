/**
 * Static qualification of the package surface:
 *
 * - only public `/core` SDK subpaths are imported (the plugin roots carry no
 *   declaration file and must never be papered over with an ambient module),
 * - the application-owned port has no Effect/SDK imports at all,
 * - the package pins the qualified versions and the patch identity.
 *
 * The compile gate (`pnpm build`) is what proves the `/core` imports resolve
 * without ambient `any` declarations; the runtime probe below proves the same
 * entry points are actual functions.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packagesRoot = fileURLToPath(new URL('../../../', import.meta.url));
const executorPackageRoot = fileURLToPath(new URL('../', import.meta.url));

const sourceFiles = async (): Promise<readonly string[]> => {
  const entries = await readdir(new URL('../src/', import.meta.url), { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => entry.name);
};

const importSpecifiers = (source: string): readonly string[] => {
  const matches = source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g);
  return [...matches].map((match) => match[1] ?? '');
};

describe('package surface qualification', () => {
  it('imports the pinned SDK only through public /core entry points', async () => {
    const allowed = new Set([
      '@executor-js/sdk/core',
      '@executor-js/plugin-openapi/core',
      '@executor-js/plugin-mcp/core',
    ]);
    for (const file of await sourceFiles()) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('@executor-js/')) continue;
        expect(allowed.has(specifier), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('carries no ambient module declaration for the SDK', async () => {
    for (const file of await sourceFiles()) {
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source.includes('declare module'), file).toBe(false);
    }
  });

  it('the application port is free of Effect and Executor imports', async () => {
    const source = await readFile(
      new URL('../../application/src/service-plugin-transport.ts', import.meta.url),
      'utf8',
    );
    const specifiers = importSpecifiers(source);
    expect(specifiers).toHaveLength(0);
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it('the public entry point does not re-export SDK or Effect symbols', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source.includes('@executor-js')).toBe(false);
    expect(source.includes("from 'effect'")).toBe(false);
    expect(source.includes('sdk-')).toBe(false);
  });

  it('plugin /core entry points are real runtime functions', async () => {
    const openapi = await import('@executor-js/plugin-openapi/core');
    const mcp = await import('@executor-js/plugin-mcp/core');
    const sdk = await import('@executor-js/sdk/core');
    expect(typeof openapi.openApiPlugin).toBe('function');
    expect(typeof mcp.mcpPlugin).toBe('function');
    expect(typeof sdk.createExecutor).toBe('function');
  });
});

describe('pinned workspace wiring', () => {
  it('package.json pins the qualified versions exactly', async () => {
    const source = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const manifest = JSON.parse(source) as { dependencies: Record<string, string> };
    expect(manifest.dependencies['@executor-js/sdk']).toBe('1.6.11');
    expect(manifest.dependencies['@executor-js/plugin-openapi']).toBe('1.6.11');
    expect(manifest.dependencies['@executor-js/plugin-mcp']).toBe('1.6.11');
    expect(manifest.dependencies.effect).toBe('4.0.0-beta.59');
    expect(manifest.dependencies['@effect/platform-node-shared']).toBe('4.0.0-beta.59');
  });

  it('the workspace patches the SDK and the lockfile records that patch hash', async () => {
    const workspace = await readFile(`${packagesRoot}pnpm-workspace.yaml`, 'utf8');
    expect(workspace).toContain(
      "'@executor-js/sdk@1.6.11': patches/@executor-js__sdk@1.6.11.patch",
    );
    expect(workspace).toContain("'@effect/platform-node-shared': 4.0.0-beta.59");
    const lockfile = await readFile(`${packagesRoot}pnpm-lock.yaml`, 'utf8');
    expect(lockfile).toContain(
      'patch_hash=e1c1bfa9a41049321f45747f3ae8907d89604fca06872ec0a4871483db1b9fad',
    );
  });

  it('the package directory is part of the build graph', async () => {
    const rootTsconfig = await readFile(`${packagesRoot}tsconfig.json`, 'utf8');
    expect(rootTsconfig).toContain('packages/integrations-executor');
    expect(executorPackageRoot.endsWith('/packages/integrations-executor/')).toBe(true);
  });
});
