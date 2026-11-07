import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { httpFixture } from '../dist/prototype-http-fixture.js';

const proof = process.argv[2]!;
const partial = ['partial', 'unconfirmed'].includes(process.argv[3] ?? '');
const unconfirmed = process.argv[3] === 'unconfirmed';
const listeners: Awaited<ReturnType<typeof httpFixture>>[] = [];
async function close() {
  const results = await Promise.allSettled(listeners.map((listener) => listener.close()));
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [String(result.reason)] : [],
  );
  if (unconfirmed) errors.push('injected retirement unconfirmed');
  writeFileSync(
    join(proof, 'http-cleanup.json'),
    JSON.stringify({ errors, count: listeners.length }),
  );
  if (errors.length) throw Error('HTTP listener retirement unconfirmed');
}
try {
  for (let n = 0; n < 7; n++) {
    if (partial && n === 1) throw Error('injected listener failure');
    const listener = await httpFixture('normal', undefined, 60000);
    listeners.push(listener);
    if (partial) writeFileSync(join(proof, 'partial-url.txt'), listener.url.href);
  }
  process.send!({ ready: listeners.map((listener) => listener.url.href) });
  process.on('message', (message: { id: number; method: string }) => {
    void (async () => {
      if (message.method === 'stats') return listeners.map((listener) => listener.stats);
      if (message.method === 'close') return await close();
      throw Error('unknown_method');
    })().then(
      (result) => process.send!({ id: message.id, result }),
      (error: unknown) => process.send!({ id: message.id, error: String(error) }),
    );
  });
} catch (error) {
  try {
    await close();
  } catch {
    /* cleanup evidence is retained */
  }
  throw error;
}
