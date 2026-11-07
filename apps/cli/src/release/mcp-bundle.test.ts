import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
