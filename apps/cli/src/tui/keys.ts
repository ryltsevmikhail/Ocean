/** Raw keys and bracketed paste: pasted newlines are text, never submit actions. */
export type Panel = 'runs' | 'events' | 'details' | 'help';
export type Key =
  | { readonly type: 'char'; readonly value: string }
  | { readonly type: 'paste'; readonly text: string }
  | { readonly type: 'panel'; readonly panel: Panel }
  | {
      readonly type:
        | 'enter'
        | 'newline'
        | 'tab'
        | 'shift-tab'
        | 'backspace'
        | 'escape'
        | 'up'
        | 'down'
        | 'left'
        | 'right'
        | 'ctrl-c'
        | 'page-up'
        | 'page-down'
        | 'home'
        | 'end'
        | 'toggle-thoughts'
        | 'unknown';
    };
export interface DecodedKeys {
  readonly keys: readonly Key[];
  readonly rest: string;
}
const ESC = '\u001b';
const BEGIN_PASTE = `${ESC}[200~`;
const END_PASTE = `${ESC}[201~`;
const SEQUENCES: Readonly<Record<string, Key>> = {
  '[A': { type: 'up' },
  '[B': { type: 'down' },
  '[C': { type: 'right' },
  '[D': { type: 'left' },
  '[Z': { type: 'shift-tab' },
  '[5~': { type: 'page-up' },
  '[6~': { type: 'page-down' },
  '[H': { type: 'home' },
  '[1~': { type: 'home' },
  '[F': { type: 'end' },
  '[4~': { type: 'end' },
  OP: { type: 'panel', panel: 'help' },
  OQ: { type: 'panel', panel: 'runs' },
  OR: { type: 'panel', panel: 'events' },
  OS: { type: 'panel', panel: 'details' },
  '[11~': { type: 'panel', panel: 'help' },
  '[12~': { type: 'panel', panel: 'runs' },
  '[13~': { type: 'panel', panel: 'events' },
  '[14~': { type: 'panel', panel: 'details' },
  '[15~': { type: 'toggle-thoughts' },
  '[13;2u': { type: 'newline' },
};
function control(character: string): Key {
  if (character === '\r') return { type: 'enter' };
  if (character === '\n') return { type: 'newline' };
  if (character === '\t') return { type: 'tab' };
  if (character === '\x7f' || character === '\b') return { type: 'backspace' };
  if (character === '\x03') return { type: 'ctrl-c' };
  if (character === '\x01') return { type: 'home' };
  if (character === '\x05') return { type: 'end' };
  return character >= ' ' ? { type: 'char', value: character } : { type: 'unknown' };
}

/** Decode one chunk; carry bounded partial CSI/paste input into the next chunk. */
export function decodeKeys(chunk: string, flushEscape = true): DecodedKeys {
  const keys: Key[] = [];
  let index = 0;
  while (index < chunk.length) {
    const rest = chunk.slice(index);
    if (rest.startsWith(BEGIN_PASTE)) {
      const end = rest.indexOf(END_PASTE, BEGIN_PASTE.length);
      if (end < 0) {
        const content = rest.slice(BEGIN_PASTE.length);
        const suffix =
          Array.from({ length: END_PASTE.length - 1 }, (_, n) => END_PASTE.slice(0, n + 1))
            .filter((part) => content.endsWith(part))
            .at(-1) ?? '';
        return {
          keys,
          rest: BEGIN_PASTE + content.slice(0, 2000) + (content.length > 2000 ? suffix : ''),
        };
      }
      keys.push({ type: 'paste', text: rest.slice(BEGIN_PASTE.length, end).slice(0, 2000) });
      index += end + END_PASTE.length;
      continue;
    }
    if (rest.startsWith(`${ESC}[`) || rest.startsWith(`${ESC}O`)) {
      const end = rest.startsWith(`${ESC}O`)
        ? rest.length >= 3
          ? 2
          : -1
        : [...rest].findIndex((char, n) => n >= 2 && char >= '@' && char <= '~');
      if (end < 0) return { keys, rest };
      keys.push(SEQUENCES[rest.slice(1, end + 1)] ?? { type: 'unknown' });
      index += end + 1;
      continue;
    }
    if (rest === ESC && !flushEscape) return { keys, rest };
    if (rest.startsWith(ESC)) {
      if (rest.startsWith(`${ESC}\r`)) {
        keys.push({ type: 'newline' });
        index += 2;
      } else {
        keys.push({ type: 'escape' });
        index++;
      }
      continue;
    }
    const code = rest.codePointAt(0);
    if (code === undefined) break;
    const character = String.fromCodePoint(code);
    keys.push(control(character));
    index += character.length;
  }
  return { keys, rest: '' };
}
