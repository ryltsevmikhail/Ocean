/**
 * Bounded image header parser.
 *
 * Runs in the trusted runtime (never in the renderer): it confirms the actual
 * format by magic bytes and reads the declared dimensions from the container
 * header. No image library, no decode, no memory proportional to the image.
 */

import type { ImageMediaType } from '@runnets/domain';

export interface ImageHeader {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}
/** Marker scanning is bounded so a hostile stream cannot force a long walk. */
const MAX_SCAN = 262144;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const GIF_HEADERS = ['GIF87a', 'GIF89a'] as const;

function ascii(data: Uint8Array, offset: number, length: number): string {
  if (offset + length > data.length) return '';
  let text = '';
  for (let index = 0; index < length; index++) text += String.fromCharCode(data[offset + index]!);
  return text;
}
function u16be(data: Uint8Array, offset: number): number | null {
  if (offset + 2 > data.length) return null;
  return (data[offset]! << 8) | data[offset + 1]!;
}
function u16le(data: Uint8Array, offset: number): number | null {
  if (offset + 2 > data.length) return null;
  return data[offset]! | (data[offset + 1]! << 8);
}
function u32be(data: Uint8Array, offset: number): number | null {
  if (offset + 4 > data.length) return null;
  return (
    data[offset]! * 0x1000000 +
    (data[offset + 1]! << 16) +
    (data[offset + 2]! << 8) +
    data[offset + 3]!
  );
}
function u24le(data: Uint8Array, offset: number): number | null {
  if (offset + 3 > data.length) return null;
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}
function dimensions(width: number | null, height: number | null): ImageHeader | null {
  return width === null || height === null || width < 1 || height < 1
    ? null
    : { mediaType: 'image/png', width, height };
}
function sized(mediaType: ImageMediaType, width: number | null, height: number | null) {
  return width === null || height === null || width < 1 || height < 1
    ? null
    : { mediaType, width, height };
}

function parsePng(data: Uint8Array): ImageHeader | null {
  if (data.length < 16) return null;
  if (PNG_SIGNATURE.some((byte, index) => data[index] !== byte)) return null;
  if (ascii(data, 12, 4) !== 'IHDR') return null;
  return dimensions(u32be(data, 16), u32be(data, 20));
}
function parseGif(data: Uint8Array): ImageHeader | null {
  if (!GIF_HEADERS.some((header) => ascii(data, 0, 6) === header)) return null;
  return sized('image/gif', u16le(data, 6), u16le(data, 8));
}
function parseJpeg(data: Uint8Array): ImageHeader | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  const end = Math.min(data.length, MAX_SCAN);
  while (offset + 4 <= end) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = data[offset + 1]!;
    // Fill bytes and standalone markers carry no length field.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16be(data, offset + 2);
    if (length === null || length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      // SOF payload: precision, height, width, components...
      if (offset + 9 > end) return null;
      return sized('image/jpeg', u16be(data, offset + 7), u16be(data, offset + 5));
    }
    offset += 2 + length;
  }
  return null;
}
function parseWebp(data: Uint8Array): ImageHeader | null {
  if (ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP') return null;
  const fourcc = ascii(data, 12, 4);
  if (fourcc === 'VP8X') {
    if (data.length < 30) return null;
    return sized('image/webp', (u24le(data, 24) ?? 0) + 1, (u24le(data, 27) ?? 0) + 1);
  }
  if (fourcc === 'VP8 ') {
    // Frame tag (3 bytes), start code 0x9d 0x01 0x2a, then 14-bit width/height.
    if (data.length < 30) return null;
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    const width = u16le(data, 26);
    const height = u16le(data, 28);
    return sized(
      'image/webp',
      width === null ? null : width & 0x3fff,
      height === null ? null : height & 0x3fff,
    );
  }
  if (fourcc === 'VP8L') {
    if (data.length < 25 || data[20] !== 0x2f) return null;
    const bits = (data[21]! | (data[22]! << 8) | (data[23]! << 16) | (data[24]! << 24)) >>> 0;
    return sized('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  return null;
}

/** Detect magic bytes and read dimensions; null means "not a supported image". */
export function parseImageHeader(data: Uint8Array): ImageHeader | null {
  if (data.length < 12) return null;
  if (data[0] === 137 && data[1] === 80) return parsePng(data);
  if (data[0] === 0xff && data[1] === 0xd8) return parseJpeg(data);
  if (data[0] === 0x47 && data[1] === 0x49) return parseGif(data);
  if (data[0] === 0x52 && data[1] === 0x49) return parseWebp(data);
  return null;
}
