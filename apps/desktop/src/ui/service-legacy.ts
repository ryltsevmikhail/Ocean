import { isLocalServiceConnectionSetRequest } from '@runnets/contracts';
import type { PluginConnectionView } from '../plugin-protocol.js';
/** Archive identity/generation is a deterministic proposal, never credential continuity. */
export async function legacyServiceProposal(row: PluginConnectionView) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([row.id, row.generation, row.endpoint])),
  );
  const suffix = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  const input = {
    requestId: 'prefill',
    connectionId: 'legacy-' + suffix,
    expectedVersions: null,
    name: row.name,
    configuration: { kind: 'http' as const, url: row.endpoint },
    metadataPermission: 'none' as const,
  };
  return isLocalServiceConnectionSetRequest(input) ? input : null;
}
