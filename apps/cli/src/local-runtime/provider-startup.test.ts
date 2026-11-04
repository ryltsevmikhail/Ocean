import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { providerHostSettings } from './provider-settings.js';
import { openSqliteStore } from '@runnets/store-sqlite';
import { createProviderSecretStore } from '@runnets/tools-node';
import {
  privateRoot,
  vendorFixture,
  startProviderHost,
  completedRun,
  type StartedHost,
} from '../../test-fixtures/local-provider-host.test.js';

it('starts and serves a saved canonical connection independently of legacy facade eligibility', async () => {
  const vendor = await vendorFixture();
  const profile = await privateRoot();
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-external-must-not-be-used');
  const secrets = createProviderSecretStore(profile.credentialDir);
  secrets.write('psec_fixturestartup', 'fixture-saved-key');
  const db = openSqliteStore({ path: join(profile.profile, 'runtime.sqlite') });
  let started: StartedHost | undefined;
  try {
    const previous = db.providerConnections.connections.read('legacy:deepseek')!;
    const record = {
      ...previous,
      legacyEnvironment: false,
      secretRef: 'psec_fixturestartup',
      revision: 1,
      intent: 'active' as const,
    };
    db.providerConnections.connections.put(record, 0);
    const read = vi.spyOn(secrets, 'read');
    started = await startProviderHost(profile, { baseUrl: vendor.url, secretStore: secrets });
    expect(read).not.toHaveBeenCalled();
    await expect(started.client.providerStatus()).rejects.toThrow('provider_unverified');
    const legacy = providerHostSettings({
      store: db.providerConnections,
      profile: profile.profile,
      env: {},
      restored: false,
      injected: null,
      disabled: false,
      mutationsAllowed: true,
      secretStore: secrets,
    });
    expect(legacy.settings.dispatch('provider.status', {}, new AbortController().signal)).toEqual({
      error: { code: 'provider_unverified' },
    });
    const request = {
      workspaceId: 'ws_ocean',
      roomId: profile.roomId,
      requestId: 'saved-turn',
      text: 'hello',
    };
    const receipt = await started.client.submit(request);
    expect(await completedRun(started.client, profile, receipt.runId!)).toMatchObject({
      turnStatus: 'completed',
    });
    expect(
      vendor.requests.filter((r) => r.url === '/chat/completions').map((r) => r.authorization),
    ).toEqual(['Bearer fixture-saved-key']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(db.providerConnections.connections.read('legacy:deepseek')?.legacyEnvironment).toBe(
      false,
    );
    db.providerConnections.connections.put({ ...record, revision: 2, intent: 'disconnected' }, 1);
    await expect(started.client.submit({ ...request, requestId: 'blocked-turn' })).rejects.toThrow(
      'provider_unavailable',
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(vendor.requests.filter((r) => r.url === '/chat/completions')).toHaveLength(1);
    expect(db.providerConnections.connections.read('legacy:deepseek')?.legacyEnvironment).toBe(
      false,
    );
  } finally {
    await started?.stop();
    db.close();
    await vendor.close();
    profile.dispose();
  }
});
