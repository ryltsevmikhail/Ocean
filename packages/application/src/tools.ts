/** Application-owned tool admission: prepare, approve, claim, execute, record. */
export interface ToolInvocation {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}
export interface ToolResult {
  readonly output: string;
  readonly isError: boolean;
  readonly uncertain?: boolean;
}
export type ToolKind = 'read' | 'search' | 'edit' | 'execute';
export interface PreparedTool {
  readonly title: string;
  readonly kind: ToolKind;
  readonly preview: string;
  execute(signal: AbortSignal): Promise<ToolResult>;
}
export interface ToolExecutorPort {
  readonly definitions: readonly ToolSchema[];
  prepare(call: ToolInvocation): Promise<PreparedTool>;
}
export interface ToolPermissionPort {
  review(
    tool: Readonly<Pick<PreparedTool, 'title' | 'kind' | 'preview'>>,
    signal: AbortSignal,
  ): Promise<'allow_once' | 'allow_session' | 'reject'>;
}
export interface ToolEffectContext {
  readonly taskRunId: string;
  readonly attemptId: string;
}
export type ToolEffectOutcome = 'started' | 'completed' | 'failed' | 'uncertain' | 'not_started';
export interface ToolEffectRecord extends ToolEffectContext {
  readonly id: string;
  readonly tool: string;
  readonly fingerprint: string;
  readonly outcome: ToolEffectOutcome;
}
export interface ToolJournalPort {
  /** Claim must commit before the external effect; false means never execute again. */
  claim(
    id: string,
    tool: string,
    context: ToolEffectContext,
    fingerprint: string,
  ): Promise<boolean>;
  settle(
    id: string,
    outcome: 'completed' | 'failed' | 'uncertain' | 'not_started',
    context?: ToolEffectContext,
  ): Promise<void>;
  pending(taskRunId?: string): Promise<readonly ToolEffectRecord[]>;
  /** Recovery only reduces certainty: it cannot authorize replay or claim completed effects. */
  recover(id: string, context: ToolEffectContext): Promise<void>;
}

/** Expected tool failure with a message safe to show to the model. */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** One instance per conversation; approval and invocation claims never escape its scope. */
export class ToolService {
  readonly #executor: ToolExecutorPort;
  readonly #permissions: ToolPermissionPort;
  readonly #journal: ToolJournalPort | undefined;
  readonly #results = new Map<string, { call: string; result: Promise<ToolResult> }>();
  readonly #allowed = new Set<string>();
  #unresolved = false;

  constructor(
    executor: ToolExecutorPort,
    permissions: ToolPermissionPort,
    journal?: ToolJournalPort,
  ) {
    this.#executor = executor;
    this.#permissions = permissions;
    this.#journal = journal;
  }

  get definitions(): readonly ToolSchema[] {
    return this.#executor.definitions;
  }

  /** Duplicate identity returns its original outcome; mismatched payload never executes. */
  execute(
    call: ToolInvocation,
    signal: AbortSignal,
    context?: ToolEffectContext,
  ): Promise<ToolResult> {
    call = Object.freeze({ ...call });
    context = context === undefined ? undefined : Object.freeze({ ...context });
    const fingerprint = JSON.stringify([call.name, call.arguments]);
    const key = JSON.stringify([context?.taskRunId, context?.attemptId, call.id]);
    const previous = this.#results.get(key);
    if (previous !== undefined) {
      return previous.call === fingerprint
        ? previous.result
        : Promise.resolve({ isError: true, output: 'invocation identity conflict' });
    }
    if (this.#unresolved)
      return Promise.resolve({
        isError: true,
        uncertain: true,
        output: 'unresolved tool effect; reconcile its outcome before new execution',
      });
    if (this.#results.size >= 1024)
      return Promise.resolve({ isError: true, output: 'session tool limit reached' });
    const result = this.#perform(call, signal, context).then((result) => {
      if (result.uncertain === true) this.#unresolved = true;
      return result;
    });
    this.#results.set(key, { call: fingerprint, result });
    return result;
  }

  async #perform(
    call: ToolInvocation,
    signal: AbortSignal,
    context?: ToolEffectContext,
  ): Promise<ToolResult> {
    let started = false;
    let claimAttempted = false;
    try {
      if (signal.aborted) throw new ToolError('cancelled', 'tool cancelled before execution');
      // Check globally before preparation: a fresh run or invocation id cannot bypass
      // a live/crashed claim, including legacy claims that have no trustworthy owner.
      if (this.#journal !== undefined && (await this.#journal.pending()).length > 0)
        return {
          isError: true,
          uncertain: true,
          output: 'unresolved tool effect; reconcile its outcome before new execution',
        };
      const prepared = await this.#executor.prepare(call);
      // The approval surface cannot replace the operation or widen its preview.
      const tool = Object.freeze({
        title: prepared.title,
        kind: prepared.kind,
        preview: prepared.preview,
        execute: prepared.execute.bind(prepared),
      });
      const approvalScope = JSON.stringify([tool.kind, call.name, call.arguments, tool.preview]);
      if (tool.kind === 'edit' || tool.kind === 'execute') {
        if (!this.#allowed.has(approvalScope)) {
          const decision = await this.#permissions.review(
            Object.freeze({ title: tool.title, kind: tool.kind, preview: tool.preview }),
            signal,
          );
          if (decision !== 'allow_once' && decision !== 'allow_session')
            throw new ToolError('denied', 'tool permission denied');
          if (decision === 'allow_session') this.#allowed.add(approvalScope);
        }
      }
      if (signal.aborted) throw new ToolError('cancelled', 'tool cancelled before execution');
      if (this.#journal !== undefined && context === undefined)
        throw new ToolError(
          'effect_context',
          'durable tool execution requires run and attempt identity',
        );
      claimAttempted = this.#journal !== undefined;
      if (
        this.#journal !== undefined &&
        context !== undefined &&
        !(await this.#journal.claim(
          call.id,
          call.name,
          context,
          JSON.stringify([call.name, call.arguments]),
        ))
      ) {
        return {
          isError: true,
          uncertain: true,
          output: 'invocation already claimed; reconcile its outcome before retrying',
        };
      }
      // A committed claim may outlive cancellation; record absence before returning.
      if (signal.aborted) {
        await this.#journal?.settle(call.id, 'not_started', context);
        claimAttempted = false;
        throw new ToolError('cancelled', 'tool cancelled before execution');
      }
      started = true;
      const result = await tool.execute(signal);
      await this.#journal?.settle(
        call.id,
        result.uncertain === true ? 'uncertain' : result.isError ? 'failed' : 'completed',
        context,
      );
      return result;
    } catch (error) {
      if (started || claimAttempted) {
        try {
          await this.#journal?.settle(call.id, 'uncertain', context);
        } catch {
          /* The durable started claim still blocks replay when settlement fails. */
        }
      }
      return {
        isError: true,
        ...(started || claimAttempted ? { uncertain: true } : {}),
        output:
          error instanceof ToolError
            ? `${error.code}: ${error.message}`
            : started || claimAttempted
              ? 'tool outcome uncertain; do not repeat automatically'
              : 'tool preparation failed',
      };
    }
  }
}
