/**
 * Durable plugin operation journal model.
 *
 * One row records exactly one admitted plugin invocation: its immutable target
 * binding (plugin, connection, generation, endpoint), the exact tool and
 * resource constraint, an argument digest plus a bounded secret-free argument
 * copy, the settled state and a bounded result summary. The row never carries a
 * credential value or a raw provider payload.
 *
 * The RC2 pilot limits live here so every host reads the same numbers:
 * at most 16 plugin calls per turn and at most 32 KiB of model-visible tool
 * output, including the explicit truncation marker.
 */

/** Exact per-turn plugin call cap; the next call is refused visibly. */
export const PLUGIN_MAX_CALLS_PER_TURN = 16;

/** Exact model-visible plugin tool output bound in UTF-8 bytes (32 KiB). */
export const PLUGIN_MAX_MODEL_OUTPUT_BYTES = 32 * 1024;

/** Stored argument copy bound; the digest covers the full canonical arguments. */
export const PLUGIN_MAX_OPERATION_ARGUMENT_BYTES = 4096;

/** Stored result summary bound; the model-visible text may be larger. */
export const PLUGIN_MAX_OPERATION_SUMMARY_BYTES = 8192;

/** Longest accepted operation/invocation identity. */
export const PLUGIN_MAX_OPERATION_ID_LENGTH = 256;

/**
 * `started` — journaled and claimed, dispatch may have begun.
 * `observed` — a business result came back (`ok`).
 * `failed` — a business result came back and said it failed (`vendor_error`).
 * `not_started` — the adapter proved before dispatch that nothing was sent.
 * `uncertain` — the effect may exist and is not known; never retried.
 * `acknowledged` — the owner explicitly acknowledged an uncertain record; the
 *   original uncertainty is preserved and no remote certainty is claimed.
 */
export type PluginOperationState =
  'started' | 'observed' | 'failed' | 'not_started' | 'uncertain' | 'acknowledged';

export const PLUGIN_OPERATION_STATES: readonly PluginOperationState[] = Object.freeze([
  'started',
  'observed',
  'failed',
  'not_started',
  'uncertain',
  'acknowledged',
]);

export function validPluginOperationState(value: unknown): value is PluginOperationState {
  return (
    typeof value === 'string' && (PLUGIN_OPERATION_STATES as readonly string[]).includes(value)
  );
}

/** A terminal state never changes again except the explicit owner acknowledgement. */
export function pluginOperationTerminal(state: PluginOperationState): boolean {
  return state === 'observed' || state === 'failed' || state === 'not_started';
}

/** One durable admitted plugin invocation. */
export interface PluginOperationRecord {
  /** Invocation identity; also the durable tool-journal claim identity. */
  readonly id: string;
  readonly taskRunId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly botId: string;
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  /** Immutable endpoint binding resolved from the connection row, never model arguments. */
  readonly endpoint: string;
  readonly tool: string;
  readonly repository: string;
  readonly schemaDigest: string;
  /** Lowercase SHA-256 over the canonical arguments (never a secret). */
  readonly argumentsDigest: string;
  /** Bounded canonical arguments for owner inspection. */
  readonly arguments: string;
  readonly state: PluginOperationState;
  /** Adapter outcome code (`ok`, `vendor_error`, `deadline_exceeded`, …) once settled. */
  readonly outcomeCode: string | null;
  /** Bounded, secret-free diagnostic. */
  readonly detail: string | null;
  /** Bounded model-visible result summary; never a raw provider payload. */
  readonly resultSummary: string | null;
  /** Model-visible output size in UTF-8 bytes before truncation (null until settled). */
  readonly resultBytes: number | null;
  readonly truncated: boolean;
  /** Monotonic revision; an owner acknowledgement is a compare-and-set on it. */
  readonly revision: number;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedReason: string | null;
}

const ID = /^[A-Za-z0-9_:.#-]{1,256}$/;

export function validPluginOperationId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function validPluginToolName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value);
}

/** UTF-8 byte length without touching a platform buffer implementation. */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Prefix of `text` whose UTF-8 encoding is at most `limit` bytes (code-point safe). */
export function sliceTextByBytes(text: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = utf8Bytes(character);
    if (bytes + size > limit) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

/** The exact model-visible truncation marker; its byte length is part of the bound. */
export function pluginTruncationMarker(keptBytes: number, totalBytes: number): string {
  return `\n[truncated: kept ${keptBytes} of ${totalBytes} bytes]`;
}

export interface PluginOutputTruncation {
  readonly text: string;
  readonly truncated: boolean;
  /** Bytes of the original text. */
  readonly totalBytes: number;
  /** Bytes of the original text kept before the marker. */
  readonly keptBytes: number;
}

/**
 * Bound one model-visible plugin result to `maxBytes` UTF-8 bytes.
 *
 * When the text does not fit, the returned string keeps a code-point-safe
 * prefix plus the explicit marker, and the total (prefix + marker) stays within
 * the bound. Byte counting is UTF-8, so multibyte output cannot exceed it.
 */
export function truncatePluginOutput(
  text: string,
  maxBytes: number = PLUGIN_MAX_MODEL_OUTPUT_BYTES,
): PluginOutputTruncation {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes');
  const totalBytes = utf8Bytes(text);
  if (totalBytes <= maxBytes) return { text, truncated: false, totalBytes, keptBytes: totalBytes };
  let kept = sliceTextByBytes(
    text,
    Math.max(0, maxBytes - pluginTruncationMarker(0, totalBytes).length),
  );
  for (let attempt = 0; attempt < 8; attempt++) {
    const keptBytes = utf8Bytes(kept);
    const budget = maxBytes - utf8Bytes(pluginTruncationMarker(keptBytes, totalBytes));
    const next = sliceTextByBytes(text, Math.max(0, budget));
    if (next === kept) break;
    kept = next;
  }
  const keptBytes = utf8Bytes(kept);
  return {
    text: kept + pluginTruncationMarker(keptBytes, totalBytes),
    truncated: true,
    totalBytes,
    keptBytes,
  };
}

/** Bounded single-line diagnostic: collapse whitespace and cut on a byte budget. */
export function boundPluginDetail(detail: string, maxBytes = 512): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  if (utf8Bytes(flat) <= maxBytes) return flat;
  const kept = sliceTextByBytes(flat, maxBytes).trimEnd();
  return kept + '…';
}

/** Bounded stored argument copy; the digest remains authoritative for the full value. */
export function boundPluginArguments(
  canonical: string,
  maxBytes: number = PLUGIN_MAX_OPERATION_ARGUMENT_BYTES,
): string {
  if (utf8Bytes(canonical) <= maxBytes) return canonical;
  return JSON.stringify({ truncated: true, bytes: utf8Bytes(canonical) });
}
