import { graphemes } from './text.js';
import type { Key } from './keys.js';

export interface Draft {
  readonly prompt: string;
  readonly cursor: number;
}

/** Edit at a grapheme boundary; arrows and deletion never corrupt Unicode input. */
export function editDraft(draft: Draft, key: Key, maximum: number): Draft {
  const cursor = Math.min(draft.prompt.length, Math.max(0, draft.cursor));
  const before = draft.prompt.slice(0, cursor);
  const after = draft.prompt.slice(cursor);
  if (key.type === 'home') return { ...draft, cursor: 0 };
  if (key.type === 'end') return { ...draft, cursor: draft.prompt.length };
  if (key.type === 'left')
    return { ...draft, cursor: cursor - (graphemes(before).at(-1)?.length ?? 0) };
  if (key.type === 'right')
    return { ...draft, cursor: cursor + (graphemes(after)[0]?.length ?? 0) };
  if (key.type === 'backspace') {
    const length = graphemes(before).at(-1)?.length ?? 0;
    return { prompt: before.slice(0, before.length - length) + after, cursor: cursor - length };
  }
  if (key.type === 'char' || key.type === 'paste' || key.type === 'newline') {
    const raw = key.type === 'char' ? key.value : key.type === 'paste' ? key.text : '\n';
    let inserted = '';
    for (const char of graphemes(raw)) {
      if (draft.prompt.length + inserted.length + char.length > maximum) break;
      inserted += char;
    }
    return { prompt: before + inserted + after, cursor: cursor + inserted.length };
  }
  return draft;
}
