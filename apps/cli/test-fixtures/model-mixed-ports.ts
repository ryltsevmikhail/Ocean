import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { HttpClient, HttpResponse } from '@runnets/provider-core';
import { localMetadata } from './model-process-local-metadata.ts';
const openai = 'https://api.openai.com',
  anthropic = 'https://api.anthropic.com',
  local = 'http://127.0.0.1:11434';
const response = (chunks: string[]): HttpResponse => ({
  status: 200,
  ok: true,
  text: async () => chunks.join(''),
  async *stream() {
    yield* chunks;
  },
});
const sse = (body: unknown) => 'data: ' + JSON.stringify(body) + '\n\n';
export function mixedPorts(profile: string) {
  const origins: Record<string, { metadata: number; inference: number }> = {};
  const requests: {
    origin: string;
    model: string;
    credential: 'initial' | 'rotated' | 'none';
    runId: string;
    sequence: number;
  }[] = [];
  let mode = 'normal',
    release: (() => void) | undefined;
  let gate = Promise.resolve();
  const http: HttpClient = {
    async send(request) {
      const url = new URL(request.url),
        origin = url.origin;
      assert.ok([openai, anthropic, local].includes(origin));
      const count = (origins[origin] ??= { metadata: 0, inference: 0 });
      if ((origin === local && url.pathname !== '/api/chat') || request.method === 'GET') {
        count.metadata++;
        if (origin === local) {
          if (mode === 'drift' && url.pathname === '/api/version')
            return response(['{"version":"drift"}']);
          return localMetadata(url);
        }
        return response([
          JSON.stringify(
            origin === openai ? { data: [{ id: 'gpt-5.6-terra' }] } : { id: 'claude-haiku-5-5' },
          ),
        ]);
      }
      count.inference++;
      const body = JSON.parse(request.body!) as { model: string };
      const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
      let row: Record<string, unknown>;
      try {
        row = db
          .prepare(
            "SELECT e.aggregate_id,e.sequence,e.payload FROM events e JOIN command_receipts c ON c.aggregate_id=e.aggregate_id AND c.version=e.sequence WHERE e.type='attempt.model_request_started' ORDER BY e.rowid DESC LIMIT 1",
          )
          .get()!;
        assert.ok(row, 'model start and receipt must precede inference');
        const start = JSON.parse(String(row['payload'])) as {
          activation: { identity: { endpoint: string; modelId: string } };
        };
        assert.equal(start.activation.identity.endpoint, origin);
        assert.equal(start.activation.identity.modelId, body.model);
      } finally {
        db.close();
      }
      const key = request.headers['authorization'] ?? request.headers['x-api-key'];
      requests.push({
        origin,
        model: body.model,
        credential: key?.includes('rotated') ? 'rotated' : key ? 'initial' : 'none',
        runId: String(row['aggregate_id']),
        sequence: Number(row['sequence']),
      });
      const lost = mode === 'lost';
      const chunks =
        origin === local
          ? [
              JSON.stringify({
                model: body.model,
                message: { role: 'assistant', content: 'local answer' },
                done: true,
                done_reason: 'stop',
              }) + '\n',
            ]
          : origin === openai
            ? [
                sse({
                  model: body.model,
                  choices: [{ index: 0, delta: { content: 'openai answer' } }],
                }),
                sse({
                  model: body.model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                }),
                sse({
                  model: body.model,
                  choices: [],
                  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                }),
                'data: [DONE]\n\n',
              ]
            : [
                'event: message_start\ndata: ' +
                  JSON.stringify({
                    type: 'message_start',
                    message: {
                      id: 'msg_fixture',
                      type: 'message',
                      role: 'assistant',
                      model: body.model,
                      content: [],
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                      },
                    },
                  }) +
                  '\n\n',
                'event: content_block_start\ndata: ' +
                  JSON.stringify({
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: 'anthropic answer' },
                  }) +
                  '\n\n',
                'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ];
      return {
        ...response(chunks),
        async *stream() {
          await gate;
          if (lost) throw Error('synthetic lost terminal');
          yield* chunks;
        },
      };
    },
  };
  return {
    http,
    snapshot: () => structuredClone({ origins, requests }),
    mode: (value: string) => {
      mode = value;
    },
    hold: () => {
      gate = new Promise<void>((r) => {
        release = r;
      });
    },
    release: () => release?.(),
  };
}
export type MixedSnapshot = ReturnType<ReturnType<typeof mixedPorts>['snapshot']>;
