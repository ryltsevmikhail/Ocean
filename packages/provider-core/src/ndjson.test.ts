import { expect, it } from 'vitest';
import { parseNdjson } from './ndjson.js';
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const v of values) result.push(v);
  return result;
}
async function* chunks(parts: string[]) {
  yield* parts;
}
it('decodes split LF/CRLF JSON records', async () => {
  expect(await collect(parseNdjson(chunks(['{"a":', '1}\r', '\n{"b":2}\n'])))).toEqual([
    { a: 1 },
    { b: 2 },
  ]);
});
it.each(['{"a":1}', '{broken}\n', '[]\n', '\n'])(
  'refuses incomplete or nonobject framing %j',
  async (body) => {
    await expect(collect(parseNdjson(chunks([body])))).rejects.toThrow();
  },
);
it('bounds records and cumulative bytes', async () => {
  await expect(
    collect(parseNdjson(chunks(['{"a":"' + 'x'.repeat(262144) + '"}\n']))),
  ).rejects.toThrow();
  await expect(
    collect(
      parseNdjson(chunks(Array(40).fill('{"a":"' + 'x'.repeat(220000) + '"}\n') as string[])),
    ),
  ).rejects.toThrow();
});
