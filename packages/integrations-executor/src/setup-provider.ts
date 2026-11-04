/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
   --
   Same pinned-SDK declaration limitation as `sdk-boundary.ts`: SDK values are
   untyped here, so only the plain provider object is returned. */
/**
 * Session-scoped writable credential provider for the execution-disabled setup
 * seam. Values live only in this host's memory; no value crosses a plain Ocean
 * type. Task 6 must thread the same host-side resolution into its transport host.
 */
import { Effect } from 'effect';
import * as sdk from '@executor-js/sdk/core';

export function createSetupCredentialProvider(): unknown {
  const store = new Map<string, string>();
  return {
    key: sdk.ProviderKey.make('ocean-plugin-setup'),
    writable: true,
    get: (id: unknown) => Effect.sync(() => store.get(String(id)) ?? null),
    set: (id: unknown, value: unknown) =>
      Effect.sync(() => void store.set(String(id), String(value))),
    delete: (id: unknown) => Effect.sync(() => void store.delete(String(id))),
  };
}
