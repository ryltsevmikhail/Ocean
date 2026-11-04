/**
 * Provider-neutral image content contracts.
 *
 * These limits are enforced by the trusted runtime, not by a renderer: the
 * vendor documents four content-detected formats, an 8192-pixel side and a
 * 48 MiB serialized request body. Base64 inflation (4/3) is why the raw-image
 * budget is stricter than the wire budget.
 */

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

/** Documented maximum side for any single inline image. */
export const MAX_IMAGE_SIDE = 8192;
/** The vendor documents 4096 px per side once a request carries 15+ images. */
export const CROWDED_IMAGE_COUNT = 15;
export const MAX_CROWDED_IMAGE_SIDE = 4096;
/** Ocean's unchanged per-file store limit. */
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
/** Summed raw image bytes admitted for one inline request. */
export const MAX_RAW_IMAGE_BYTES = 34 * 1024 * 1024;
/** Application pre-check on the exact UTF-8 serialized body. */
export const REQUEST_PRE_CHECK_BYTES = 47 * 1024 * 1024;
/** Adapter hard gate immediately before any network call. */
export const REQUEST_HARD_LIMIT_BYTES = 48 * 1024 * 1024;

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && IMAGE_MEDIA_TYPES.some((type) => type === value);
}

/**
 * Count UTF-8 bytes the same way `validConversationText` bounds input: lone
 * surrogates are rejected input, so a well-formed string maps to its wire size.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}
