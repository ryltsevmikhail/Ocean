/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return --
   Same pinned-SDK declaration limitation as `sdk-boundary.ts`: the @executor-js
   type graph collapses to `any` under NodeNext + skipLibCheck. Accessors here
   only construct SDK tokens and validate handles at runtime. */
/**
 * SDK boundary accessors shared by the host implementation and the SDK-free
 * setup seam. Kept in its own module so `sdk-boundary.ts` stays within the
 * source-size limit and the setup module imports only plain accessor types.
 */
import * as sdk from '@executor-js/sdk/core';

import { HostOperationError } from './host-types.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export interface ExtensionHandle {
  readonly register?: (input: unknown) => unknown;
  readonly addSpec?: (input: unknown) => unknown;
  readonly addServer?: (input: unknown) => unknown;
}

/** Shared accessors handed to the (SDK-free) setup module. */
export interface BoundaryAccess {
  readonly executor: unknown;
  run(effect: unknown, what: string): Promise<unknown>;
  extension(pluginId: string): ExtensionHandle;
  integrationSlug(value: string): unknown;
  connectionName(value: string): unknown;
  authTemplateSlug(value: string): unknown;
  oauthClientSlug(value: string): unknown;
  /**
   * Test-only browser stand-in for the OAuth authorization redirect (product
   * code never sets it; RC2 uses static secrets). `null` makes the setup seam
   * refuse rather than silently using global fetch.
   */
  readonly oauthSetupFetch: typeof fetch | null;
}

export function createAccess(
  executor: unknown,
  run: BoundaryAccess['run'],
  oauthSetupFetch: typeof fetch | null,
): BoundaryAccess {
  return {
    executor,
    run,
    oauthSetupFetch,
    extension(pluginId) {
      const handle = asRecord(executor)[pluginId];
      if (typeof handle === 'object' && handle !== null) return handle;
      throw new HostOperationError(
        'invalid',
        'missing_plugin',
        `plugin extension "${pluginId}" is unavailable`,
      );
    },
    integrationSlug: (value) => sdk.IntegrationSlug.make(value),
    connectionName: (value) => sdk.ConnectionName.make(value),
    authTemplateSlug: (value) => sdk.AuthTemplateSlug.make(value),
    oauthClientSlug: (value) => sdk.OAuthClientSlug.make(value),
  };
}
