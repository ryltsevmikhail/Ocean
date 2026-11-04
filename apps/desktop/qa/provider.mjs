import process from 'node:process';
// Loaded only by the isolated fixture owner's Node process.
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
globalThis.fetch = async (url, options = {}) => {
  // Model discovery is the only non-inference vendor request Task 1 may issue.
  if (String(url).endsWith('/models')) {
    if (process.env.OCEAN_TEST_MODEL_LOG === '1')
      appendFileSync(process.env.OCEAN_TEST_LOG, JSON.stringify({ models: true }) + '\n');
    if (String(options.method ?? 'GET') !== 'GET')
      return new globalThis.Response('{"error":{"message":"method"}}', { status: 405 });
    return new globalThis.Response(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-flash', input_modalities: ['text', 'image'] },
          { id: 'deepseek-v4-pro', input_modalities: ['text'] },
        ],
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
  const { messages } = JSON.parse(options.body);
  const last = messages.at(-1).content;
  appendFileSync(process.env.OCEAN_TEST_LOG, JSON.stringify(messages) + '\n');
  if (last.includes('slow-turn')) await setTimeout(60000, null, { signal: options.signal });
  if (last.startsWith('detach-turn'))
    while (!existsSync(process.env.OCEAN_TEST_LOG + '.release'))
      await setTimeout(50, null, { signal: options.signal });
  const text = 'Test provider · ' + (last.startsWith('detach-turn') ? 'detach-turn' : last);
  const chunks = [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
  ];
  return new globalThis.Response(
    chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
};
