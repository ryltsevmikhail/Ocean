import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
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
