import { describe, expect, it } from 'vitest';
import { run } from '../../test-fixtures/plugin-command-fixture.js';

describe('ocean plugin commands', () => {
  it('lists the frozen catalog and inspects one card', async () => {
    const listed = await run(['catalog', 'list']);
    expect(listed.result.code).toBe(0);
    expect(Array.isArray(listed.result.data)).toBe(true);
    const inspected = await run(['catalog', 'inspect', '--plugin', 'github']);
    expect(inspected.result.code).toBe(0);
    expect(inspected.result.data).toMatchObject({ pluginId: 'github', version: '1.0.0' });
  });

  it('reports the real revoked-grant count when disconnecting (human mode)', async () => {
    const disconnected = await run(
      ['connections', 'disconnect', '--connection', 'conn_work'],
      false,
    );
    expect(disconnected.result.code).toBe(0);
    expect(disconnected.stdout).toContain('revoked grants 1');
  });

  it('repairs a corrupt install through the runtime', async () => {
    const repaired = await run(['catalog', 'repair', '--plugin', 'github']);
    expect(repaired.result.code).toBe(0);
    expect(repaired.calls.repair).toBe(1);
    expect(JSON.stringify(repaired.result.data)).toContain('github');
  });

  it('installs and enables the pinned version through the runtime', async () => {
    const installed = await run(['catalog', 'install', '--plugin', 'github']);
    expect(installed.result.code).toBe(0);
    expect(installed.calls.install).toBe(1);
    const enabled = await run(['catalog', 'enable', '--plugin', 'github']);
    expect(enabled.result.code).toBe(0);
    expect(enabled.calls.enable).toBe(1);
  });

  it('passes only an environment reference when adding a connection', async () => {
    const added = await run([
      'connections',
      'add',
      '--plugin',
      'github',
      '--name',
      'work',
      '--credential-env',
      'OCEAN_GITHUB_WORK_TOKEN',
      '--account',
      'Work',
    ]);
    expect(added.result.code).toBe(0);
    const request = added.calls.add[0] as Record<string, unknown>;
    expect(request['credentialReference']).toBe('OCEAN_GITHUB_WORK_TOKEN');
    expect(JSON.stringify(request)).not.toMatch(/ghp_|sk-/);
  });

  it('discovers only after the owner consents for the exact generation', async () => {
    const preview = await run(['connections', 'preview', '--connection', 'conn_work']);
    expect(JSON.stringify(preview.result.data)).toContain('https://api.githubcopilot.com/mcp/');
    expect(preview.calls.discover).toBe(0);
    // Consent without the shown-endpoint acknowledgement is refused first.
    const unacknowledged = await run([
      'connections',
      'consent',
      '--connection',
      'conn_work',
      '--generation',
      '2',
    ]);
    expect(unacknowledged.result.code).toBe(4);
    expect(unacknowledged.stderr).toContain('--acknowledge-endpoint');
    expect(unacknowledged.calls.consent).toBe(0);
    const grantedConsent = await run([
      'connections',
      'consent',
      '--connection',
      'conn_work',
      '--generation',
      '2',
      '--acknowledge-endpoint',
    ]);
    expect(grantedConsent.result.code).toBe(0);
    expect(grantedConsent.calls.consent).toBe(1);
    const discovered = await run([
      'connections',
      'discover',
      '--connection',
      'conn_work',
      '--generation',
      '2',
    ]);
    expect(discovered.result.code).toBe(0);
    expect(discovered.calls.discover).toBe(1);
  });

  it('prints the endpoint prompt before recording consent in human mode', async () => {
    const preview = await run(
      ['connections', 'consent', '--connection', 'conn_work', '--generation', '2'],
      false,
    );
    expect(preview.result.code).toBe(4);
    expect(preview.stdout).toContain('https://api.githubcopilot.com/mcp/');
    expect(preview.stderr).toContain('--acknowledge-endpoint');
    expect(preview.calls.consent).toBe(0);
  });
});
