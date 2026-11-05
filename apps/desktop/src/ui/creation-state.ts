import { ref, toRaw } from 'vue';
import { submitCreation, type RoomCreateDraft } from './room-create.js';
import { call } from './bridge.js';
import { pages } from './room-feed.js';
import { modelPages } from './model-pages.js';
import { settingsError, unknownOutcome, unknownText } from './model-settings-text.js';
async function readCreationMetadata(draft: RoomCreateDraft) {
  if (draft.dialog === 'bot' && draft.binding) {
    await modelPages(
      async (after) => {
        const page = await call({
          op: 'bound-bots',
          input: { workspaceId: 'ws_ocean', ...(after ? { after } : {}) },
        });
        if (page.workspaceId !== 'ws_ocean' || page.roomId !== null) throw Error('invalid_frame');
        return page;
      },
      (item) => item.bot.id,
    );
  } else if (draft.dialog === 'bot')
    await pages(
      (after: string | undefined) => call({ op: 'bots', after }),
      (item) => item.id,
    );
  else
    await pages(
      (after: string | undefined) => call({ op: 'rooms', after }),
      (item) => item.id,
    );
}
/** One keyless original creation survives modal close and uncertain acknowledgements. */
export function createCreationState(
  send: (draft: RoomCreateDraft) => Promise<string | null> = (draft) => submitCreation(draft, call),
  read: (draft: RoomCreateDraft) => Promise<unknown> = readCreationMetadata,
) {
  const pending = ref<RoomCreateDraft | null>(null),
    stale = ref(false),
    message = ref(''),
    busy = ref(false);
  async function refresh() {
    if (!pending.value) return;
    stale.value = true;
    try {
      await read(toRaw(pending.value));
      stale.value = false;
    } catch (error) {
      message.value = settingsError(error);
    }
  }
  async function execute(original: RoomCreateDraft) {
    if (busy.value) return null;
    busy.value = true;
    try {
      const roomId = await send(original);
      pending.value = null;
      message.value = '';
      return { roomId };
    } catch (error) {
      if (!unknownOutcome(error)) throw error;
      pending.value = original;
      await refresh();
      message.value = unknownText;
      return null;
    } finally {
      busy.value = false;
    }
  }
  async function submit(draft: RoomCreateDraft) {
    if (pending.value) return null;
    return execute({
      ...structuredClone(toRaw(draft)),
      requestId: draft.requestId ?? crypto.randomUUID(),
    });
  }
  async function recover() {
    if (!pending.value || stale.value) return null;
    return execute(structuredClone(toRaw(pending.value)));
  }
  return { pending, stale, message, busy, submit, recover, refresh };
}
