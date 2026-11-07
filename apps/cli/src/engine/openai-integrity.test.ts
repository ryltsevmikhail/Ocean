import { expect, it } from 'vitest';
import { ToolService } from '@runnets/application';
import { WorkspaceTools, type WorkspaceBackend } from '@runnets/tools-node';
import { createOpenAIProvider } from '@runnets/provider-openai';
import { taskRunId } from '@runnets/domain';
import { createService } from '../lifecycle.js';
import { createTaskRun } from '../acp/session.js';
import { runTurn } from './turn.js';
it.each(['crossed-input', 'crossed-output', 'malformed-function'])(
  'settles %s as unknown with greatest observed debit and no tools or retry',
  async (mode) => {
    let effects = 0,
      sends = 0;
    const effect = () => {
      effects++;
      throw Error('unexpected workspace effect');
    };
    const backend: WorkspaceBackend = {
      read: effect,
      list: effect,
      write: effect,
      command: effect,
    };
    const tools = new ToolService(new WorkspaceTools(backend), { review: async () => 'reject' });
    const model = 'gpt-5.6-terra';
    const frame = (choices: unknown, usage?: unknown) =>
      `data: ${JSON.stringify({ model, choices, ...(usage === undefined ? {} : { usage }) })}\n\n`;
    const candidate = [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'candidate',
              type: 'function',
              function: { name: 'write_file', arguments: '{"path":"file.txt","content":"x"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ];
    const first =
      mode === 'crossed-output'
        ? { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 }
        : { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
    const next =
      mode === 'crossed-output'
        ? { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
        : { prompt_tokens: 4, completion_tokens: 20, total_tokens: 24 };
    const retained = mode === 'malformed-function' ? first : next;
    const provider = createOpenAIProvider({
      apiKey: 'fixture',
      httpClient: {
        async send() {
          sends++;
          return {
            status: 200,
            ok: true,
            text: async () => '',
            async *stream() {
              yield frame(candidate);
              yield frame([], first);
              yield mode === 'malformed-function'
                ? frame(
                    [
                      {
                        index: 0,
                        delta: { tool_calls: [{ index: 0, function: 42 }] },
                        finish_reason: 'tool_calls',
                      },
                    ],
                    first,
                  )
                : frame([], next);
              if (mode !== 'malformed-function')
                yield frame([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
              yield 'data: [DONE]\n\n';
            },
          };
        },
      },
    });
    const service = createService();
    const id = taskRunId(`tr_openai_${mode}`);
    await createTaskRun({
      service,
      taskRunId: id,
      conversationId: 'cv_openai_integrity',
      workspaceId: 'ws_openai_integrity',
      parentTaskRunId: null,
      model,
    });
    const result = await runTurn({
      service,
      taskRunId: id,
      tools,
      provider,
      model,
      messages: [{ role: 'user', content: 'write file' }],
      signal: new AbortController().signal,
      emit: () => {},
      maxModelRequests: 2,
    });
    expect(result.kind).toBe('uncertain');
    expect(sends).toBe(1);
    expect(effects).toBe(0);
    expect(await service.state(id)).toMatchObject({
      status: 'reconciling',
      budget: { consumed: { provider_tokens: retained.total_tokens } },
      modelExecution: {
        lastRequest: {
          settlement: {
            completion: { kind: 'unknown' },
            usage: {
              kind: 'actual',
              tokens: {
                inputTokens: retained.prompt_tokens,
                outputTokens: retained.completion_tokens,
                totalTokens: retained.total_tokens,
              },
            },
          },
        },
      },
    });
  },
);
