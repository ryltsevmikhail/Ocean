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
  let generation = 0;
  async function load() {
    const current = ++generation;
    stale.value = true;
    try {
      const loaded = await modelPages(
        async (after) => {
          const page = await request({
            op: 'bound-bots',
            input: { workspaceId: 'ws_ocean', ...(after ? { after } : {}) },
          });
          if (page.workspaceId !== 'ws_ocean' || page.roomId !== null) throw Error('invalid_frame');
          return page;
        },
        (x) => x.bot.id,
      );
      if (current !== generation) return;
      bots.value = loaded;
      stale.value = false;
    } catch (error) {
      if (current === generation) message.value = settingsError(error);
    }
  }
  async function execute(command: BindingCommand) {
    const id = command.input.botId;
    if (busy[id] || stale.value) return;
    busy[id] = true;
    errors[id] = '';
    try {
      const result = await request(command);
      if (
        result.bot.id !== id ||
        result.bot.workspaceId !== 'ws_ocean' ||
        result.bot.profileVersion !== command.input.expectedProfileVersion + 1 ||
        result.binding?.connectionId !== command.input.binding.connectionId ||
        result.binding.modelId !== command.input.binding.modelId
      )
        throw Error('outcome_unknown');
      ++generation; // A page begun before this committed mutation cannot replace its snapshot.
      bots.value = bots.value.map((x) => (x.bot.id === id ? result : x));
      delete pending[id];
      errors[id] = 'Привязка этого бота сохранена.';
    } catch (error) {
      if (error instanceof Error && error.message === 'bot_profile_version_conflict') {
        delete pending[id];
        await load();
        message.value = conflictText;
        errors[id] = conflictText;
      } else {
        if (unknownOutcome(error)) pending[id] = structuredClone(command);
        errors[id] = pending[id] ? unknownText : settingsError(error);
        if (pending[id]) await load();
      }
    } finally {
      busy[id] = false;
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
  return { bots, message, stale, busy, errors, pending, load, save, retry };
}

export const botModels = createBotModels();
