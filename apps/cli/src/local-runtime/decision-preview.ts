import { createHash } from 'node:crypto';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Preserve control characters as visible, reversible JSON escapes in owner previews. */
export function ownerPreview(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
