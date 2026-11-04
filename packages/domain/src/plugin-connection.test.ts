import { describe, expect, it } from 'vitest';
import {
  pluginIdentityLabel,
  validPluginConnectionName,
  validPluginConnectionState,
  validPluginSchemaDigest,
} from './plugin-connection.js';

describe('plugin connection validation', () => {
  it('accepts only bounded names and the two durable states', () => {
    expect(validPluginConnectionName('work')).toBe(true);
    expect(validPluginConnectionName('personal')).toBe(true);
    expect(validPluginConnectionName('')).toBe(false);
    expect(validPluginConnectionName('a'.repeat(65))).toBe(false);
    expect(validPluginConnectionName('work account')).toBe(false);
    expect(validPluginConnectionState('active')).toBe(true);
    expect(validPluginConnectionState('disconnected')).toBe(true);
    expect(validPluginConnectionState('connected')).toBe(false);
  });
  it('requires a sha256 schema digest', () => {
    expect(validPluginSchemaDigest('a'.repeat(64))).toBe(true);
    expect(validPluginSchemaDigest('A'.repeat(64))).toBe(false);
    expect(validPluginSchemaDigest('a'.repeat(63))).toBe(false);
    expect(validPluginSchemaDigest(null)).toBe(false);
  });
});

describe('honest identity labels', () => {
  it('never calls an unobserved or owner-supplied account verified', () => {
    expect(pluginIdentityLabel({ identity: null, identityVerified: false })).toBe('unverified');
    expect(pluginIdentityLabel({ identity: 'Work account', identityVerified: false })).toBe(
      'unverified',
    );
    expect(pluginIdentityLabel({ identity: 'octocat', identityVerified: true })).toBe('verified');
    expect(pluginIdentityLabel({ identity: null, identityVerified: true })).toBe('unverified');
  });
});
