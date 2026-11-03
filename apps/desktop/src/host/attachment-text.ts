/** Decode a bounded UTF-8 prefix without mistaking a truncated final code point for binary. */
export function attachmentText(data: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, 12000), {
      stream: data.length > 12000,
    });
    return text.includes(String.fromCharCode(0)) ? undefined : text.slice(0, 6000);
  } catch {
    return undefined;
  }
}
