/**
 * Pure validation of one discovered catalog before its digest is published.
 *
 * The transport is bounded, but these checks are the application's own: exact
 * tool names, no duplicates, bounded descriptions, the pinned digest over the
 * canonical tool bytes and only operations declared by the installed manifest.
 */

import type { PluginManifest } from '@runnets/domain';
import { SERVICE_PLUGIN_MAX_TOOLS, type ServicePluginTool } from './service-plugin-transport.js';
import { PluginRefusedError } from './plugin-ports.js';
import { pluginToolsDigest } from './plugin-json.js';

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function requireDeclaredTools(
  manifest: PluginManifest,
  tools: readonly ServicePluginTool[],
): void {
  const declared = new Set(manifest.operations.map((operation) => operation.tool));
  if (tools.some((tool) => !declared.has(tool.name)))
    throw new PluginRefusedError('unexpected_tool', 'plugin catalog refused: unexpected_tool');
  if (tools.length !== declared.size)
    throw new PluginRefusedError('missing_tool', 'plugin catalog refused: missing_tool');
}

export function validDiscoveredTools(
  tools: readonly ServicePluginTool[],
  sha256: (text: string) => string,
  canonical: (value: unknown) => string,
): { readonly tools: readonly ServicePluginTool[]; readonly digest: string } {
  const observed: unknown = tools;
  if (!Array.isArray(observed) || observed.length > SERVICE_PLUGIN_MAX_TOOLS)
    throw new PluginRefusedError('too_many_tools', 'plugin catalog refused: too_many_tools');
  const seen = new Set<string>();
  const valid: ServicePluginTool[] = [];
  for (const entry of observed as unknown[]) {
    if (typeof entry !== 'object' || entry === null)
      throw new PluginRefusedError('invalid_catalog', 'plugin catalog refused: invalid_catalog');
    const tool = entry as Record<string, unknown>;
    const name = tool['name'];
    const description = tool['description'];
    if (
      typeof name !== 'string' ||
      !TOOL_NAME.test(name) ||
      seen.has(name) ||
      typeof description !== 'string' ||
      description.length > 8192
    )
      throw new PluginRefusedError('invalid_catalog', 'plugin catalog refused: invalid_catalog');
    seen.add(name);
    valid.push({
      name,
      description,
      inputSchema: (tool['inputSchema'] ?? null) as ServicePluginTool['inputSchema'],
    });
  }
  return { tools: valid, digest: pluginToolsDigest(valid, sha256, canonical) };
}
