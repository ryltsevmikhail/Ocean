import type { CodingApplyReceipt } from './coding-apply.js';
export function assertCodingApplyTransition(
  previous: CodingApplyReceipt,
  next: CodingApplyReceipt,
): void {
  if (
    JSON.stringify({ ...previous, status: next.status, files: next.files }) !==
      JSON.stringify(next) ||
    previous.status !== 'applying' ||
    previous.files.length !== next.files.length
  )
    throw Error('immutable application receipt');
  for (const [index, file] of previous.files.entries()) {
    const updated = next.files[index]!;
    if (
      file.path !== updated.path ||
      !(
        file.status === updated.status ||
        (file.status === 'pending' && updated.status === 'started') ||
        (file.status === 'started' && ['completed', 'uncertain'].includes(updated.status))
      )
    )
      throw Error('invalid application file transition');
  }
  if (next.status === 'completed' && next.files.some((file) => file.status !== 'completed'))
    throw Error('application has unfinished files');
}
