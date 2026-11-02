import type { CodingTestPreset } from '@runnets/domain';
import type { CodingApprovalOwnerPort, CodingApprovalService } from './coding-approval.js';
import { dispatchCodingOperation, type PreparedCodingOperation } from './coding-dispatch.js';
import {
  ToolError,
  type ToolEffectContext,
  type ToolInvocation,
  type ToolJournalPort,
  type ToolResult,
  type ToolSchema,
} from './tools.js';

export interface CodingTurnToolDeps {
  readonly definitions: readonly ToolSchema[];
  readonly presets: readonly CodingTestPreset[];
  readonly approvals: CodingApprovalService;
  readonly owner: CodingApprovalOwnerPort;
  readonly journal: ToolJournalPort;
  readonly taskRunId: string;
  readonly nextId: () => string;
  readonly admit: (context: ToolEffectContext) => boolean;
  readonly read: (call: ToolInvocation, signal: AbortSignal) => Promise<ToolResult>;
  readonly prepare: (
    approvalId: string,
    call: ToolInvocation,
    context: ToolEffectContext,
  ) => Promise<PreparedCodingOperation>;
}
const fileNames = ['list_files', 'read_file', 'write_file', 'replace_text'];
/** One instance per admitted room turn; model arguments never specify a shell command. */
export class CodingTurnTools {
  readonly definitions: readonly ToolSchema[];
  readonly #deps: CodingTurnToolDeps;
  readonly #results = new Map<string, { binding: string; result: Promise<ToolResult> }>();
  #held = false;
  constructor(deps: CodingTurnToolDeps) {
    this.#deps = { ...deps, presets: structuredClone(deps.presets) };
    this.definitions = [
      ...structuredClone(deps.definitions.filter((tool) => fileNames.includes(tool.name))),
      {
        name: 'run_test',
        description: 'Run an owner-registered test preset with separate allow-once approval.',
        parameters: {
          type: 'object',
          properties: { presetId: { type: 'string', enum: deps.presets.map((p) => p.id) } },
          required: ['presetId'],
          additionalProperties: false,
        },
      },
    ];
  }
  execute(
    call: ToolInvocation,
    signal: AbortSignal,
    context?: ToolEffectContext,
  ): Promise<ToolResult> {
    const frozen = Object.freeze({ ...call });
    const bound = context === undefined ? undefined : Object.freeze({ ...context });
    const binding = JSON.stringify([frozen, bound]);
    const previous = this.#results.get(call.id);
    if (previous)
      return previous.binding === binding
        ? previous.result
        : Promise.resolve({ isError: true, output: 'invocation identity conflict' });
    const result = this.#execute(frozen, signal, bound);
    this.#results.set(call.id, { binding, result });
    return result;
  }
  async #execute(
    call: ToolInvocation,
    signal: AbortSignal,
    context?: ToolEffectContext,
  ): Promise<ToolResult> {
    try {
      signal.throwIfAborted();
      if (
        this.#held ||
        !context ||
        context.taskRunId !== this.#deps.taskRunId ||
        !this.#deps.admit(context)
      )
        throw new ToolError('coding_denied', 'task tools are not authorized');
      if (call.name === 'read_file' || call.name === 'list_files') {
        const result = await this.#deps.read(call, signal);
        if (result.uncertain) this.#held = true;
        return result;
      }
      let invocation = call;
      if (call.name === 'run_test') {
        const args = JSON.parse(call.arguments) as Record<string, unknown>;
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length !== 1 ||
          typeof args['presetId'] !== 'string'
        )
          throw new ToolError('invalid_arguments', 'select only a registered presetId');
        const preset = this.#deps.presets.find((p) => p.id === args['presetId']);
        if (!preset) throw new ToolError('preset_denied', 'unknown test preset');
        invocation = {
          ...call,
          name: 'run_command',
          arguments: JSON.stringify({
            program: preset.program,
            args: preset.args,
            cwd: preset.cwd,
          }),
        };
      } else if (call.name !== 'write_file' && call.name !== 'replace_text')
        throw new ToolError('coding_denied', 'tool unavailable');
      const prepared = await this.#deps.prepare(this.#deps.nextId(), invocation, context);
      const result = await dispatchCodingOperation(
        prepared,
        this.#deps.approvals,
        this.#deps.owner,
        this.#deps.journal,
        signal,
      );
      if (result.uncertain) this.#held = true;
      return result;
    } catch (error) {
      if (error instanceof ToolError && error.code === 'effect_uncertain') this.#held = true;
      return {
        isError: true,
        output: error instanceof ToolError ? error.code : 'coding tool request failed',
        ...(this.#held ? { uncertain: true } : {}),
      };
    }
  }
}
