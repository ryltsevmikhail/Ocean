import { gzipSync } from 'node:zlib';
/** Small regular-file-only ustar writer: no links, devices or arbitrary input trees. */
export function createArchive(files: ReadonlyMap<string, { body: Buffer; mode: number }>): Buffer {
  const parts: Buffer[] = [];
  for (const [path, { body, mode }] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const header = Buffer.alloc(512);
    const split = path.lastIndexOf('/');
    const name = Buffer.byteLength(path) <= 100 ? path : path.slice(split + 1);
    const prefix = Buffer.byteLength(path) <= 100 ? '' : path.slice(0, split);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
      throw new Error('archive_path_too_long');
    header.write(name, 0, 100, 'utf8');
    header.write(prefix, 345, 155, 'utf8');
    const oct = (value: number, start: number, length: number) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii');
    oct(mode, 100, 8);
    oct(0, 108, 8);
    oct(0, 116, 8);
    oct(body.length, 124, 12);
    oct(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    oct(
      header.reduce((a, b) => a + b, 0),
      148,
      8,
    );
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
