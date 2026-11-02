import type { StreamLine } from './types.js';
import { wrap } from './text.js';

const cache = new WeakMap<StreamLine, Map<string, readonly string[]>>();
/** Wrap each immutable entry once per width; hidden reasoning cannot flood the main screen. */
export function transcriptLines(
  stream: readonly StreamLine[],
  width: number,
  thoughts: boolean,
  expandedTools = false,
): string[] {
  return stream.flatMap((entry) => {
    if (entry.kind === 'thought' && !thoughts) return [];
    const key = `${width}:${expandedTools}`;
    let variants = cache.get(entry);
    if (variants === undefined) {
      variants = new Map();
      cache.set(entry, variants);
    }
    const saved = variants.get(key);
    if (saved !== undefined) return saved;
    const label =
      entry.kind === 'user'
        ? 'You'
        : entry.kind === 'text'
          ? (entry.label ?? 'Runne')
          : entry.kind === 'thought'
            ? 'Thinking'
            : 'Tool';
    const text =
      entry.kind === 'tool' && !expandedTools
        ? `  ${entry.text.split('\n')[0] ?? ''} · ${entry.status ?? 'pending'}`
        : `${label}\n${entry.text}`;
    const rows = [...wrap(text, width), ''];
    variants.set(key, rows);
    return rows;
  });
}

/** Scroll offsets count rows above the live bottom; selecting older content stops following. */
export function tailPage(
  lines: readonly string[],
  height: number,
  offset: number,
): readonly string[] {
  const end = lines.length - Math.min(Math.max(0, offset), Math.max(0, lines.length - height));
  return lines.slice(Math.max(0, end - height), end);
}
