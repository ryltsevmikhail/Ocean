import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
export const invalidGitPack = (): never => {
  throw Error('invalid_coding_git_pack');
};
/** Separately bound total entry inflation and reconstructed delta result sizes before Git. */
export function preflightGitPack(
  pack: Buffer,
  format: 'sha1' | 'sha256',
  count: number,
  inflatedLimit = 2147483648,
  charge?: (bytes: number) => void,
): number {
  const oidBytes = format === 'sha1' ? 20 : 32,
    end = pack.length - oidBytes;
  if (
    !Number.isSafeInteger(inflatedLimit) ||
    inflatedLimit < 0 ||
    inflatedLimit > 2147483648 ||
    pack.length > 268435456 ||
    end < 12 ||
    pack.subarray(0, 4).toString() !== 'PACK' ||
    ![2, 3].includes(pack.readUInt32BE(4)) ||
    pack.readUInt32BE(8) !== count ||
    count < 1 ||
    count > 100000 ||
    !createHash(format).update(pack.subarray(0, end)).digest().equals(pack.subarray(end))
  )
    return invalidGitPack();
  let offset = 12,
    logical = 0,
    inflated = 0;
  const entries = new Set<number>();
  const byte = () => {
    if (offset >= end) return invalidGitPack();
    return pack[offset++]!;
  };
  for (let n = 0; n < count; n++) {
    const start = offset;
    entries.add(start);
    let value = byte(),
      size = value & 15,
      shift = 4;
    const type = (value >> 4) & 7;
    while (value & 128) {
      value = byte();
      size += (value & 127) * 2 ** shift;
      shift += 7;
      if (shift > 53 || !Number.isSafeInteger(size) || size > 67108864) return invalidGitPack();
    }
    if (![1, 2, 3, 4, 6, 7].includes(type)) return invalidGitPack();
    // Charge the declared entry bytes before inflation, including delta instructions.
    // A lowered ceiling permits bounded callers/tests; it cannot relax the production limit.
    inflated += size;
    charge?.(Math.max(inflated, logical));
    if (inflated > inflatedLimit) return invalidGitPack();
    if (type === 6) {
      let part = byte(),
        distance = part & 127,
        steps = 1;
      while (part & 128) {
        part = byte();
        distance = (distance + 1) * 128 + (part & 127);
        if (++steps > 8 || !Number.isSafeInteger(distance)) return invalidGitPack();
      }
      if (distance === 0 || !entries.has(start - distance)) return invalidGitPack();
    }
    if (type === 7) {
      offset += oidBytes;
      if (offset >= end) return invalidGitPack();
    }
    // Node's info result is not reflected in @types/node's inflateSync return type.
    const decoded = inflateSync(pack.subarray(offset, end), {
      info: true,
      maxOutputLength: size + 1,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = decoded.engine.bytesWritten;
    if (
      !Buffer.isBuffer(decoded.buffer) ||
      decoded.buffer.length !== size ||
      !Number.isSafeInteger(consumed) ||
      consumed <= 0 ||
      offset + consumed > end
    )
      return invalidGitPack();
    offset += consumed;
    let objectSize = size;
    if (type === 6 || type === 7) {
      let cursor = 0;
      const deltaSize = () => {
        let result = 0,
          bit = 0,
          part: number;
        do {
          if (cursor >= decoded.buffer.length || bit > 49) return invalidGitPack();
          part = decoded.buffer[cursor++]!;
          result += (part & 127) * 2 ** bit;
          bit += 7;
        } while (part & 128);
        if (!Number.isSafeInteger(result) || result > 67108864) return invalidGitPack();
        return result;
      };
      deltaSize();
      objectSize = deltaSize();
    }
    logical += objectSize;
    charge?.(Math.max(inflated, logical));
    if (logical > 2147483648) return invalidGitPack();
  }
  if (offset !== end) return invalidGitPack();
  return logical;
}
