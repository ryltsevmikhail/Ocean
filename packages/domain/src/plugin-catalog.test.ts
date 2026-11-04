import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GITHUB_PLUGIN_ID,
  PLUGIN_CATALOG_SCHEMA_VERSION,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  PLUGIN_OPERATIONS,
  PLUGIN_POLICY_VERSION,
  SHIPPED_PLUGIN_CATALOG,
  canonicalJson,
  compatiblePluginAdapter,
  pluginManifestDigest,
  pluginManifestOperation,
  pluginToolRepository,
  validCredentialReference,
  validPluginEndpoint,
  validPluginRepository,
} from './plugin-catalog.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('canonical plugin JSON', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: [{ z: true, y: null }] })).toBe(
      '{"a":[{"y":null,"z":true}],"b":1}',
    );
  });
  it('rejects values that are not JSON', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
  });
});

describe('shipped GitHub catalog card', () => {
  it('ships exactly one frozen read-only GitHub entry', () => {
    expect(SHIPPED_PLUGIN_CATALOG.schemaVersion).toBe(PLUGIN_CATALOG_SCHEMA_VERSION);
    expect(SHIPPED_PLUGIN_CATALOG.entries).toHaveLength(1);
    const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
    expect(entry.pluginId).toBe(GITHUB_PLUGIN_ID);
    expect(entry.publisher).toBe('github');
    expect(entry.manifest.schemaVersion).toBe(PLUGIN_MANIFEST_SCHEMA_VERSION);
    expect(entry.manifest.pluginId).toBe(GITHUB_PLUGIN_ID);
    expect(entry.manifest.publisher).toBe('github');
    expect(entry.manifest.version).toBe(entry.version);
    expect(entry.manifest.operations).toEqual(PLUGIN_OPERATIONS);
    expect(entry.manifest.readOnly).toBe(true);
    expect(entry.manifest.resourceConstraint).toBe('repository');
    expect(entry.manifest.authentication).toBe('environment-reference');
    expect(entry.manifest.transport).toBe('mcp-streamable-http');
    expect(entry.manifest.endpoint).toBe('https://api.githubcopilot.com/mcp/');
    expect(PLUGIN_POLICY_VERSION).toBe(1);
  });

  it('pins the SHA-256 digest over the canonical manifest bytes', () => {
    const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
    expect(entry.manifestDigest).toBe(sha256(canonicalJson(entry.manifest)));
    expect(entry.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(pluginManifestDigest(entry.manifest, sha256)).toBe(entry.manifestDigest);
    // Any byte change in the declarative card changes the digest.
    const changed = { ...entry.manifest, operations: [entry.manifest.operations[0]!] };
    expect(pluginManifestDigest(changed, sha256)).not.toBe(entry.manifestDigest);
  });

  it('declares only exact read operations with an exact wire tool name', () => {
    const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
    expect(entry.manifest.operations.map((operation) => operation.tool).sort()).toEqual([
      'issue_read',
      'list_issues',
    ]);
    expect(
      entry.manifest.operations.every((operation) => operation.operation.startsWith('read_')),
    ).toBe(true);
    expect(pluginManifestOperation(entry.manifest, 'list_issues')?.tool).toBe('list_issues');
    expect(pluginManifestOperation(entry.manifest, 'create_issue')).toBeNull();
  });
});

describe('adapter compatibility', () => {
  const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
  it('accepts only the pinned adapter protocol and SDK identity', () => {
    expect(
      compatiblePluginAdapter(entry.adapter, {
        adapter: 'runnets-executor',
        protocolVersion: 1,
        sdkVersion: '1.6.11',
        manifestSchemaVersion: 1,
      }),
    ).toBe(true);
    expect(
      compatiblePluginAdapter(entry.adapter, {
        adapter: 'runnets-executor',
        protocolVersion: 2,
        sdkVersion: '1.6.11',
        manifestSchemaVersion: 1,
      }),
    ).toBe(false);
    expect(
      compatiblePluginAdapter(entry.adapter, {
        adapter: 'runnets-executor',
        protocolVersion: 1,
        sdkVersion: '1.6.10',
        manifestSchemaVersion: 1,
      }),
    ).toBe(false);
    expect(
      compatiblePluginAdapter(entry.adapter, {
        adapter: 'other',
        protocolVersion: 1,
        sdkVersion: '1.6.11',
        manifestSchemaVersion: 1,
      }),
    ).toBe(false);
  });
});

describe('plugin boundary validators', () => {
  it('requires a credential-free HTTPS endpoint', () => {
    expect(validPluginEndpoint('https://api.githubcopilot.com/mcp/')).toBe(true);
    expect(validPluginEndpoint('http://api.githubcopilot.com/mcp/')).toBe(false);
    expect(validPluginEndpoint('https://user:pw@api.githubcopilot.com/mcp/')).toBe(false);
    expect(validPluginEndpoint('https://api.githubcopilot.com/mcp/?a=1')).toBe(false);
    expect(validPluginEndpoint('https://api.githubcopilot.com/mcp/#x')).toBe(false);
    expect(validPluginEndpoint('not a url')).toBe(false);
  });
  it('accepts only environment variable names as credential references', () => {
    expect(validCredentialReference('OCEAN_GITHUB_WORK_TOKEN')).toBe(true);
    expect(validCredentialReference('_PRIVATE')).toBe(true);
    expect(validCredentialReference('github token')).toBe(false);
    expect(validCredentialReference('ghp_canaryTokenValue')).toBe(false);
    expect(validCredentialReference('1ABC')).toBe(false);
    expect(validCredentialReference('')).toBe(false);
  });
  it('requires exactly owner/name as the resource constraint', () => {
    expect(validPluginRepository('team/api')).toBe(true);
    expect(validPluginRepository('team/api/extra')).toBe(false);
    expect(validPluginRepository('team')).toBe(false);
    expect(validPluginRepository('/api')).toBe(false);
    expect(validPluginRepository('team/')).toBe(false);
  });
  it('extracts the repository from exact read-tool arguments', () => {
    expect(pluginToolRepository('list_issues', { owner: 'team', repo: 'api' })).toBe('team/api');
    expect(
      pluginToolRepository('issue_read', { owner: 'team', repo: 'api', issue_number: 1 }),
    ).toBe('team/api');
    expect(pluginToolRepository('list_issues', { owner: 'team' })).toBeNull();
    expect(pluginToolRepository('list_issues', { owner: 'team', repo: 'api/other' })).toBeNull();
    expect(pluginToolRepository('create_issue', { owner: 'team', repo: 'api' })).toBeNull();
  });
});
