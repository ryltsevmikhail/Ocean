import type { CodingFileChange, CodingFileContent } from '@runnets/domain';
function lines(value: CodingFileContent | null): string[] {
  if (!value || value.text === '') return [];
  const result = value.text.split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}
/** Full-file unified hunks are bounded and complete; no external diff/textconv is executed. */
export function codingDiff(files: readonly CodingFileChange[]): string {
  return files
    .map((file) => {
      const before = file.before,
        after = file.after,
        a = JSON.stringify('a/' + file.path),
        b = JSON.stringify('b/' + file.path);
      let out = 'diff --git ' + a + ' ' + b + '\n';
      if (!before) out += 'new file mode ' + after!.mode + '\n';
      else if (!after) out += 'deleted file mode ' + before.mode + '\n';
      else if (before.mode !== after.mode)
        out += 'old mode ' + before.mode + '\nnew mode ' + after.mode + '\n';
      if (
        before?.text === after?.text ||
        (!before && after?.text === '') ||
        (!after && before?.text === '')
      )
        return out;
      const old = lines(before),
        next = lines(after);
      out += '--- ' + (before ? a : '/dev/null') + '\n+++ ' + (after ? b : '/dev/null') + '\n';
      out +=
        '@@ -' +
        (old.length ? '1' : '0') +
        ',' +
        old.length +
        ' +' +
        (next.length ? '1' : '0') +
        ',' +
        next.length +
        ' @@\n';
      for (const [content, prefix, body] of [
        [old, '-', before],
        [next, '+', after],
      ] as const) {
        content.forEach((line, index) => {
          out += prefix + line + '\n';
          if (index === content.length - 1 && body && !body.text.endsWith('\n'))
            out += '\\ No newline at end of file\n';
        });
      }
      return out;
    })
    .join('');
}
