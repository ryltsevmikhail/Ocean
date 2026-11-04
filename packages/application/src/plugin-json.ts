/**
 * Small pure helpers shared by the plugin services: UTF-8 byte counting,
 * canonical payload digests and bounded JSON walking. No I/O, no Node buffer.
 */

import type { ServicePluginJson, ServicePluginTool } from './service-plugin-transport.js';

/** UTF-8 byte length without allocating a Buffer. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Exact schema digest: sha256 over the canonical form of name-sorted tools. */
export function pluginToolsDigest(
  tools: readonly ServicePluginTool[],
  sha256: (text: string) => string,
  canonical: (value: unknown) => string,
): string {
  const sorted = [...tools]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  return sha256(canonical(sorted));
}

/** JSON payload size for the application-owned 1 MiB request cap. */
export function pluginJsonBytes(
  value: ServicePluginJson,
  canonical: (value: unknown) => string,
): number {
  return utf8Length(canonical(value));
}

/** Reject JSON that is not fully representable before it crosses a port. */
export function validServicePluginJson(value: unknown, depth = 0): value is ServicePluginJson {
  if (depth > 64) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return value.every((item) => validServicePluginJson(item, depth + 1));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every((item) =>
      validServicePluginJson(item, depth + 1),
    );
  }
  return false;
}
