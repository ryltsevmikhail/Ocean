import { describe, expect, it } from 'vitest';
import {
  PLUGIN_MAX_GRANT_TOOLS,
  PLUGIN_POLICY_VERSION,
  validPluginGrantScope,
  type PluginGrantScope,
} from './plugin-grant.js';

const digest = 'b'.repeat(64);
const scope = (overrides: Partial<PluginGrantScope> = {}): PluginGrantScope => ({
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId: 'conn_work',
  connectionGeneration: 1,
  tools: ['list_issues', 'issue_read'],
  repository: 'team/api',
  schemaDigest: digest,
  policyVersion: PLUGIN_POLICY_VERSION,
  ...overrides,
});

describe('exact plugin grant scope', () => {
  it('accepts an exact read-only scope', () => {
    expect(validPluginGrantScope(scope())).toBe(true);
    expect(validPluginGrantScope(scope({ tools: ['list_issues'] }))).toBe(true);
  });
  it('requires every authority-bearing field to be present and valid', () => {
    expect(validPluginGrantScope(scope({ workspaceId: '' }))).toBe(false);
    expect(validPluginGrantScope(scope({ roomId: '' }))).toBe(false);
    expect(validPluginGrantScope(scope({ botId: '' }))).toBe(false);
    expect(validPluginGrantScope(scope({ pluginId: 'github ' }))).toBe(false);
    expect(validPluginGrantScope(scope({ connectionId: '' }))).toBe(false);
    expect(validPluginGrantScope(scope({ connectionGeneration: 0 }))).toBe(false);
    expect(validPluginGrantScope(scope({ connectionGeneration: 1.5 }))).toBe(false);
    expect(validPluginGrantScope(scope({ tools: [] }))).toBe(false);
    expect(
      validPluginGrantScope(
        scope({ tools: Array.from({ length: PLUGIN_MAX_GRANT_TOOLS + 1 }, (_, i) => 't' + i) }),
      ),
    ).toBe(false);
    expect(validPluginGrantScope(scope({ tools: ['list_issues', 'list_issues'] }))).toBe(false);
    expect(validPluginGrantScope(scope({ tools: ['create_issue'] }))).toBe(false);
    expect(validPluginGrantScope(scope({ repository: 'team' }))).toBe(false);
    expect(validPluginGrantScope(scope({ schemaDigest: 'B'.repeat(64) }))).toBe(false);
    expect(validPluginGrantScope(scope({ policyVersion: 0 }))).toBe(false);
  });
});
