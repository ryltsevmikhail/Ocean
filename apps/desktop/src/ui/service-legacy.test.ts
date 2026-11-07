import { expect, it } from 'vitest';
import { legacyServiceProposal } from './service-legacy.js';
import { providerKeyHint } from './provider-text.js';
import { settingsError } from './model-settings-text.js';
import type { PluginConnectionView } from '../plugin-protocol.js';
const row = {
  id: 'legacy-id',
  name: 'archive',
  generation: 2,
  endpoint: 'https://example.test/mcp',
  tools: ['a,b'],
  identity: 'old-account',
  repository: 'team/old',
  credentialReference: 'OLD_KEY',
} as unknown as PluginConnectionView;
it('prefills only declarative HTTP with stable generation identity and no inherited material/authority', async () => {
  const a = await legacyServiceProposal(row),
    b = await legacyServiceProposal(row);
  expect(a).toEqual(b);
  expect(a?.metadataPermission).toBe('none');
  expect(a).not.toHaveProperty('key');
  expect(a).not.toHaveProperty('grants');
  expect(a).not.toHaveProperty('credentialReference');
  expect((await legacyServiceProposal({ ...row, generation: 3 }))?.connectionId).not.toBe(
    a?.connectionId,
  );
  expect(await legacyServiceProposal({ ...row, endpoint: 'npm install arbitrary' })).toBeNull();
  expect(
    await legacyServiceProposal({ ...row, endpoint: 'https://user:secret@example.test' }),
  ).toBeNull();
});
it.each(['provider_secret_corrupt', 'provider_secret_insecure'])(
  'uses status.code %s for separate safe repair without deletion/reset advice',
  (code) => {
    const hint = providerKeyHint('synthetic', true, 'unverified', code as never);
    expect(hint).toContain('отдельного безопасного');
    expect(hint).not.toContain('удалите');
    expect(hint).not.toContain('synthetic');
    expect(settingsError(Error(code))).toContain('отдельное безопасное');
  },
);
