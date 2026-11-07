import { expect, it } from 'vitest';
import { ToolService, type ChatMessage } from '@runnets/application';
import { WorkspaceTools, type WorkspaceBackend } from '@runnets/tools-node';
import { createOpenAIProvider } from '@runnets/provider-openai';
import { taskRunId } from '@runnets/domain';
import { createService } from '../lifecycle.js';
import { createTaskRun } from '../acp/session.js';
import { runTurn } from './turn.js';

it('rejects malformed candidate arguments in the production engine before workspace effects', async () => {
  let effects = 0,
    sends = 0;
  const effect = () => {
    effects++;
    throw Error('unexpected workspace effect');
  };
  const backend: WorkspaceBackend = { read: effect, list: effect, write: effect, command: effect };
  const tools = new ToolService(new WorkspaceTools(backend), { review: async () => 'reject' });
  const model = 'gpt-5.6-terra';
  const frame = (choices: unknown) => `data: ${JSON.stringify({ model, choices })}\n\n`;
  const provider = createOpenAIProvider({
    apiKey: 'fixture',
    httpClient: {
      async send() {
        sends++;
        const choices =
          sends === 1
            ? [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'candidate',
                        function: { name: 'write_file', arguments: '{malformed' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ]
            : [{ index: 0, delta: { content: 'Arguments were refused' }, finish_reason: 'stop' }];
        return {
          status: 200,
          ok: true,
          text: async () => '',
          async *stream() {
            yield frame(choices);
            yield `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`;
            yield 'data: [DONE]\n\n';
          },
        };
      },
    },
  });
  const service = createService();
  const id = taskRunId('tr_openai_bad_arguments');
  await createTaskRun({
    service,
    taskRunId: id,
    conversationId: 'cv_openai',
    workspaceId: 'ws_openai',
    parentTaskRunId: null,
    model,
  });
  const history: ChatMessage[] = [];
  const result = await runTurn({
    service,
    taskRunId: id,
    tools,
    provider,
    model,
    messages: [{ role: 'user', content: 'write file' }],
    signal: new AbortController().signal,
    emit: () => {},
    onHistory: (messages) => history.push(...messages),
    maxModelRequests: 2,
  });
  expect(result.kind).toBe('completed');
  expect(sends).toBe(2); // Existing bounded engine feedback round, no adapter retry.
  expect(effects).toBe(0);
  expect(history).toContainEqual({
    role: 'tool',
    toolCallId: 'candidate',
    content: 'invalid_arguments: arguments must be JSON',
  });
});
