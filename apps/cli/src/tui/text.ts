/** Terminal text helpers measure displayed cells rather than UTF-16 code units. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Strip controls supplied by models/files while preserving ordinary whitespace. */
export function terminalText(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159));
    })
    .join('');
}

/** Keep combining marks, emoji and surrogate pairs together in editing and wrapping. */
export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((segment) => segment.segment);
}

function cells(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (/^\p{Mark}+$/u.test(char)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(char)) return 2;
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000)
    ? 2
    : 1;
}

/** Width of sanitized printable text in terminal cells. */
export function displayWidth(text: string): number {
  return graphemes(terminalText(text)).reduce((sum, char) => sum + cells(char), 0);
}

/** Fit exactly one row, clipping whole graphemes and padding its unused cells. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const flat = terminalText(text).replace(/[\r\n\t]/g, ' ');
  let used = 0;
  let result = '';
  for (const char of graphemes(flat)) {
    const size = cells(char);
    if (used + size > width) break;
    result += char;
    used += size;
  }
  return result + ' '.repeat(Math.max(0, width - used));
}

/** Wrap complete lines without executing controls or splitting a displayed character. */
export function wrap(text: string, width: number): string[] {
  const maximum = Math.max(2, width);
  return terminalText(text)
    .replace(/\r\n?/g, '\n')
    .replaceAll('\t', '  ')
    .split('\n')
    .flatMap((line) => {
      const lines: string[] = [];
      let row = '';
      let used = 0;
      for (const char of graphemes(line)) {
        const size = cells(char);
        if (used + size > maximum) {
          lines.push(row);
          row = '';
          used = 0;
        }
        row += char;
        used += size;
      }
      lines.push(row);
      return lines;
    });
}
