/**
 * Shipped service-plugin catalog and its declarative manifest contract.
 *
 * The catalog is a frozen, typed constant: Ocean installs exactly the pinned
 * GitHub read-issues card without touching GitHub. The manifest is canonical
 * JSON whose SHA-256 digest is verified before any private copy is published.
 * Nothing here performs I/O or imports a transport SDK.
 */

export const PLUGIN_CATALOG_SCHEMA_VERSION = 1;
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
export const PLUGIN_POLICY_VERSION = 1;
export const PLUGIN_MAX_GRANT_TOOLS = 16;

/** The only transport RC2 ships: a remote MCP server over Streamable HTTP. */
export type PluginTransportKind = 'mcp-streamable-http';

/** One exact, read-only operation the owner may grant. */
export interface PluginOperation {
  /** Exact upstream wire tool name; grants bind this name verbatim. */
  readonly tool: string;
  /** Stable Ocean operation id, never inferred from a server description. */
  readonly operation: string;
  readonly title: string;
}

/** Declarative manifest: requirements and allowed reads, never a secret or command. */
export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly pluginId: string;
  readonly publisher: string;
  readonly name: string;
  readonly version: string;
  readonly transport: PluginTransportKind;
  /** Exact HTTPS endpoint; credentials, query strings and fragments are refused. */
  readonly endpoint: string;
  readonly authentication: 'environment-reference';
  readonly resourceConstraint: 'repository';
  readonly readOnly: true;
  readonly operations: readonly PluginOperation[];
}

/** Pinned adapter identity a version was published against. */
export interface PluginAdapterCompatibility {
  readonly adapter: 'runnets-executor';
  readonly protocolVersion: 1;
  readonly sdkVersion: string;
  readonly manifestSchemaVersion: 1;
}

/** Adapter identity the running host actually provides. */
export interface PluginAdapterIdentity {
  readonly adapter: string;
  readonly protocolVersion: number;
  readonly sdkVersion: string;
  readonly manifestSchemaVersion: number;
}

export interface PluginCatalogEntry {
  readonly pluginId: string;
  readonly publisher: string;
  /** Ocean card revision, pinned; it is not a claim about the upstream server version. */
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly manifest: PluginManifest;
  /** SHA-256 over the canonical manifest bytes. */
  readonly manifestDigest: string;
  readonly adapter: PluginAdapterCompatibility;
}

export interface PluginCatalog {
  readonly schemaVersion: 1;
  readonly entries: readonly PluginCatalogEntry[];
}

export type Sha256Hex = (text: string) => string;

/** Deterministic JSON: object keys sorted recursively, arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('canonical JSON requires plain objects');
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return (
      '{' +
      keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') +
      '}'
    );
  }
  throw new TypeError('canonical JSON cannot encode ' + typeof value);
}

/** Digest of the declarative card; the private copy must hash to exactly this. */
export function pluginManifestDigest(manifest: PluginManifest, sha256: Sha256Hex): string {
  return sha256(canonicalJson(manifest));
}

export const GITHUB_PLUGIN_ID = 'github';

/** The RC2 pilot: read issues and issue comments in exactly one repository. */
export const PLUGIN_OPERATIONS: readonly PluginOperation[] = Object.freeze([
  Object.freeze({
    tool: 'list_issues',
    operation: 'read_issues',
    title: 'List issues in one repository',
  }),
  Object.freeze({
    tool: 'issue_read',
    operation: 'read_issue',
    title: 'Read one issue and its comments',
  }),
]);

const GITHUB_MANIFEST: PluginManifest = Object.freeze({
  schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
  pluginId: GITHUB_PLUGIN_ID,
  publisher: 'github',
  name: 'GitHub issues (read-only)',
  version: '1.0.0',
  transport: 'mcp-streamable-http',
  endpoint: 'https://api.githubcopilot.com/mcp/',
  authentication: 'environment-reference',
  resourceConstraint: 'repository',
  readOnly: true,
  operations: PLUGIN_OPERATIONS,
});

/** Frozen card revision; the live GitHub schema is qualified in Task 6, not here. */
const GITHUB_MANIFEST_DIGEST = 'c6308e88e2ab74a82b2232158f0ba5ae33338a6fa1898391503bccf87f0c46f6';

export const SHIPPED_PLUGIN_CATALOG: PluginCatalog = Object.freeze({
  schemaVersion: PLUGIN_CATALOG_SCHEMA_VERSION,
  entries: Object.freeze([
    Object.freeze({
      pluginId: GITHUB_PLUGIN_ID,
      publisher: 'github',
      version: '1.0.0',
      title: 'GitHub issues (read-only)',
      description:
        'Official GitHub remote MCP server declared for read-only issue access in one ' +
        'repository. This is a frozen declarative card, not a live server qualification.',
      manifest: GITHUB_MANIFEST,
      manifestDigest: GITHUB_MANIFEST_DIGEST,
      adapter: Object.freeze({
        adapter: 'runnets-executor',
        protocolVersion: 1,
        sdkVersion: '1.6.11',
        manifestSchemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
      }),
    }),
  ]),
});

export function pluginServiceAdapter(
  expected: PluginAdapterCompatibility,
  provided: PluginAdapterIdentity,
): boolean {
  return (
    expected.adapter === provided.adapter &&
    expected.protocolVersion === provided.protocolVersion &&
    expected.sdkVersion === provided.sdkVersion &&
    expected.manifestSchemaVersion === provided.manifestSchemaVersion
  );
}

/** Alias kept readable at call sites; both names mean the same pinned comparison. */
export const compatiblePluginAdapter = pluginServiceAdapter;

export function pluginManifestOperation(
  manifest: PluginManifest,
  tool: string,
): PluginOperation | null {
  return manifest.operations.find((operation) => operation.tool === tool) ?? null;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9._-]{1,100}$/;
const CREDENTIAL_REFERENCE = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function validPluginId(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_ID.test(value);
}

/** Exactly `owner/name`, one slash, no traversal, no whitespace. */
export function validPluginRepository(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY.test(value);
}

/** An environment variable NAME. A credential value can never match this grammar. */
export function validCredentialReference(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_REFERENCE.test(value);
}

/** HTTPS, no credentials, no query, no fragment; the endpoint is not a template. */
export function validPluginEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.hostname.length > 0
  );
}

/**
 * Repository a read tool is constrained to, derived from the exact wire
 * arguments only. Unknown tools and malformed resources return null.
 */
export function pluginToolRepository(tool: string, argumentsValue: unknown): string | null {
  if (!PLUGIN_OPERATIONS.some((operation) => operation.tool === tool)) return null;
  if (argumentsValue === null || typeof argumentsValue !== 'object') return null;
  const record = argumentsValue as Readonly<Record<string, unknown>>;
  const owner = record['owner'];
  const repo = record['repo'];
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  const repository = owner + '/' + repo;
  return validPluginRepository(repository) ? repository : null;
}
