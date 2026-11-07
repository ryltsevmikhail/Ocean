import { describe, expect, it } from 'vitest';
import {
  invalidatePluginPreview,
  pluginPreview,
  pluginCanGrant,
  pluginConnections,
  pluginConnectionId,
  pluginRepository,
  pluginBotId,
} from './plugin-state.js';

describe('desktop plugin grant preview freshness', () => {
  it('invalidates a stored preview when grant inputs change', () => {
    pluginPreview.value = {
      allowed: true,
      refusal: null,
      explanation: 'stale explanation',
      groupVisibility: false,
      participants: 0,
      scope: null,
    };
    invalidatePluginPreview();
    expect(pluginPreview.value).toBeNull();
  });
  it('does not offer a grant from published metadata without a ready runtime session', () => {
    pluginConnections.value = [
      {
        id: 'connection',
        name: 'work',
        pluginId: 'github',
        pluginVersion: '1.0.0',
        adapterVersion: 'adapter:1:sdk',
        endpoint: 'https://example.test',
        credentialReference: 'OCEAN_TOKEN',
        accountLabel: null,
        identity: null,
        identityLabel: 'unverified',
        state: 'active',
        generation: 1,
        schemaDigest: 'a'.repeat(64),
        tools: ['list_issues'],
        consented: false,
        consentedGeneration: null,
        consentedAt: null,
        lastDiscoveryAt: null,
        createdAt: 'now',
        updatedAt: 'now',
        readiness: 'discovery_required',
      },
    ];
    pluginConnectionId.value = 'connection';
    pluginRepository.value = 'team/api';
    pluginBotId.value = 'dev';
    expect(pluginCanGrant()).toBe(false);
    pluginConnections.value[0]!.readiness = 'ready';
    expect(pluginCanGrant()).toBe(true);
    pluginConnections.value = [];
    pluginConnectionId.value = '';
    pluginRepository.value = '';
    pluginBotId.value = '';
  });
});
