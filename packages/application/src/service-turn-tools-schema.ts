import {
  canonicalJson,
  validServiceJson,
  utf8Bytes,
  truncatePluginOutput,
  PLUGIN_MAX_MODEL_OUTPUT_BYTES,
  type ServiceToolDefinition,
  type ServiceJson,
} from '@runnets/domain';
import type { ServiceCallResult } from './service-admission-types.js';
import type { ToolResult, ToolSchema } from './tools.js';
import { SERVICE_PLUGIN_MAX_REQUEST_BYTES } from './service-plugin-transport.js';
export function freezeServiceFact<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeServiceFact(child);
    Object.freeze(value);
  }
  return value;
}
export function serviceAlias(hash: (text: string) => string, route: readonly string[]): string {
  const digest = hash(canonicalJson(route));
  if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('invalid_service_hash');
  return 'mcp_' + digest.slice(0, 56);
}
export function serviceSchema(name: string, tool: ServiceToolDefinition): ToolSchema | null {
  const parameters = tool.inputSchema;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  return freezeServiceFact({
    name,
    description: tool.description,
    parameters: parameters as Readonly<Record<string, unknown>>,
  });
}
export function serviceArguments(text: string): ServiceJson {
  if (utf8Bytes(text) > SERVICE_PLUGIN_MAX_REQUEST_BYTES) throw Error('arguments_too_large');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validServiceJson(value))
    throw Error('invalid_arguments');
  return value;
}
export function serviceRefusal(code: string): ToolResult {
  return { isError: true, output: `service call refused (${code})` };
}
export function serviceUncertain(): ToolResult {
  return {
    isError: true,
    uncertain: true,
    output: 'Service outcome unknown. Stop and reconcile the durable operation; do not repeat it.',
  };
}
export function serviceResult(result: ServiceCallResult): ToolResult {
  if (result.code === 'claim_refused') return serviceUncertain();
  const outcome = result.outcome;
  if (!outcome) return serviceRefusal(result.code);
  if (outcome.kind === 'uncertain') return serviceUncertain();
  if (outcome.kind === 'not_started') return serviceRefusal(outcome.code);
  return {
    isError: outcome.code !== 'ok',
    output: truncatePluginOutput(canonicalJson(outcome.result), PLUGIN_MAX_MODEL_OUTPUT_BYTES).text,
  };
}
