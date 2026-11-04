import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExecutorPluginSetup,
  ExecutorSetupError,
  PINNED_IDENTITIES,
  type ExecutorIntegrationInstall,
} from './index.js';
import { mcpAuthTemplates, startMcpServer } from '../test-fixtures/mcp-server.js';

interface GuardedGlobal {
  readonly __oceanBlockedFetches?: readonly string[];
}
const blockedFetches = () => (globalThis as GuardedGlobal).__oceanBlockedFetches ?? [];
function expectNoExternalAttempts(): void {
  expect(blockedFetches().filter((url) => !url.includes('127.0.0.1'))).toEqual([]);
}
/** Loopback-only fixture so connection creation never leaves the machine. */
async function loopbackFixture() {
  const mcp = await startMcpServer('ok');
  return {
    mcp,
    tenant: { tenantId: 'tenant', subjectId: 'subject', allowedOrigins: [mcp.base] },
    integration: {
      ...github,
      endpoint: `${mcp.base}/mcp`,
      authTemplates: mcpAuthTemplates,
    } as ExecutorIntegrationInstall,
  };
}

const tenant = {
  tenantId: 'tenant',
  subjectId: 'subject',
  allowedOrigins: ['https://api.githubcopilot.com'],
};
const github: ExecutorIntegrationInstall = {
  integrationId: 'github',
  name: 'GitHub issues',
  description: 'read-only GitHub issue access',
  endpoint: 'https://api.githubcopilot.com/mcp/',
  authTemplates: [
    {
      slug: 'bearer',
      type: 'apiKey',
      headers: { Authorization: ['Bearer ', { type: 'variable', name: 'token' }] },
    },
  ],
};
function code(error: unknown): string {
  return error instanceof ExecutorSetupError ? error.code : String(error);
}

describe('executor plugin setup seam', () => {
  it('cannot bypass the pinned-chunk assertion or enable execution', () => {
    const source = readFileSync(join(import.meta.dirname, 'setup.ts'), 'utf8');
    expect(source).toContain('verifyInstalledSdkChunk');
    expect(source).toContain('PINNED_SDK_CHUNK_SHA256');
    expect(source).toContain("execution: 'disabled'");
    expect(source.includes('enableExecution?:')).toBe(false);
    expect(source.includes('enableExecution: true')).toBe(false);
    expect(source.includes('assessQualification')).toBe(false);
    const entry = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
    // The public entry keeps the plain setup surface and no Effect/SDK type import.
    expect(entry).toContain('ExecutorPluginSetup');
    expect(entry.includes('effect')).toBe(false);
    expect(entry.includes('@executor-js')).toBe(false);
  });
  it('accepts no qualification identity and no execution flag', async () => {
    for (const options of [
      { ...tenant, enableExecution: true },
      { ...tenant, identity: { ok: true } },
      { tenantId: '', subjectId: 'subject', allowedOrigins: ['https://api.githubcopilot.com'] },
      { ...tenant, allowedOrigins: [] },
    ]) {
      await expect(ExecutorPluginSetup.open(options as never)).rejects.toSatisfy(
        (error: unknown) => code(error) === 'invalid_options',
      );
    }
  });

  it('opens only on the pinned patched chunk with execution literally disabled', async () => {
    const setup = await ExecutorPluginSetup.open(tenant);
    try {
      expect(setup.status.execution).toBe('disabled');
      expect(setup.status.pinned['@executor-js/sdk']).toBe(PINNED_IDENTITIES['@executor-js/sdk']);
      expect(Object.isFrozen(setup.status)).toBe(true);
      expect(Object.isFrozen(setup.status.pinned)).toBe(true);
      // No dispatch surface exists on the setup seam.
      expect((setup as unknown as Record<string, unknown>)['discover']).toBeUndefined();
      expect((setup as unknown as Record<string, unknown>)['invoke']).toBeUndefined();
    } finally {
      await setup.close();
    }
  });

  it('refuses a construction token it did not mint', () => {
    // The constructor is token-sealed and private to the class declaration; the
    // forged-call probe needs the erased runtime constructor type.
    const ForgedSetup = ExecutorPluginSetup as unknown as new (
      ...args: unknown[]
    ) => ExecutorPluginSetup;
    expect(
      () =>
        new ForgedSetup(
          {} as never,
          { execution: 'disabled', pinned: {} },
          [],
          null,
          Symbol('forged') as never,
        ),
    ).toThrow('created through open() only');
  });

  it('validates the declarative integration before touching the SDK', async () => {
    const setup = await ExecutorPluginSetup.open(tenant);
    try {
      const invalid = [
        { ...github, endpoint: 'http://api.githubcopilot.com/mcp/' },
        { ...github, endpoint: 'https://user:pw@api.githubcopilot.com/mcp/' },
        { ...github, endpoint: 'https://api.githubcopilot.com/mcp/?x=1' },
        { ...github, endpoint: 'https://evil.example/mcp/' },
        { ...github, authTemplates: [] },
        { ...github, integrationId: 'GitHub' },
      ];
      for (const input of invalid)
        await expect(setup.installIntegration(input as never)).rejects.toSatisfy(
          (error: unknown) => code(error) === 'invalid_input',
        );
    } finally {
      await setup.close();
    }
  });

  it('installs one integration and creates a connection from an environment reference (loopback only)', async () => {
    const fixture = await loopbackFixture();
    const setup = await ExecutorPluginSetup.open({
      ...fixture.tenant,
      resolveCredential: (reference) =>
        reference === 'OCEAN_GITHUB_WORK' ? 'fixture-token' : null,
    });
    try {
      const installed = await setup.installIntegration(fixture.integration);
      expect(installed.integrationId).toBe('github');
      const created = await setup.createConnection({
        integrationId: 'github',
        connectionId: 'work',
        owner: 'user',
        template: 'bearer',
        credentialReference: 'OCEAN_GITHUB_WORK',
      });
      expect(created.connectionId).toBe('work');
      // Network effect: the SDK performed its upstream connect/tool-sync against
      // the loopback fixture only; no external host was attempted.
      expect(fixture.mcp.counts.total).toBeGreaterThan(0);
      expectNoExternalAttempts();
      // A missing environment reference is refused without leaking any value.
      await expect(
        setup.createConnection({
          integrationId: 'github',
          connectionId: 'personal',
          owner: 'user',
          template: 'bearer',
          credentialReference: 'OCEAN_GITHUB_MISSING',
        }),
      ).rejects.toSatisfy((error: unknown) => code(error) === 'credential_unavailable');
      // Undeclared auth templates and unknown integrations are refused.
      await expect(
        setup.createConnection({
          integrationId: 'github',
          connectionId: 'other',
          owner: 'user',
          template: 'oauth',
          credentialReference: 'OCEAN_GITHUB_WORK',
        }),
      ).rejects.toSatisfy((error: unknown) => code(error) === 'invalid_input');
      await expect(
        setup.createConnection({
          integrationId: 'missing',
          connectionId: 'other',
          owner: 'user',
          template: 'bearer',
          credentialReference: 'OCEAN_GITHUB_WORK',
        }),
      ).rejects.toSatisfy((error: unknown) => code(error) === 'invalid_input');
    } finally {
      await setup.close();
      await fixture.mcp.close();
    }
  });

  it('never puts a credential value into a failure message (loopback only)', async () => {
    const canary = 'CANARY_SETUP_CREDENTIAL_77af';
    const fixture = await loopbackFixture();
    const setup = await ExecutorPluginSetup.open({
      ...fixture.tenant,
      resolveCredential: () => canary,
    });
    try {
      await setup.installIntegration({ ...fixture.integration, integrationId: 'second' });
      await setup.createConnection({
        integrationId: 'second',
        connectionId: 'work',
        owner: 'user',
        template: 'bearer',
        credentialReference: 'OCEAN_TOKEN',
      });
      let message = '';
      try {
        // Re-creating the same connection makes the SDK refuse.
        await setup.createConnection({
          integrationId: 'second',
          connectionId: 'work',
          owner: 'user',
          template: 'bearer',
          credentialReference: 'OCEAN_TOKEN',
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(canary);
      expectNoExternalAttempts();
    } finally {
      await setup.close();
      await fixture.mcp.close();
    }
  });

  it('refuses every use after close', async () => {
    const setup = await ExecutorPluginSetup.open(tenant);
    await setup.close();
    await expect(setup.installIntegration(github)).rejects.toSatisfy(
      (error: unknown) => code(error) === 'setup_closed',
    );
    await expect(setup.close()).resolves.toBeUndefined();
  });
});
