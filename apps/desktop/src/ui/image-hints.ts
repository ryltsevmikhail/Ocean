/**
 * Owner-visible image capability hints.
 *
 * Desktop never decides which bytes reach a model; it reflects the runtime
 * provider status so an unsupported model/oversize image is visible before the
 * send and the runtime refusal is explained when it arrives.
 */

import type { Bot } from '../protocol.js';
import { providerStatus } from './provider-state.js';

export interface AttachmentLike {
  readonly kind: string;
  readonly name: string;
}
export interface AttachmentHintInput {
  readonly files: readonly AttachmentLike[];
  readonly members: readonly Bot[];
  readonly group: boolean;
  readonly recipient: string;
  readonly broadcast: string;
}
const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_VISIBLE_SIDE = 8192;

/** Confirmed per-model image input; unknown metadata never claims support. */
export function modelImageInput(model: string | null): boolean {
  if (model === null) return false;
  return (providerStatus.value?.modelCapabilities ?? []).some(
    (capability) => capability.model === model && capability.imageInput,
  );
}
function targetBots(input: AttachmentHintInput): readonly Bot[] {
  if (!input.group) return input.members;
  if (input.recipient === input.broadcast) return input.members;
  if (input.recipient === '') return [];
  return input.members.filter((bot) => bot.handle === input.recipient);
}
function describe(bot: Bot): string {
  return `@${bot.handle} · ${bot.model}`;
}
/** One bounded line under the composer; null when no hint is needed. */
export function attachmentHint(input: AttachmentHintInput): string | null {
  if (input.files.length === 0) return null;
  if (!input.files.some((file) => file.kind === 'image'))
    return 'Файлы сохраняются в комнате. Текст передаётся модели отрывками. Содержимое бинарных файлов модели недоступно.';
  const targets = targetBots(input);
  if (targets.length === 0)
    return 'Заметка: изображения сохраняются в комнате и не отправляются модели.';
  const capable = targets.filter((bot) => modelImageInput(bot.model));
  const unsupported = targets.filter((bot) => !modelImageInput(bot.model));
  if (unsupported.length === 0)
    return `Изображения передаются модели как изображения: ${targets.map(describe).join(', ')}.`;
  if (capable.length === 0 && targets.length === 1)
    return `Модель ${describe(targets[0]!)} не принимает изображения: отправка будет отклонена.`;
  if (capable.length === 0)
    return `Изображения не получат: ${unsupported.map(describe).join(', ')} — их ход будет отклонён как не начатый.`;
  return `Изображения получат: ${capable.map(describe).join(', ')}; не получат: ${unsupported
    .map(describe)
    .join(', ')} — их ход будет отклонён как не начатый.`;
}
/** Local pre-check text; the runtime still owns the trusted 8192-px validation. */
export function imageLimitHint(file: {
  readonly name: string;
  readonly bytes: number;
}): string | null {
  return file.bytes > MAX_FILE_BYTES ? null : null;
}
