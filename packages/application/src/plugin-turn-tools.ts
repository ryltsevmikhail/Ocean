/**
 * Task-independent granted-tool source for normal and broadcast room turns.
 *
 * For one addressed bot in one room it resolves exactly that bot's active
 * grants and exposes only the granted tool names/schemas (plus bounded
 * instructions) in the existing `TurnInput['tools']` shape. Each call goes
 * through `PluginCallAdmissionService`, which rechecks the whole authority
 * snapshot transactionally before the single transport dispatch.
 *
 * A model never learns about ungranted tools: definitions come only from the
 * grant's exact tool list, and any hallucinated name is refused before claim.
 * The pilot is read-only, so no interactive per-call approval is involved; the
 * journal/claim and the per-turn/output limits are mandatory.
 */

import {
  boundPluginDetail,
  truncatePluginOutput,
  PLUGIN_MAX_CALLS_PER_TURN,
  PLUGIN_MAX_MODEL_OUTPUT_BYTES,
  type ChatTurn,
} from '@runnets/domain';
import type { PluginCallAdmissionService } from './plugin-admission.js';
import type { PluginAccessStorePort, PluginConnectionStorePort } from './plugin-ports.js';
import type { ServicePluginJson } from './service-plugin-transport.js';
import type { ServicePluginTransportPort } from './service-plugin-transport.js';
import { pluginSessionReady } from './plugin-session-authority.js';
import type { ToolEffectContext, ToolInvocation, ToolResult, ToolSchema } from './tools.js';
import {
  bindPluginArguments,
  pluginToolArguments,
  pluginToolInstructions,
  pluginToolRefusal,
  toolSchema,
  UNCERTAIN_NOTE,
} from './plugin-turn-tools-schema.js';
import type { ResolvedGrant } from './plugin-turn-tools-schema.js';
export type { ResolvedGrant } from './plugin-turn-tools-schema.js';
import type { TurnInput } from './types.js';

/** Shape the shared turn executor passes to `runTurn`; cleanup is synchronous. */
export type GrantedPluginTools = NonNullable<TurnInput['tools']> & {
  readonly cleanupConfirmed: true;
};

/** Resolver used by the shared chat executor for non-coding room turns. */
export interface GrantedToolSource {
  /** Only this addressed bot's grants; null when nothing is granted/eligible. */
  forTurn(turn: ChatTurn, signal: AbortSignal): Promise<GrantedPluginTools | null>;
}

export interface PluginToolServiceOptions {
  readonly grants: Pick<PluginAccessStorePort, 'grants'>;
  readonly connections: Pick<PluginConnectionStorePort, 'get'>;
  readonly admission: PluginCallAdmissionService;
  readonly transport?: ServicePluginTransportPort;
  readonly maxCallsPerTurn?: number;
  readonly maxOutputBytes?: number;
}

export class PluginToolService implements GrantedToolSource {
  readonly #options: PluginToolServiceOptions;
  readonly #maxCalls: number;
  readonly #maxOutputBytes: number;

  constructor(options: PluginToolServiceOptions) {
    this.#options = options;
    this.#maxCalls = options.maxCallsPerTurn ?? PLUGIN_MAX_CALLS_PER_TURN;
    this.#maxOutputBytes = options.maxOutputBytes ?? PLUGIN_MAX_MODEL_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.#maxCalls) || this.#maxCalls < 1)
      throw new RangeError('maxCalls');
    if (!Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes < 256)
      throw new RangeError('maxOutputBytes');
  }

  async forTurn(turn: ChatTurn, signal: AbortSignal): Promise<GrantedPluginTools | null> {
    await Promise.resolve();
    if (signal.aborted) return null;
    const grants = this.#options.grants
      .grants({ workspaceId: turn.workspaceId, roomId: turn.roomId, botId: turn.bot.id })
      .filter((grant) => grant.state === 'active');
    const resolved: ResolvedGrant[] = [];
    const definitions: ToolSchema[] = [];
    const byTool = new Map<string, ResolvedGrant>();
    for (const grant of grants) {
      const connection = this.#options.connections.get(grant.connectionId);
      if (connection === null) continue;
      if (connection.state !== 'active') continue;
      if (connection.pluginId !== grant.pluginId) continue;
      if (connection.generation !== grant.connectionGeneration) continue;
      if (connection.schemaDigest !== grant.schemaDigest) continue;
      if (!pluginSessionReady(this.#options.transport ?? {}, connection)) continue;
      const tools = (connection.tools ?? []).filter((tool) => grant.tools.includes(tool.name));
      if (tools.length === 0) continue;
      const entry: ResolvedGrant = { grant, connection, tools };
      resolved.push(entry);
      for (const tool of tools) {
        if (byTool.has(tool.name)) continue;
        byTool.set(tool.name, entry);
        definitions.push(toolSchema(tool));
      }
    }
    if (definitions.length === 0 || resolved.length === 0) return null;
    return new TurnPluginTools(
      byTool,
      definitions,
      pluginToolInstructions(resolved),
      this.#options.admission,
      this.#maxCalls,
      this.#maxOutputBytes,
    );
  }
}

/** One instance per turn: the call budget and deduplication never leak across turns. */
class TurnPluginTools implements GrantedPluginTools {
  readonly cleanupConfirmed = true as const;
  readonly definitions: readonly ToolSchema[];
  readonly instructions: string;
  readonly #byTool: ReadonlyMap<string, ResolvedGrant>;
  readonly #admission: PluginCallAdmissionService;
  readonly #maxCalls: number;
  readonly #maxOutputBytes: number;
  readonly #results = new Map<string, Promise<ToolResult>>();
  #calls = 0;

  constructor(
    byTool: ReadonlyMap<string, ResolvedGrant>,
    definitions: readonly ToolSchema[],
    instructions: string,
    admission: PluginCallAdmissionService,
    maxCalls: number,
    maxOutputBytes: number,
  ) {
    this.#byTool = byTool;
    this.definitions = Object.freeze(definitions.map((definition) => Object.freeze(definition)));
    this.instructions = instructions;
    this.#admission = admission;
    this.#maxCalls = maxCalls;
    this.#maxOutputBytes = maxOutputBytes;
  }

  /** Never throws for a refused or uncertain call: the model sees a bounded result. */
  execute(
    call: ToolInvocation,
    signal: AbortSignal,
    context?: ToolEffectContext,
  ): Promise<ToolResult> {
    const previous = this.#results.get(call.id);
    if (previous !== undefined) return previous;
    const result = this.#perform(Object.freeze({ ...call }), signal, context);
    this.#results.set(call.id, result);
    return result;
  }

  async #perform(
    call: ToolInvocation,
    signal: AbortSignal,
    context: ToolEffectContext | undefined,
  ): Promise<ToolResult> {
    if (signal.aborted) return { isError: true, output: 'Not executed: turn cancelled' };
    const granted = this.#byTool.get(call.name);
    if (granted === undefined)
      return pluginToolRefusal(
        'tool_ungranted',
        'this tool is not granted to this bot in this room',
      );
    if (this.#calls >= this.#maxCalls)
      return pluginToolRefusal(
        'call_limit',
        `at most ${this.#maxCalls} plugin calls per turn; this call was refused without dispatch`,
      );
    if (context === undefined)
      return pluginToolRefusal(
        'effect_context',
        'durable plugin execution requires run and attempt identity',
      );
    let argumentsValue: Readonly<Record<string, unknown>>;
    try {
      argumentsValue = pluginToolArguments(call.arguments);
    } catch {
      return pluginToolRefusal('invalid_arguments', 'arguments must be one JSON object');
    }
    const bound = bindPluginArguments(granted, call.name, argumentsValue);
    if (typeof bound === 'string')
      return pluginToolRefusal(bound, 'arguments are outside the granted scope');
    this.#calls += 1;
    const invocationId = `${context.attemptId}_plugin_${call.id}`;
    let result;
    try {
      result = await this.#admission.call({
        workspaceId: granted.grant.workspaceId,
        roomId: granted.grant.roomId,
        botId: granted.grant.botId,
        pluginId: granted.grant.pluginId,
        connectionId: granted.grant.connectionId,
        grantId: granted.grant.id,
        tool: call.name,
        arguments: bound as ServicePluginJson,
        claim: { invocationId, taskRunId: context.taskRunId, attemptId: context.attemptId },
      });
    } catch {
      return {
        isError: true,
        uncertain: true,
        output:
          'plugin call failed outside the durable claim; no retry is attempted' + UNCERTAIN_NOTE,
      };
    }
    return this.#present(result);
  }

  #present(result: Awaited<ReturnType<PluginCallAdmissionService['call']>>): ToolResult {
    if (!result.admitted) return pluginToolRefusal(result.code, 'no request was made');
    const outcome = result.outcome;
    if (outcome === null) {
      return {
        isError: true,
        uncertain: true,
        output: 'plugin invocation has no recorded outcome' + UNCERTAIN_NOTE,
      };
    }
    if (outcome.kind === 'not_started')
      return pluginToolRefusal(outcome.code, 'the adapter proved nothing was sent');
    if (outcome.kind === 'uncertain')
      return {
        isError: true,
        uncertain: true,
        output:
          `plugin outcome uncertain (${boundPluginDetail(outcome.code)}); the call may have reached the service, so it is never repeated automatically.` +
          UNCERTAIN_NOTE,
      };
    // A settlement failure means the durable record cannot prove the result.
    if (!result.settled) {
      return {
        isError: true,
        uncertain: true,
        output:
          'plugin result could not be settled durably; treat the effect as unknown and do not repeat it.' +
          UNCERTAIN_NOTE,
      };
    }
    const text =
      result.summary ??
      truncatePluginOutput(
        outcome.code === 'vendor_error' ? 'upstream_error' : 'ok',
        this.#maxOutputBytes,
      ).text;
    return {
      isError: outcome.code === 'vendor_error',
      output: truncatePluginOutput(text, this.#maxOutputBytes).text,
    };
  }
}
