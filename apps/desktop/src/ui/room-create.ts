import type { call } from './bridge.js';
import type { LocalBotModelBinding } from '../model-protocol.js';

/** The bridge's validated call signature; injected so this flow is testable without a DOM. */
export type CreateCall = typeof call;
export type CreateDialog = 'room' | 'bot';
export interface RoomCreateDraft {
  readonly dialog: CreateDialog;
  readonly kind: 'group' | 'direct';
  readonly selected: readonly string[];
  readonly title: string;
  readonly handle: string;
  readonly name: string;
  readonly role: string;
  readonly model: string;
  readonly binding?: LocalBotModelBinding;
  readonly requestId?: string;
}
/**
 * Submit the creation dialog and report the room the desktop must open afterwards.
 * A created room is opened again (base behavior restored after the dialog extraction);
 * a created bot leaves the current room in place, exactly like the pre-extraction dialog.
 */
export async function submitCreation(
  draft: RoomCreateDraft,
  call: CreateCall,
): Promise<string | null> {
  const requestId = draft.requestId ?? crypto.randomUUID();
  if (draft.dialog === 'bot' && draft.binding) {
    if (!draft.binding.connectionId || !draft.binding.modelId)
      throw Error('explicit_bot_binding_required');
    await call({
      op: 'bot-bound-create',
      input: {
        workspaceId: 'ws_ocean',
        requestId,
        handle: draft.handle,
        name: draft.name,
        role: draft.role,
        binding: { ...draft.binding },
      },
    });
    return null;
  }
  if (draft.dialog === 'bot') {
    await call({
      op: 'bot',
      requestId,
      handle: draft.handle,
      name: draft.name,
      role: draft.role,
      model: draft.model,
    });
    return null;
  }
  const reply =
    draft.kind === 'direct'
      ? await call({ op: 'direct', requestId, bot: draft.selected[0] ?? '' })
      : await call({
          op: 'group',
          requestId,
          title: draft.title,
          bots: [...draft.selected],
        });
  return reply.data.id;
}
