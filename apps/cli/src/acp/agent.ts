/**
 * ACP agent implementation.
 *
 * The agent exposes the runtime to an out-of-process client (the desktop app):
 * one ACP session is one conversation, and each prompt runs its own TaskRun so
 * a terminal run never blocks the next turn. All lifecycle decisions belong to
 * the domain — this layer translates protocol frames into commands and events
 * into updates.
 */

import {
  ACP_PROTOCOL_VERSION,
  JSONRPC_ERROR,
  type ContentBlock,
  type InitializeParams,
  type InitializeResult,
  type ModelState,
  type NewSessionParams,
  type NewSessionResult,
  type PromptParams,
  type PromptResult,
  type SessionUpdate,
} from '@runnets/contracts';
import type { TaskRunId } from '@runnets/domain';
import {
  selectTurnTask,
  type ToolService,
  type TaskRunService,
  type RuntimeRecovery,
} from '@runnets/application';
import type { ProviderPort } from '@runnets/provider-core';

import { Conversation, textOfPrompt } from '../engine/conversation.js';
import { runTurn } from '../engine/turn.js';
import { createTaskRun, sessionIds, turnTaskRunId } from './session.js';
import type { JsonRpcPeer } from './transport.js';

const AGENT_INFO = { name: 'runnets', version: '0.0.0', title: 'RunneTS runtime' } as const;
const LOCAL_MODEL = 'runnets-local';

/** Application-level refusal carrying a JSON-RPC error code. */
class AgentError extends Error {
  readonly code: number;

  constructor(message: string, code: number = JSONRPC_ERROR.application) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

function requireSessionId(params: unknown): string {
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new AgentError('sessionId is required', JSONRPC_ERROR.invalidParams);
  }
  return sessionId;
}

interface SessionState {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly model: string;
  readonly conversation: Conversation;
  /** Number of TaskRuns created for this session; also the next turn ordinal. */
  turns: number;
  currentTaskRunId: TaskRunId;
  controller: AbortController | null;
  readonly tools: ToolService | undefined;
}

export interface AcpAgentOptions {
  readonly recovery?: RuntimeRecovery;
  readonly createTools?: (cwd: string, sessionId: string) => Promise<ToolService>;
  /** Resolved provider; without one a turn stays deterministic. */
  readonly provider?: ProviderPort | null;
}

export class AcpAgent {
  readonly #peer: JsonRpcPeer;
  readonly #service: TaskRunService;
  readonly #provider: ProviderPort | null;
  readonly #sessions = new Map<string, SessionState>();
  readonly #createTools: AcpAgentOptions['createTools'];
  readonly #recovery: RuntimeRecovery | undefined;
  #sessionCounter = 0;
  #shuttingDown = false;

  constructor(peer: JsonRpcPeer, service: TaskRunService, options: AcpAgentOptions = {}) {
    this.#peer = peer;
    this.#service = service;
    this.#provider = options.provider ?? null;
    this.#createTools = options.createTools;
    this.#recovery = options.recovery;
  }

  /** Reject queued turns and abort active providers before the host drains transport. */
  shutdown(): void {
    this.#shuttingDown = true;
    for (const session of this.#sessions.values()) session.controller?.abort();
  }

  attach(): void {
    this.#peer.handle('initialize', (params) => this.initialize(params));
    this.#peer.handle('session/new', (params) => this.newSession(params));
    this.#peer.handle('session/prompt', (params) => this.prompt(params));
    // Cancellation must not queue behind the streaming prompt it interrupts.
    this.#peer.handle('session/cancel', (params) => this.cancel(params), { concurrent: true });
    this.#peer.onNotification('session/cancel', (params) => {
      void this.cancel(params);
    });
  }

  /** Advertise only what is implemented; clients gate features on these flags. */
  initialize(params: unknown): Promise<InitializeResult> {
    const input = (params ?? {}) as InitializeParams;
    if (input.protocolVersion !== undefined && input.protocolVersion > ACP_PROTOCOL_VERSION) {
      return Promise.reject(
        new AgentError(`unsupported protocol version ${String(input.protocolVersion)}`),
      );
    }
    return Promise.resolve({
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentInfo: AGENT_INFO,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        sessionCapabilities: { close: false, load: false, resume: false },
      },
      authMethods: [],
      models: this.#modelState(),
    });
  }

  /** Open a conversation and its first TaskRun. */
  async newSession(params: unknown): Promise<NewSessionResult> {
    if (this.#shuttingDown) throw new AgentError('agent is shutting down');
    const input = (params ?? {}) as NewSessionParams;
    if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
      throw new AgentError('cwd is required', JSONRPC_ERROR.invalidParams);
    }

    this.#sessionCounter += 1;
    let suffix = String(this.#sessionCounter).padStart(4, '0');
    // Retained streams must never turn a fresh session into a dedup replay.
    while ((await this.#service.state(turnTaskRunId(`s_${suffix}`, 1))).status !== 'absent') {
      this.#sessionCounter += 1;
      suffix = String(this.#sessionCounter).padStart(4, '0');
    }
    const sessionId = `s_${suffix}`;
    const ids = sessionIds(suffix);
    const models = this.#modelState();
    const model =
      typeof input.model === 'string' && input.model.trim() !== ''
        ? input.model
        : (models.currentModelId ?? LOCAL_MODEL);

    const session: SessionState = {
      sessionId,
      conversationId: ids.conversationId,
      workspaceId: ids.workspaceId,
      model,
      conversation: new Conversation(),
      turns: 1,
      currentTaskRunId: turnTaskRunId(sessionId, 1),
      controller: null,
      tools: await this.#createTools?.(input.cwd, sessionId),
    };
    await createTaskRun({
      service: this.#service,
      taskRunId: session.currentTaskRunId,
      conversationId: session.conversationId,
      workspaceId: session.workspaceId,
      parentTaskRunId: null,
      model,
    });
    this.#sessions.set(sessionId, session);
    if ((this.#recovery?.tasks.length ?? 0) + (this.#recovery?.effects.length ?? 0) > 0)
      this.#emit(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Interrupted work requires reconciliation; history was not restored. Inspect with runne status. New tools remain blocked while effects are unresolved.',
        },
      });
    return { sessionId, models };
  }

  /** One prompt is one turn; a terminal run is followed by a fresh TaskRun. */
  async prompt(params: unknown): Promise<PromptResult> {
    if (this.#shuttingDown) throw new AgentError('agent is shutting down');
    const input = (params ?? {}) as PromptParams;
    const sessionId = requireSessionId(input);
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new AgentError('session is unknown', JSONRPC_ERROR.invalidParams);
    }
    const rawPrompt: unknown = input.prompt;
    if (!Array.isArray(rawPrompt)) {
      throw new AgentError(
        'prompt must be an array of content blocks',
        JSONRPC_ERROR.invalidParams,
      );
    }

    if (session.controller !== null) throw new AgentError('a turn is already running');
    const controller = new AbortController();
    session.controller = controller;
    try {
      await this.#ensureOpenTaskRun(session);
      session.conversation.appendUser(textOfPrompt(rawPrompt as readonly ContentBlock[]));
      const outcome = await runTurn({
        service: this.#service,
        provider: this.#provider,
        tools: session.tools,
        onHistory: (messages) => session.conversation.appendMessages(messages),
        taskRunId: session.currentTaskRunId,
        model: session.model,
        messages: session.conversation.messages,
        signal: controller.signal,
        emit: (update) => this.#emit(sessionId, update),
      });

      return { stopReason: outcome.stopReason };
    } finally {
      session.controller = null;
    }
  }

  /** Abort the in-flight turn; the turn itself commits the cancellation. */
  cancel(params: unknown): Promise<Record<string, never>> {
    const sessionId = requireSessionId(params);
    this.#sessions.get(sessionId)?.controller?.abort();
    return Promise.resolve({});
  }

  /** A terminal run cannot accept another turn, so start the next one. */
  async #ensureOpenTaskRun(session: SessionState): Promise<void> {
    session.currentTaskRunId = await selectTurnTask(
      this.#service,
      session.currentTaskRunId,
      async () => {
        const previous = session.currentTaskRunId;
        session.turns += 1;
        const next = turnTaskRunId(session.sessionId, session.turns);
        await createTaskRun({
          service: this.#service,
          taskRunId: next,
          conversationId: session.conversationId,
          workspaceId: session.workspaceId,
          parentTaskRunId: previous,
          model: session.model,
        });
        return next;
      },
    );
  }

  #modelState(): ModelState {
    if (this.#provider === null) {
      return {
        currentModelId: LOCAL_MODEL,
        availableModels: [{ id: LOCAL_MODEL, name: 'RunneTS local runtime' }],
      };
    }
    return {
      currentModelId: this.#provider.models[0] ?? LOCAL_MODEL,
      availableModels: this.#provider.models.map((id) => ({ id, name: id })),
    };
  }

  #emit(sessionId: string, update: SessionUpdate): void {
    this.#peer.notify('session/update', { sessionId, update });
  }
}
