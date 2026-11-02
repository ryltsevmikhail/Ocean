import process from 'node:process';
// Loaded only by the smoke test's external Node process.
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
globalThis.fetch = async (_url, options) => {
  const { messages } = JSON.parse(options.body);
  const last = messages.at(-1).content;
  appendFileSync(process.env.OCEAN_TEST_LOG, JSON.stringify(messages) + '\n');
  if (last.includes('slow-turn')) await setTimeout(60000, null, { signal: options.signal });
  const text = 'Test provider · ' + last;
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
