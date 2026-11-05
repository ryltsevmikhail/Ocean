import { ref, reactive, toRaw } from 'vue';
import type { LocalBoundBot, LocalBotModelBinding } from '../model-protocol.js';
import type { Command } from '../protocol.js';
import { call } from './bridge.js';
import { modelPages } from './model-pages.js';
import { conflictText, settingsError, unknownOutcome, unknownText } from './model-settings-text.js';
type BindingCommand = Extract<Command, { op: 'bot-binding-set' }>;
export function createBotModels(request: typeof call = call) {
  const bots = ref<LocalBoundBot[]>([]),
    message = ref(''),
    stale = ref(true);
  const busy = reactive<Record<string, boolean>>({}),
    errors = reactive<Record<string, string>>({});
  const pending = reactive<Record<string, BindingCommand>>({});
  let generation = 0,
    mutationVersion = 0,
    reads = 0,
    authority = 0;
  async function load() {
    const current = ++generation,
      readContext = authority;
    stale.value = true;
    ++reads;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = mutationVersion;
        const loaded = await modelPages(
          async (after) => {
            const page = await request({
              op: 'bound-bots',
              input: { workspaceId: 'ws_ocean', ...(after ? { after } : {}) },
            });
            if (page.workspaceId !== 'ws_ocean' || page.roomId !== null)
              throw Error('invalid_frame');
            return page;
          },
          (x) => x.bot.id,
        );
        if (current !== generation) return;
        const known = new Map(bots.value.map((item) => [item.bot.id, item]));
        const behind = loaded.some(
          (item) => (known.get(item.bot.id)?.bot.profileVersion ?? 0) > item.bot.profileVersion,
        );
        bots.value = loaded.map((item) => {
          const previous = known.get(item.bot.id);
          return previous && previous.bot.profileVersion > item.bot.profileVersion
            ? previous
            : item;
        });
        if (before === mutationVersion && !behind) {
          stale.value = false;
          return;
        }
      }
      message.value = 'Метаданные ботов устарели; требуется новое чтение.';
    } catch (error) {
      if (current === generation) message.value = settingsError(error);
    } finally {
      if (readContext === authority) --reads;
    }
  }
  async function execute(command: BindingCommand) {
    const id = command.input.botId,
      context = authority;
    if (busy[id] || stale.value) return;
    busy[id] = true;
    errors[id] = '';
    try {
      const result = await request(command);
      if (context !== authority) return;
      if (
        result.bot.id !== id ||
        result.bot.workspaceId !== 'ws_ocean' ||
        result.bot.profileVersion !== command.input.expectedProfileVersion + 1 ||
        result.binding?.connectionId !== command.input.binding.connectionId ||
        result.binding.modelId !== command.input.binding.modelId
      )
        throw Error('outcome_unknown');
      ++mutationVersion;
      bots.value = bots.value.map((x) =>
        x.bot.id === id && x.bot.profileVersion < result.bot.profileVersion ? result : x,
      );
      delete pending[id];
      errors[id] = 'Исходная привязка подтверждена; более новая прочитанная версия сохранена.';
      if (stale.value && reads === 0) await load();
    } catch (error) {
      if (context !== authority) return;
      if (error instanceof Error && error.message === 'bot_profile_version_conflict') {
        await load();
        message.value = conflictText;
        errors[id] = conflictText;
      } else {
        if (unknownOutcome(error)) pending[id] = structuredClone(command);
        errors[id] = pending[id] ? unknownText : settingsError(error);
        if (pending[id]) await load();
      }
    } finally {
      if (context === authority) busy[id] = false;
    }
  }
  async function save(snapshot: LocalBoundBot, binding: LocalBotModelBinding) {
    if (pending[snapshot.bot.id] || !binding.connectionId || !binding.modelId) return;
    await execute({
      op: 'bot-binding-set',
      input: {
        workspaceId: 'ws_ocean',
        requestId: crypto.randomUUID(),
        botId: snapshot.bot.id,
        expectedProfileVersion: snapshot.bot.profileVersion,
        binding: { ...binding },
      },
    });
  }
  async function retry(id: string) {
    const command = pending[id];
    if (command) await execute(structuredClone(toRaw(command)));
  }
  function reset() {
    ++authority;
    ++generation;
    mutationVersion = 0;
    reads = 0;
    bots.value = [];
    stale.value = true;
    message.value = '';
    for (const key of Object.keys(pending)) delete pending[key];
    for (const key of Object.keys(errors)) delete errors[key];
    for (const key of Object.keys(busy)) delete busy[key];
  }
  return { bots, message, stale, busy, errors, pending, load, save, retry, reset };
}

export const botModels = createBotModels();
