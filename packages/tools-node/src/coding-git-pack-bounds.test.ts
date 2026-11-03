import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type * as NodeZlib from 'node:zlib';
import { expect, it, vi } from 'vitest';
vi.mock('node:zlib', async (original) => {
  const actual = await original<typeof NodeZlib>();
  return { ...actual, inflateSync: vi.fn(actual.inflateSync) };
});
import { preflightGitPack } from './coding-git-pack-bounds.js';
function pack(format: 'sha1' | 'sha256', entries: Buffer[], count = entries.length) {
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...entries]);
  return Buffer.concat([body, createHash(format).update(body).digest()]);
}
function variable(size: number) {
  const bytes: number[] = [];
  do {
    let value = size % 128;
    size = Math.floor(size / 128);
    if (size) value |= 128;
    bytes.push(value);
  } while (size);
  return Buffer.from(bytes);
}
it.each(['sha1', 'sha256'] as const)(
  'bounds inflation, delta results, total logical bytes and counts before native Git: %s',
  (format) => {
    const valid = pack(format, [Buffer.concat([Buffer.from([0x31]), deflateSync('x')])]);
    expect(preflightGitPack(valid, format, 1)).toBe(1);
    const delta = (size: number) => {
      const body = Buffer.concat([variable(1), variable(size)]);
      return Buffer.concat([
        Buffer.from([0x70 | body.length]),
        Buffer.alloc(format === 'sha1' ? 20 : 32),
        deflateSync(body),
      ]);
    };
    expect(() => preflightGitPack(pack(format, [delta(67108865)]), format, 1)).toThrow();
    expect(() =>
      preflightGitPack(
        pack(
          format,
          Array.from({ length: 33 }, () => delta(67108864)),
        ),
        format,
        33,
      ),
    ).toThrow();
    // A tiny declared body cannot conceal an inflated body beyond its declared size.
    expect(() =>
      preflightGitPack(
        pack(format, [Buffer.concat([Buffer.from([0x31]), deflateSync('xx')])]),
        format,
        1,
      ),
    ).toThrow();
    const size = 67108865,
      header = [0xb0 | (size & 15)];
    let rest = Math.floor(size / 16);
    do {
      let b = rest % 128;
      rest = Math.floor(rest / 128);
      if (rest) b |= 128;
      header.push(b);
    } while (rest);
    expect(() => preflightGitPack(pack(format, [Buffer.from(header)]), format, 1)).toThrow();
    expect(() => preflightGitPack(pack(format, [], 100001), format, 100001)).toThrow();
    expect(() => preflightGitPack(valid, format, 2)).toThrow();
    valid[valid.length - 1] = valid[valid.length - 1]! ^ 1;
    expect(() => preflightGitPack(valid, format, 1)).toThrow();
  },
);

it.each(['sha1', 'sha256'] as const)(
  'bounds cumulative inflated delta instructions before the next inflation: %s',
  (format) => {
    const body = Buffer.alloc(1024),
      entry = Buffer.concat([
        Buffer.from([0xf0, 0x40]),
        Buffer.alloc(format === 'sha1' ? 20 : 32),
        deflateSync(body),
      ]);
    const entries = [entry, entry, entry];
    // Malformed zero-result programs have no logical charge; native validation comes later.
    vi.mocked(inflateSync).mockClear();
    expect(preflightGitPack(pack(format, entries.slice(0, 2)), format, 2, 2048)).toBe(0);
    expect(inflateSync).toHaveBeenCalledTimes(2);
    vi.mocked(inflateSync).mockClear();
    expect(() => preflightGitPack(pack(format, entries), format, 3, 2048)).toThrow(
      'invalid_coding_git_pack',
    );
    expect(inflateSync).toHaveBeenCalledTimes(2);
    // A caller can only lower the production ceiling, never enlarge it.
    vi.mocked(inflateSync).mockClear();
    expect(() => preflightGitPack(pack(format, [entry]), format, 1, 2147483649)).toThrow();
    expect(inflateSync).not.toHaveBeenCalled();
  },
);
