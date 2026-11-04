/**
 * Plain provision types shared by the transport open options and the entry
 * point. Deliberately free of any Executor/Effect type so the public
 * declaration graph stays plain.
 */

import type { ServicePluginTarget } from '@runnets/application';

export interface ExecutorProvisionAuthTemplate {
  readonly slug: string;
  readonly type: string;
  readonly headers?: Readonly<Record<string, readonly unknown[]>>;
}

export interface ExecutorProvisionConnection {
  /** Auth template slug declared by the integration. */
  readonly template: string;
  /** Environment variable NAME only; the value is resolved host-side. */
  readonly credentialReference: string;
}

export interface ExecutorMcpProvision {
  readonly kind: 'mcp';
  /** Must equal the addressed target's integration id. */
  readonly integrationId: string;
  readonly description: string;
  readonly endpoint: string;
  /** Explicit supported protocol policy; absent retains SDK negotiation. */
  readonly versionNegotiation?: 'legacy';
  readonly authTemplates: readonly ExecutorProvisionAuthTemplate[];
  readonly connection: ExecutorProvisionConnection;
}

export interface ExecutorOpenApiProvision {
  readonly kind: 'openapi';
  readonly integrationId: string;
  readonly name: string;
  readonly description: string;
  /** Inline OpenAPI document (already serialized JSON). */
  readonly specJson: string;
  readonly authTemplates: readonly ExecutorProvisionAuthTemplate[];
  readonly connection: ExecutorProvisionConnection;
}

export type ExecutorProvision = ExecutorMcpProvision | ExecutorOpenApiProvision;

/**
 * Resolve the declarative descriptor for one addressed target, or null when
 * Ocean has no connection to provision (the discovery is refused with zero
 * network).
 */
export type ExecutorConnectionProvisioner = (
  target: ServicePluginTarget,
) => ExecutorProvision | null | Promise<ExecutorProvision | null>;

export interface ProvisioningOptions {
  readonly allowedOrigins: readonly string[];
  readonly resolveCredential: (reference: string) => string | null;
  readonly provision: ExecutorConnectionProvisioner;
}
