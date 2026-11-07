import { createHash } from 'node:crypto';
import {
  canonicalJson,
  validServiceJson,
  validServiceCatalogSnapshot,
  SERVICE_PLUGIN_MAX_DISCOVERY_BYTES,
  SERVICE_PLUGIN_MAX_TOOLS,
  type ServiceConnection,
} from '@runnets/domain';
import type { Client, Tool } from '@modelcontextprotocol/client';
import type { McpCatalogCandidate } from './contracts.js';
import { immutable } from './profile.js';

export function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const field of Object.values(value)) freezeJson(field);
    Object.freeze(value);
  }
  return value;
}
export async function listCatalog(
  client: Client,
  c: ServiceConnection,
  signal: AbortSignal,
  timeout: number,
) {
  if (!client.getServerCapabilities()?.tools) throw Error('tools capability required');
  const page = await client.listTools(undefined, { cacheMode: 'refresh', signal, timeout });
  if (
    page.nextCursor !== undefined ||
    !Array.isArray(page.tools) ||
    page.tools.length > SERVICE_PLUGIN_MAX_TOOLS ||
    Buffer.byteLength(JSON.stringify(page.tools)) > SERVICE_PLUGIN_MAX_DISCOVERY_BYTES
  )
    throw Error('incomplete catalog');
  const full = new Map<string, Tool>();
  const tools = page.tools.map((tool) => {
    // The SDK's full definition (including header bindings and metadata) is pinned
    // by its digest. Keep it in this session; never rebuild it from a database row.
    if (!validServiceJson(tool) || full.has(tool.name)) throw Error('invalid tool');
    const inputSchema = tool.inputSchema,
      outputSchema = tool.outputSchema ?? null,
      annotations = tool.annotations ?? null;
    if (
      !validServiceJson(inputSchema) ||
      !validServiceJson(outputSchema) ||
      !validServiceJson(annotations)
    )
      throw Error('invalid schema');
    full.set(tool.name, immutable(tool));
    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema,
      outputSchema,
      annotations,
      definitionDigest: createHash('sha256').update(canonicalJson(tool)).digest('hex'),
      provenance: { source: 'mcp' },
    };
  });
  const protocol = client.getNegotiatedProtocolVersion();
  if (!protocol) throw Error('unknown protocol');
  const candidate: McpCatalogCandidate = freezeJson({
    connectionId: c.id,
    configRevision: c.configRevision,
    credentialRevision: c.credentialRevision,
    trustRevision: c.trustRevision,
    completeness: 'complete',
    observedAt: new Date().toISOString(),
    tools,
    provenance: { protocol, client: '2.4.0' },
  });
  if (!validServiceCatalogSnapshot({ ...candidate, id: 'candidate' }))
    throw Error('invalid catalog');
  if (
    page.ttlMs !== undefined &&
    (typeof page.ttlMs !== 'number' || !Number.isSafeInteger(page.ttlMs) || page.ttlMs < 0)
  )
    throw Error('invalid ttl');
  return { candidate, full, ttlMs: Math.min(Math.max(page.ttlMs ?? 60000, 1000), 60000) };
}
