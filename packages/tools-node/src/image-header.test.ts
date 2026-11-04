import { describe, expect, it } from 'vitest';
import { parseImageHeader } from './image-header.js';

/** Genuine ImageMagick encodings; the parser must read their real dimensions. */
const TINY: Readonly<Record<string, string>> = {
  'image/png':
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEXAOSuU7d9gAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
  'image/jpeg':
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ABRzT+//2Q==',
  'image/gif': 'R0lGODlhAwACAPAAACeuYAAAACH5BAAAAAAALAAAAAADAAIAAAIChF8AOw==',
  'image/webp':
    'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoDAAIAAgA0JaACdLoB+AADsAD+8Skv/d5v2837eb/ho/+B/WK0qAAA',
  'image/webp-lossless': 'UklGRh4AAABXRUJQVlA4TBEAAAAvBMAAAAdQojq2tf+BiOh/AAA=',
};

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}
function chunk(type: string, payload: Buffer): Buffer {
  return Buffer.concat([u32(payload.length), Buffer.from(type, 'ascii'), payload]);
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngHeader(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return new Uint8Array(Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr)]));
}
function jpegHeader(width: number, height: number): Uint8Array {
  const sof = Buffer.alloc(8);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([255, 216]),
      Buffer.from([255, 224, 0, 16]),
      Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'ascii'),
      Buffer.from([255, 192, 0, 8]),
      sof,
    ]),
  );
}
function webpVp8xHeader(width: number, height: number): Uint8Array {
  const payload = Buffer.alloc(10);
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  const chunkData = Buffer.concat([Buffer.from('VP8X', 'ascii'), u32(10), payload]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunkData.length, 4);
  riff.write('WEBP', 8, 'ascii');
  return new Uint8Array(Buffer.concat([riff, chunkData]));
}

describe('bounded image header parser', () => {
  it('reads the genuine media type and dimensions of real encoded images', () => {
    expect(parseImageHeader(bytes(TINY['image/png']!))).toEqual({
      mediaType: 'image/png',
      width: 3,
      height: 2,
    });
    expect(parseImageHeader(bytes(TINY['image/jpeg']!))).toEqual({
      mediaType: 'image/jpeg',
      width: 3,
      height: 2,
    });
    expect(parseImageHeader(bytes(TINY['image/gif']!))).toEqual({
      mediaType: 'image/gif',
      width: 3,
      height: 2,
    });
    expect(parseImageHeader(bytes(TINY['image/webp']!))).toEqual({
      mediaType: 'image/webp',
      width: 3,
      height: 2,
    });
    expect(parseImageHeader(bytes(TINY['image/webp-lossless']!))).toEqual({
      mediaType: 'image/webp',
      width: 5,
      height: 4,
    });
  });

  it('reads the documented 8192-adjacent boundaries from real container headers', () => {
    expect(parseImageHeader(pngHeader(8192, 1))).toMatchObject({ width: 8192, height: 1 });
    expect(parseImageHeader(pngHeader(8193, 1))).toMatchObject({ width: 8193, height: 1 });
    expect(parseImageHeader(pngHeader(65535, 65535))).toMatchObject({
      width: 65535,
      height: 65535,
    });
    expect(parseImageHeader(jpegHeader(8193, 2))).toMatchObject({ width: 8193, height: 2 });
    expect(parseImageHeader(webpVp8xHeader(9000, 2))).toMatchObject({ width: 9000, height: 2 });
  });

  it('scans bounded JPEG marker segments instead of assuming a fixed SOF offset', () => {
    const longApp = Buffer.alloc(20000, 1);
    const jpeg = Buffer.concat([
      Buffer.from([255, 216]),
      Buffer.from([255, 225]),
      Buffer.from([(longApp.length + 2) >> 8, (longApp.length + 2) & 0xff]),
      longApp,
      Buffer.from(jpegHeader(7, 9)).subarray(2),
    ]);
    expect(parseImageHeader(new Uint8Array(jpeg))).toMatchObject({ width: 7, height: 9 });
  });

  it('returns null for unsupported, truncated, zero-sized or malformed content', () => {
    const bmp = Buffer.from('BM' + '\0'.repeat(40), 'ascii');
    expect(parseImageHeader(new Uint8Array(bmp))).toBeNull();
    expect(parseImageHeader(new Uint8Array(Buffer.from('not an image')))).toBeNull();
    expect(parseImageHeader(new Uint8Array(0))).toBeNull();
    expect(parseImageHeader(new Uint8Array(PNG_SIGNATURE))).toBeNull();
    expect(parseImageHeader(pngHeader(0, 10))).toBeNull();
    const truncatedJpeg = new Uint8Array(Buffer.from([255, 216, 255, 192, 0, 8, 8]));
    expect(parseImageHeader(truncatedJpeg)).toBeNull();
    const gifZero = new Uint8Array(Buffer.from('GIF89a\x00\x00\x00\x00', 'ascii'));
    expect(parseImageHeader(gifZero)).toBeNull();
    // A data URL, host path or caption is never an image header.
    expect(parseImageHeader(new Uint8Array(Buffer.from('/tmp/photo.png', 'utf8')))).toBeNull();
  });
});
