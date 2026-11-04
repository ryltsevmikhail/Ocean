/**
 * Plain public setup-seam types: no Executor/Effect type appears here.
 */

export interface ExecutorPluginSetupOptions {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly allowedOrigins: readonly string[];
  /**
   * Host-supplied environment-reference resolver. It returns the credential
   * value for one environment variable NAME, or null when absent. The value is
   * used only inside the SDK host and never appears in a returned/error value.
   */
  readonly resolveCredential?: (reference: string) => string | null;
}

export interface ExecutorIntegrationInstall {
  /** Catalog plugin id; also the deterministic integration slug Ocean addresses. */
  readonly integrationId: string;
  readonly name: string;
  readonly description: string;
  /** Exact HTTPS MCP endpoint. It must belong to the configured origin allowlist. */
  readonly endpoint: string;
  readonly authTemplates: readonly {
    readonly slug: string;
    readonly type: string;
    readonly headers?: Readonly<Record<string, readonly unknown[]>>;
  }[];
}

export interface ExecutorConnectionSetup {
  readonly integrationId: string;
  readonly connectionId: string;
  readonly owner: 'user' | 'org';
  readonly template: string;
  /** Environment variable NAME only; the value is resolved host-side. */
  readonly credentialReference: string;
}

export interface ExecutorPluginSetupStatus {
  /** Literal: this seam can never turn execution on. */
  readonly execution: 'disabled';
  readonly pinned: Readonly<Record<string, string>>;
}
