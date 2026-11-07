import { utf8Bytes } from '@runnets/domain';
import { SERVICE_PLUGIN_MAX_REQUEST_BYTES } from './service-plugin-transport.js';
import type { ChatTurn } from '@runnets/domain';
import type { GrantedToolSource } from './plugin-turn-tools.js';
import type { GrantedPluginTools } from './plugin-turn-tools.js';
import type { ToolResult } from './tools.js';
/** One namespace and invocation identity map inside the existing tool loop. */
export function combineChatTools(
  ...sources: readonly (GrantedPluginTools | null | undefined)[]
): GrantedPluginTools | undefined {
  const active = sources.filter((source): source is GrantedPluginTools => !!source);
  if (!active.length) return undefined;
  const routes = new Map<string, GrantedPluginTools>();
  for (const source of active) {
    if (source.cleanupConfirmed !== true) throw Error('preparation cleanup unknown');
    for (const definition of source.definitions) {
      if (routes.has(definition.name)) throw Error('duplicate_tool_name');
      routes.set(definition.name, source);
    }
  }
  if (active.length === 1 && active[0]?.ownCallIdentity) return active[0];
  const digest = active.find((source) => source.callDigest)?.callDigest;
  if (!digest) throw Error('tool_digest_required');
  const results = new Map<string, { fingerprint: string; result: Promise<ToolResult> }>();
  return {
    cleanupConfirmed: true,
    callDigest: digest,
    ownCallIdentity: true,
    definitions: Object.freeze(active.flatMap((s) => s.definitions)),
    instructions: active.map((s) => s.instructions ?? '').join('\n'),
    execute(call, signal, context) {
      const key = digest(JSON.stringify([context?.taskRunId, context?.attemptId, call.id]));
      const fingerprint = digest(JSON.stringify([call.name, call.arguments]));
      if (![key, fingerprint].every((value) => /^[a-f0-9]{64}$/.test(value)))
        throw Error('invalid_tool_digest');
      const previous = results.get(key);
      if (previous)
        return previous.fingerprint === fingerprint
          ? previous.result
          : Promise.resolve({ isError: true, output: 'invocation identity conflict' });
      if (results.size >= 1024)
        return Promise.resolve({ isError: true, output: 'turn tool limit reached' });
      const source = routes.get(call.name);
      const result =
        utf8Bytes(call.arguments) > SERVICE_PLUGIN_MAX_REQUEST_BYTES
          ? Promise.resolve({ isError: true, output: 'tool arguments too large' })
          : source
            ? source.execute(call, signal, context)
            : Promise.resolve({ isError: true, output: 'tool unavailable' });
      results.set(key, { fingerprint, result });
      return result;
    },
  };
}

/** Coding preparation must succeed before resolving any additional service authority. */
export async function prepareChatTools(
  sources: {
    readonly codingTools?: {
      forTurn(turn: ChatTurn, signal: AbortSignal): Promise<GrantedPluginTools>;
    };
    readonly grantedTools?: GrantedToolSource;
  },
  turn: ChatTurn,
  signal: AbortSignal,
): Promise<GrantedPluginTools | undefined> {
  const coding =
    turn.codingTaskId === undefined ? undefined : await sources.codingTools!.forTurn(turn, signal);
  if (coding && coding.cleanupConfirmed !== true) throw Error('preparation cleanup unknown');
  return combineChatTools(coding, await sources.grantedTools?.forTurn(turn, signal));
}
