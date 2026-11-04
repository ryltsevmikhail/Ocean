/**
 * Public transport: plain types only.
 *
 * This module (and therefore the package entry point's declaration graph) is
 * deliberately free of Effect/SDK types: it delegates to an internal
 * `ExecutorTransportBackend` created by `admission.ts`. Execution is disabled
 * by default; `open()` verifies the pinned installed chunk on every admission
 * and refuses unless the caller explicitly enabled execution.
 */
import { ServicePluginDiscoveryRefusedError } from '@runnets/application';
import type {
  ServicePluginCatalog,
  ServicePluginDiscoveryOptions,
  ServicePluginInvokeOptions,
  ServicePluginInvokeOutcome,
  ServicePluginInvocation,
  ServicePluginTarget,
  ServicePluginTransportPort,
  ServicePluginTransportQualification,
} from '@runnets/application';

import { admit } from './admission.js';
import type { ExecutorTransportBackend } from './backend.js';
import { freezeStatus } from './status.js';
import type { ExecutorTransportOpenOptions, ExecutorTransportStatus } from './status.js';

export { ExecutorTransportOpenError } from './status.js';
export type {
  ExecutorTransportOpenOptions,
  ExecutorTransportQualificationReason,
  ExecutorTransportStatus,
} from './status.js';

/**
 * Runtime-only token for the internal constructor: the class can only be
 * instantiated through `createInternalTransport` below, which is not reachable
 * from the package entry point. A caller cannot obtain this symbol, so no
 * forged `ExecutorTransportStatus` can be turned into an instance.
 */
const INTERNAL_CONSTRUCTION_TOKEN: unique symbol = Symbol('executor-transport.internal');

/** Internal factory for in-package tests / the future host layer (not exported from the entry point). */
export function createInternalTransport(
  backend: ExecutorTransportBackend,
  status: ExecutorTransportStatus,
): ExecutorServicePluginTransport {
  return new ExecutorServicePluginTransport(backend, status, INTERNAL_CONSTRUCTION_TOKEN);
}

function refusalCode(
  status: ExecutorTransportStatus,
): 'execution_disabled' | 'transport_unqualified' {
  return status.reason === 'execution_not_enabled' ? 'execution_disabled' : 'transport_unqualified';
}

function refusalDetail(status: ExecutorTransportStatus): string {
  return `Executor transport is not qualified: ${status.reason ?? 'unqualified'}`;
}

export class ExecutorServicePluginTransport implements ServicePluginTransportPort {
  readonly #backend: ExecutorTransportBackend;
  readonly #status: ExecutorTransportStatus;
  #closed = false;

  /**
   * Not part of the public contract: the third argument is a module-private
   * token that only `createInternalTransport`/`open` can supply at runtime.
   */
  constructor(
    backend: ExecutorTransportBackend,
    status: ExecutorTransportStatus,
    token: typeof INTERNAL_CONSTRUCTION_TOKEN,
  ) {
    if (token !== INTERNAL_CONSTRUCTION_TOKEN) {
      throw new Error('Executor transport instances are created through its factories only');
    }
    this.#backend = backend;
    this.#status = freezeStatus(status);
  }

  /** Public factory. Execution stays disabled unless explicitly enabled. */
  static async open(
    options: ExecutorTransportOpenOptions,
  ): Promise<ExecutorServicePluginTransport> {
    const admission = await admit(options);
    return new ExecutorServicePluginTransport(
      admission.backend,
      admission.status,
      INTERNAL_CONSTRUCTION_TOKEN,
    );
  }

  /** Qualification plus the observed installed-chunk digest (frozen). */
  status(): ExecutorTransportStatus {
    return this.#status;
  }

  qualification(): ServicePluginTransportQualification {
    return this.#status;
  }

  async discover(
    target: ServicePluginTarget,
    options: ServicePluginDiscoveryOptions = {},
  ): Promise<ServicePluginCatalog> {
    this.assertOpen();
    if (!this.#status.qualified) {
      throw new ServicePluginDiscoveryRefusedError(
        refusalCode(this.#status),
        refusalDetail(this.#status),
      );
    }
    return this.#backend.discover(target, options);
  }

  async invoke(
    target: ServicePluginTarget,
    invocation: ServicePluginInvocation,
    options: ServicePluginInvokeOptions = {},
  ): Promise<ServicePluginInvokeOutcome> {
    this.assertOpen();
    if (!this.#status.qualified) {
      return {
        kind: 'not_started',
        invocationId: invocation.invocationId,
        code: refusalCode(this.#status),
        detail: refusalDetail(this.#status),
      };
    }
    return this.#backend.invoke(target, invocation, options);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#backend.close();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error('Executor transport is closed');
  }
}
