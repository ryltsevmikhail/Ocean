import { createArchive } from './archive.js';
import { installArchive, sha256 } from './installer.js';
import { buildAdapterBundle as historicalBundle } from './legacy-bundle.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertProductionModule, buildAdapterBundle } from './bundle.js';
import { workspace } from '../../test-fixtures/release-repo.js';
it('bundles only the production public MCP root and imports it in isolation', async () => {
  const bundle = await buildAdapterBundle(workspace);
  const again = await buildAdapterBundle(workspace);
  expect(bundle.filesSha256).toEqual(again.filesSha256);
  expect(bundle.identities['@modelcontextprotocol/client']).toBe('2.4.0');
  expect(bundle.identities['@modelcontextprotocol/core']).toBe('2.4.0');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-bundle-'));
  try {
    mkdirSync(join(dir, 'dist'));
    mkdirSync(join(dir, 'node_modules/@runnets'), { recursive: true });
    for (const name of ['domain', 'application', 'tools-node', 'contracts'])
      symlinkSync(join(workspace, 'packages', name), join(dir, 'node_modules/@runnets', name));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const [path, body] of bundle.files) writeFileSync(join(dir, path), body);
    const script =
      'const m=await import(process.argv[1]);const t=m.createMcpServiceTransport({});console.log(JSON.stringify({exports:Object.keys(m),cleanup:await t.close()}));';
    const result = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script, join(dir, 'dist/index.js')],
      { encoding: 'utf8', cwd: dir },
    );
    expect(JSON.parse(result)).toEqual({
      exports: ['createMcpServiceTransport'],
      cleanup: { status: 'never_started' },
    });
    const code = bundle.files.get('dist/index.js')!.toString();
    expect(code).not.toMatch(
      /from ["'](?:@executor-js|@modelcontextprotocol\/server|rolldown)|qualification\.js/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('retains exact supported historical Executor archive validation for rollback', async () => {
  const legacy = await historicalBundle(workspace);
  const dir = mkdtempSync(join(tmpdir(), 'historical-adapter-'));
  try {
    const files = new Map<string, { body: Buffer; mode: number }>();
    const add = (name: string, body: string | Buffer) =>
      files.set(name, { body: Buffer.from(body), mode: 0o644 });
    const base = 'node_modules/@runnets/integrations-executor/';
    for (const name of ['bin/ocean', 'apps/cli/dist/main.js', 'LICENSE', 'NOTICE', 'package.json'])
      add(name, '{}');
    add(base + 'package.json', '{}');
    add(base + 'LICENSE', readFileSync(join(workspace, 'LICENSE')));
    for (const [name, body] of legacy.files) add(base + name, body);
    const inventory = Object.fromEntries(
      [...files].map(([name, file]) => [name, { sha256: sha256(file.body), mode: file.mode }]),
    );
    add(
      'manifest.json',
      JSON.stringify({
        format: 1,
        version: '1.1.0-rc.2',
        revision: 'a'.repeat(40),
        node: process.version,
        platform: 'linux',
        arch: 'x64',
        lockfileSha256: 'b'.repeat(64),
        files: inventory,
        bundle: {
          adapter: '@runnets/integrations-executor',
          entry: 'dist/index.js',
          integrity: 'dist/bundle-integrity.json',
          integritySha256: legacy.integritySha256,
          files: legacy.filesSha256,
          identities: legacy.identities,
        },
      }),
    );
    const bytes = createArchive(files),
      archive = join(dir, 'historical.tar.gz');
    writeFileSync(archive, bytes);
    expect(installArchive(archive, sha256(bytes), join(dir, 'prefix')).bundle?.adapter).toBe(
      '@runnets/integrations-executor',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('checks real dev module paths while allowing ancestor qualification and fixture names', () => {
  for (const path of [
    '/proof/qualification-source/packages/integrations-mcp/dist/session.js',
    '/proof/fixture-source/packages/integrations-mcp/dist/session.js',
  ])
    expect(() => assertProductionModule(path)).not.toThrow();
  for (const path of [
    '/project/packages/integrations-mcp/dist/qualification.js',
    '/project/packages/integrations-mcp/dist/prototype.js',
    '/project/packages/integrations-mcp/test-fixtures/native.ts',
    '/project/node_modules/@modelcontextprotocol/server/dist/index.mjs',
    '/project/packages/integrations-executor/dist/index.js',
    '/project/node_modules/@executor-js/sdk/dist/index.js',
    '/project/node_modules/rolldown/dist/index.mjs',
  ])
    expect(() => assertProductionModule(path), path).toThrow('dev-only module');
});
