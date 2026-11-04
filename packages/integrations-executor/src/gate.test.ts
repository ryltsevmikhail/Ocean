/**
 * Qualification-gate regression tests for the fix round:
 *
 * - execution is disabled by default through the public `open()` factory,
 * - `open()` verifies the pinned installed chunk on every admission,
 * - a forged/`ok:true` identity cannot qualify (pinned-constant cross-check),
 * - the returned status is frozen,
 * - the public entry point exposes no internal gate seam and no Effect types,
 * - OAuth setup cannot bypass the guarded client, and MCP transport is pinned.
 */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { mcpPlugin } from '@executor-js/plugin-mcp/core';

import { PINNED_SDK_CHUNK_SHA256 } from './pinned-identity.js';
import { createExecutorHost } from './sdk-boundary.js';
import { assessQualification } from './status.js';
import { ExecutorTransportOpenError } from './status.js';
import { createTestTransport } from './test-support.js';
import { ExecutorServicePluginTransport } from './transport.js';
import { listen, closeServer } from '../test-fixtures/loopback.js';

const forgedIdentity = {
  ok: true as const,
  expectedSha256: '0'.repeat(64),
  actualSha256: '0'.repeat(64),
  chunkPath: '/forged/chunk.js',
  detail: 'forged identity',
};

const target = { integrationId: 'probe', connectionId: 'work', owner: 'user' as const };

describe('public qualification gate', () => {
  it('open() stays disabled by default and makes zero network requests', async () => {
    let requests = 0;
    const origin = await listen((_req, res) => {
      requests += 1;
      res.writeHead(500);
      res.end();
    });
    // Execution-disabled default is enforced at the factory: no transport can
    // even be obtained unless execution was explicitly enabled.
    await expect(
      ExecutorServicePluginTransport.open({
        tenantId: 'probe-tenant',
        subjectId: 'probe-subject',
        allowedOrigins: [origin.base],
      }),
    ).rejects.toMatchObject({ reason: 'execution_not_enabled' });
    expect(requests).toBe(0);
    await closeServer(origin.server);
  });

  it('an internally-built unqualified transport refuses both operations with zero network', async () => {
    let requests = 0;
    const origin = await listen((_req, res) => {
      requests += 1;
      res.writeHead(500);
      res.end();
    });
    const host = await createExecutorHost({
      tenantId: 'probe-tenant',
      subjectId: 'probe-subject',
      allowedOrigins: [origin.base],
    });
    const transport = await createTestTransport(host);
    expect(transport.qualification()).toMatchObject({
      qualified: false,
      reason: 'execution_not_enabled',
    });
    const outcome = await transport.invoke(target, {
      invocationId: 'disabled',
      tool: 'write_thing',
      arguments: { value: 'x' },
    });
    expect(outcome).toMatchObject({ kind: 'not_started', code: 'execution_disabled' });
    await expect(transport.discover(target)).rejects.toMatchObject({ code: 'execution_disabled' });
    expect(requests).toBe(0);
    await transport.close();
    await closeServer(origin.server);
  });

  it('open() enables only when explicitly requested and the installed chunk is pinned', async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const transport = await ExecutorServicePluginTransport.open({
      tenantId: 'probe-tenant',
      subjectId: 'probe-subject',
      allowedOrigins: [origin.base],
      enableExecution: true,
    });
    expect(transport.qualification().qualified).toBe(true);
    expect(transport.status().installedChunkSha256).toBe(PINNED_SDK_CHUNK_SHA256);
    expect(transport.qualification().identities['@executor-js/sdk']).toBe('1.6.11');
    await transport.close();
    await closeServer(origin.server);
  });

  it('open() rejects malformed options with a typed invalid_options error', async () => {
    await expect(
      ExecutorServicePluginTransport.open({
        tenantId: '',
        subjectId: 's',
        allowedOrigins: ['http://127.0.0.1:1'],
      }),
    ).rejects.toMatchObject({ reason: 'invalid_options' });
    await expect(
      ExecutorServicePluginTransport.open({
        tenantId: 't',
        subjectId: 's',
        allowedOrigins: ['ftp://127.0.0.1:1'],
      }),
    ).rejects.toBeInstanceOf(ExecutorTransportOpenError);
    await expect(
      ExecutorServicePluginTransport.open({ tenantId: 't', subjectId: 's', allowedOrigins: [] }),
    ).rejects.toMatchObject({ reason: 'invalid_options' });
  });

  it('a forged ok:true identity cannot qualify: the pinned constant is cross-checked', () => {
    const status = assessQualification({ requested: true, identity: forgedIdentity });
    expect(status.qualified).toBe(false);
    expect(status.reason).toBe('pinned_chunk_mismatch');

    const realPinned = assessQualification({
      requested: true,
      identity: {
        ok: true,
        expectedSha256: PINNED_SDK_CHUNK_SHA256,
        actualSha256: PINNED_SDK_CHUNK_SHA256,
        chunkPath: '/pinned/chunk.js',
        detail: 'pinned',
      },
    });
    expect(realPinned.qualified).toBe(true);
  });

  it('the returned qualification status is frozen and cannot be flipped', async () => {
    const host = await createExecutorHost({
      tenantId: 't',
      subjectId: 's',
      allowedOrigins: ['http://127.0.0.1:1'],
    });
    const transport = await createTestTransport(host);
    const status = transport.status();
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.identities)).toBe(true);
    expect(() => {
      (status as { qualified: boolean }).qualified = true;
    }).toThrow(TypeError);
    expect(transport.qualification().qualified).toBe(false);
    await transport.close();
  });

  it('the package entry exports no internal gate seam', async () => {
    const entry = await import('./index.js');
    expect(Object.keys(entry).sort()).toEqual([
      'ExecutorPluginSetup',
      'ExecutorServicePluginTransport',
      'ExecutorSetupError',
      'ExecutorTransportOpenError',
      'PINNED_IDENTITIES',
    ]);
    expect('fromHost' in entry.ExecutorServicePluginTransport).toBe(false);
    // The deliberate Task 5 setup seam is execution-disabled and exposes no
    // internal gate: no dispatch methods, no pinned-verification helpers.
    expect('discover' in entry.ExecutorPluginSetup.prototype).toBe(false);
    expect('invoke' in entry.ExecutorPluginSetup.prototype).toBe(false);
    expect('verifyInstalledSdkChunk' in entry).toBe(false);
    expect('createInternalTransport' in entry).toBe(false);
    expect('verifyInstalledSdkChunk' in entry).toBe(false);
    expect('assessQualification' in entry).toBe(false);
  });

  it('OAuth setup has no ambient fetch fallback in the shipped path', async () => {
    const setup = await readFile(new URL('./sdk-setup.ts', import.meta.url), 'utf8');
    expect(setup).toContain('oauth_setup_unavailable');
    expect(setup).not.toContain('globalThis.fetch');
    expect(setup).not.toMatch(/[^.]\bfetch\(/);
    const host = await createExecutorHost({
      tenantId: 't',
      subjectId: 's',
      allowedOrigins: ['http://127.0.0.1:1'],
    });
    await expect(
      host.createOAuthConnection({
        integrationId: 'missing',
        connectionId: 'work',
        template: 'oauth',
        clientSlug: 'first-party:probe',
      }),
    ).rejects.toBeInstanceOf(Error);
    await host.close();
  });

  it('MCP installation refuses anything but streamable-http', async () => {
    const origin = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const host = await createExecutorHost({
      tenantId: 't',
      subjectId: 's',
      allowedOrigins: [origin.base],
      plugins: [mcpPlugin()],
    });
    await expect(
      host.installMcp({
        name: 'stdio attempt',
        description: 'must be refused',
        endpoint: '/usr/local/bin/evil',
        // Runtime-forged value a model could try to smuggle through a host bug.
        remoteTransport: 'stdio' as 'streamable-http',
        authTemplates: [],
      }),
    ).rejects.toMatchObject({ tag: 'unsupported_transport' });
    await host.close();
    await closeServer(origin.server);
  });
});
