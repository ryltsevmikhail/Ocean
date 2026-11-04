/**
 * Public, execution-disabled setup seam over the pinned Executor plugins.
 *
 * Task 5 ships the catalog/connection model but never enables execution. Task 6
 * needs a deliberate way to install the frozen declarative integration card and
 * create an owner-named connection with an environment-reference credential.
 * This class is that seam:
 *
 * - `open()` re-verifies the installed patched SDK chunk against the pinned
 *   digest; a pristine/mismatched bundle is refused before any host exists.
 * - its options accept no qualification identity and no execution flag; unknown
 *   option keys (including `enableExecution`) are refused as `invalid_options`;
 * - it returns a distinct class whose constructor requires a module-private
 *   token, so product code cannot mint one from a forged status;
 * - it only installs a declarative remote-MCP descriptor and stores the
 *   credential value inside the SDK host; it exposes no discovery/invoke path,
 *   and `status.execution` is the literal `'disabled'`.
 *
 * Plain types only: no Executor/Effect type appears in this module's surface.
 */
import { normalizeAllowedOrigins } from './origins.js';
import {
  PINNED_IDENTITIES,
  PINNED_SDK_CHUNK_SHA256,
  verifyInstalledSdkChunk,
} from './pinned-identity.js';
import { createExecutorHost } from './sdk-boundary.js';
import { createSetupCredentialProvider } from './setup-provider.js';
import type {
  ExecutorConnectionSetup,
  ExecutorIntegrationInstall,
  ExecutorPluginSetupOptions,
  ExecutorPluginSetupStatus,
} from './setup-types.js';
export type {
  ExecutorConnectionSetup,
  ExecutorIntegrationInstall,
  ExecutorPluginSetupOptions,
  ExecutorPluginSetupStatus,
} from './setup-types.js';
import { ExecutorSetupError } from './setup-error.js';
import {
  bounded,
  exactKeys,
  httpsEndpoint,
  invalidInput,
  invalidOptions,
  safeFailure,
  SETUP_CREDENTIAL_REFERENCE,
  SETUP_ID,
  SETUP_SLUG,
} from './setup-input.js';
export { ExecutorSetupError } from './setup-error.js';
export type { ExecutorSetupFailureCode } from './setup-error.js';
const SETUP_CONSTRUCTION_TOKEN: unique symbol = Symbol('executor-plugin-setup.internal');

/**
 * Plain, internal host facade. The concrete SDK host is structurally compatible;
 * keeping this local interface means no Executor/Effect type can appear in this
 * module's public declaration graph.
 */
interface SetupHost {
  installMcp(input: {
    readonly name: string;
    readonly description: string;
    readonly endpoint: string;
    readonly remoteTransport: 'streamable-http';
    readonly authTemplates: readonly unknown[];
  }): Promise<string>;
  createConnection(input: {
    readonly integrationId: string;
    readonly connectionId: string;
    readonly owner: 'user' | 'org';
    readonly template: string;
    readonly value: string;
  }): Promise<void>;
  close(): Promise<void>;
}
const freeze = (value: Readonly<Record<string, string>>) => Object.freeze({ ...value });
export class ExecutorPluginSetup {
  readonly #host: SetupHost;
  readonly #allowedOrigins: readonly string[];
  readonly #resolveCredential: ((reference: string) => string | null) | null;
  readonly #templates = new Map<string, ReadonlySet<string>>();
  readonly #slugs = new Map<string, string>();
  readonly #status: ExecutorPluginSetupStatus;
  #closed = false;

  /**
   * Not part of the public product contract: a private constructor keeps the
   * internal `ExecutorHost`/Effect types out of the declaration graph, and the
   * module-private token means product code cannot mint an instance from a
   * forged status. Only `open()` constructs this class.
   */
  private constructor(
    host: SetupHost,
    status: ExecutorPluginSetupStatus,
    allowedOrigins: readonly string[],
    resolveCredential: ((reference: string) => string | null) | null,
    token: typeof SETUP_CONSTRUCTION_TOKEN,
  ) {
    if (token !== SETUP_CONSTRUCTION_TOKEN)
      throw new Error('Executor plugin setup instances are created through open() only');
    this.#host = host;
    this.#status = Object.freeze({ execution: 'disabled', pinned: freeze(status.pinned) });
    this.#allowedOrigins = allowedOrigins;
    this.#resolveCredential = resolveCredential;
  }

  /**
   * Verify the pinned patched bundle, then create a setup-only SDK host.
   * Execution is never requested here, and an unknown option key refuses.
   */
  static async open(options: ExecutorPluginSetupOptions): Promise<ExecutorPluginSetup> {
    if (typeof options !== 'object' || options === null || Array.isArray(options))
      invalidOptions('options must be an object');
    const allowedKeys = ['tenantId', 'subjectId', 'allowedOrigins', 'resolveCredential'];
    const names = Object.keys(options);
    if (names.some((name) => !allowedKeys.includes(name)))
      invalidOptions('unknown option (qualification identity/execution flags are not accepted)');
    let tenantId: string, subjectId: string;
    try {
      tenantId = bounded(options.tenantId, 128, 'tenantId');
      subjectId = bounded(options.subjectId, 128, 'subjectId');
    } catch {
      return invalidOptions('tenantId and subjectId must be bounded non-empty strings');
    }
    let allowedOrigins: readonly string[];
    try {
      allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
    } catch {
      return invalidOptions('allowedOrigins is invalid');
    }
    if (options.resolveCredential !== undefined && typeof options.resolveCredential !== 'function')
      invalidOptions('resolveCredential must be a function');
    const identity = await verifyInstalledSdkChunk();
    if (
      !identity.ok ||
      identity.expectedSha256 !== PINNED_SDK_CHUNK_SHA256 ||
      identity.actualSha256 !== PINNED_SDK_CHUNK_SHA256
    ) {
      throw new ExecutorSetupError(
        'pinned_chunk_mismatch',
        'installed Executor SDK chunk does not match the pinned patched digest',
      );
    }
    let host: SetupHost;
    try {
      host = await createExecutorHost({
        tenantId,
        subjectId,
        allowedOrigins,
        providers: [createSetupCredentialProvider()],
      });
    } catch {
      throw new ExecutorSetupError('setup_failed', 'Executor setup host could not be created');
    }
    return new ExecutorPluginSetup(
      host,
      { execution: 'disabled', pinned: PINNED_IDENTITIES },
      allowedOrigins,
      options.resolveCredential ?? null,
      SETUP_CONSTRUCTION_TOKEN,
    );
  }

  get status(): ExecutorPluginSetupStatus {
    return this.#status;
  }

  /** Install one declarative remote-MCP integration; no network request is made. */
  async installIntegration(
    input: ExecutorIntegrationInstall,
  ): Promise<{ readonly integrationId: string; readonly slug: string }> {
    this.#assertOpen();
    exactKeys(
      input,
      ['integrationId', 'name', 'description', 'endpoint', 'authTemplates'],
      'input',
    );
    const integrationId = bounded(input.integrationId, 64, 'integrationId');
    if (!SETUP_ID.test(integrationId))
      return invalidInput('integrationId must be a lowercase slug');
    if (this.#slugs.has(integrationId))
      throw new ExecutorSetupError('invalid_input', 'integration is already installed');
    const endpoint = httpsEndpoint(input.endpoint, this.#allowedOrigins);
    if (!Array.isArray(input.authTemplates) || input.authTemplates.length > 8)
      return invalidInput('authTemplates is invalid');
    const templates = new Set<string>();
    for (const template of input.authTemplates) {
      const value = template as unknown as Record<string, unknown>;
      exactKeys(
        value,
        value['headers'] === undefined ? ['slug', 'type'] : ['slug', 'type', 'headers'],
        'auth template',
      );
      const slug = bounded(value['slug'], 64, 'auth template slug');
      if (!SETUP_SLUG.test(slug) || templates.has(slug))
        return invalidInput('auth template slug is invalid or duplicated');
      bounded(value['type'], 64, 'auth template type');
      templates.add(slug);
    }
    if (templates.size === 0) return invalidInput('at least one auth template is required');
    const mcInput: Parameters<SetupHost['installMcp']>[0] = {
      name: bounded(input.name, 128, 'name'),
      description: bounded(input.description, 4096, 'description'),
      endpoint,
      remoteTransport: 'streamable-http',
      authTemplates: input.authTemplates,
    };
    let slug: string;
    try {
      slug = await this.#host.installMcp(mcInput);
    } catch (error) {
      throw new ExecutorSetupError(
        'setup_failed',
        'integration could not be installed: ' + safeFailure(error),
      );
    }
    this.#templates.set(integrationId, templates);
    this.#slugs.set(integrationId, slug);
    return { integrationId, slug };
  }

  /**
   * Create one named connection using an environment-reference credential.
   * The reference must exist; the value never appears in an error or result.
   *
   * TASK 6 ORDERING OBLIGATION: `connections.create` performs one upstream MCP
   * connect/tool-sync with the resolved credential. Task 6 must not call this
   * before the owner's single-use metadata-discovery consent (or must explicitly
   * treat this request as the consented discovery pass and count/attribute it);
   * `installIntegration` itself is network-free.
   */
  async createConnection(
    input: ExecutorConnectionSetup,
  ): Promise<{ readonly connectionId: string }> {
    this.#assertOpen();
    exactKeys(
      input,
      ['integrationId', 'connectionId', 'owner', 'template', 'credentialReference'],
      'input',
    );
    const integrationId = bounded(input.integrationId, 64, 'integrationId');
    const connectionId = bounded(input.connectionId, 64, 'connectionId');
    if (!SETUP_SLUG.test(connectionId))
      return invalidInput('connectionId must be an SDK-safe slug');
    if (input.owner !== 'user' && input.owner !== 'org') return invalidInput('owner is invalid');
    const template = bounded(input.template, 64, 'template');
    if (
      typeof input.credentialReference !== 'string' ||
      !SETUP_CREDENTIAL_REFERENCE.test(input.credentialReference)
    )
      return invalidInput('credentialReference must be an environment variable NAME');
    const templates = this.#templates.get(integrationId);
    const slug = this.#slugs.get(integrationId);
    if (templates === undefined || slug === undefined)
      return invalidInput('integration is not installed in this setup');
    if (!templates.has(template)) return invalidInput('auth template is not declared');
    if (this.#resolveCredential === null)
      throw new ExecutorSetupError(
        'credential_unavailable',
        'no environment-reference resolver is configured',
      );
    const value = this.#resolveCredential(input.credentialReference);
    if (value === null || value.trim() === '' || value.length > 4096)
      throw new ExecutorSetupError(
        'credential_unavailable',
        'credential reference ' + input.credentialReference + ' is not available',
      );
    try {
      await this.#host.createConnection({
        integrationId: slug,
        connectionId,
        owner: input.owner,
        template,
        value,
      });
    } catch (error) {
      throw new ExecutorSetupError(
        'setup_failed',
        'connection could not be created: ' + safeFailure(error),
      );
    }
    return { connectionId };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // The setup host is in-memory only; nothing is dispatched or retried.
    await this.#host.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new ExecutorSetupError('setup_closed', 'setup is closed');
  }
}
/** Exported for Task 6 composition: the exact pinned identities behind the seam. */
export { PINNED_IDENTITIES };
