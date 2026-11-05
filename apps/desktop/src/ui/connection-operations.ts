import type { Ref } from 'vue';
import type { LocalModelConnectionMetadata } from '../model-protocol.js';
import type { call } from './bridge.js';
import { conflictText, settingsError, unknownOutcome, unknownText } from './model-settings-text.js';
import { keyless, type ConnectionMutation } from './model-settings-recovery.js';
import type { createConnectionIntents } from './connection-intents.js';
interface Context {
  readonly busy: Ref<boolean>;
  readonly stale: Ref<boolean>;
  readonly message: Ref<string>;
  readonly connections: Ref<LocalModelConnectionMetadata[]>;
  readonly load: () => Promise<void>;
  readonly select: (id: string) => void;
  readonly intents: ReturnType<typeof createConnectionIntents>;
}
/** A receipt settles its exact original; refreshed metadata is the current authority. */
export function connectionOperations(request: typeof call, context: Context) {
  return async function mutate(command: ConnectionMutation, id: string, recovering = false) {
    const { busy, stale, message, intents, load, select, connections } = context;
    if (busy.value || stale.value) return;
    const original = keyless(command, id);
    if (!intents.accepts(original)) {
      message.value = 'На этом подключении сохранён другой исходный запрос. Его нельзя заменить.';
      return;
    }
    const retainedBefore = intents.entries.has(id);
    intents.retain(original);
    busy.value = true;
    message.value = '';
    try {
      const result = await request(command);
      if ('connectionId' in result && result.connectionId !== id) throw Error('outcome_unknown');
      intents.acknowledge(original);
      await load();
      select(id);
      message.value = stale.value
        ? 'Операция подтверждена; метаданные прочитать не удалось. Редактирование заблокировано.'
        : 'Исходная операция подтверждена; текущее состояние прочитано отдельно. Отключение не отменяет запуски и не отзывает ключ.';
    } catch (error) {
      const unknown =
        unknownOutcome(error) ||
        (error instanceof Error && error.message === 'provider_write_failed');
      if (!retainedBefore && !recovering && !unknown) intents.acknowledge(original);
      await load();
      select(id);
      const retained = intents.entries.has(id);
      if (retained) message.value = unknownText;
      else if (error instanceof Error && error.message === 'revision_conflict') {
        message.value = stale.value
          ? 'Конфликт версии. Чтение не удалось; редактирование заблокировано.'
          : connections.value.some((x) => x.connectionId === id)
            ? conflictText
            : `Конфликт версии. Подключение ${id} отсутствует в обновлённых метаданных. Подтвердите новое действие явно.`;
      } else message.value = settingsError(error);
    } finally {
      busy.value = false;
    }
  };
}
