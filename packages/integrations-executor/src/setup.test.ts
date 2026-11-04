import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExecutorPluginSetup,
  ExecutorSetupError,
  PINNED_IDENTITIES,
  type ExecutorIntegrationInstall,
} from './index.js';

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
    expect(
      () =>
        new ExecutorPluginSetup(
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

  it('installs one integration and creates a connection from an environment reference', async () => {
    const setup = await ExecutorPluginSetup.open({
      ...tenant,
      resolveCredential: (reference) =>
        reference === 'OCEAN_GITHUB_WORK' ? 'fixture-token' : null,
    });
    try {
      const installed = await setup.installIntegration(github);
      expect(installed.integrationId).toBe('github');
      const created = await setup.createConnection({
        integrationId: 'github',
        connectionId: 'work',
        owner: 'user',
        template: 'bearer',
        credentialReference: 'OCEAN_GITHUB_WORK',
      });
      expect(created.connectionId).toBe('work');
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
    }
  });

  it('never puts a credential value into a failure message', async () => {
    const canary = 'CANARY_SETUP_CREDENTIAL_77af';
    const setup = await ExecutorPluginSetup.open({
      ...tenant,
      resolveCredential: () => canary,
    });
    try {
      await setup.installIntegration({ ...github, integrationId: 'second' });
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
    } finally {
      await setup.close();
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
