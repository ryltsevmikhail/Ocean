import type { call } from './bridge.js';

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
  if (draft.dialog === 'bot') {
    await call({
      op: 'bot',
      requestId: crypto.randomUUID(),
      handle: draft.handle,
      name: draft.name,
      role: draft.role,
      model: draft.model,
    });
    return null;
  }
  const reply =
    draft.kind === 'direct'
      ? await call({ op: 'direct', requestId: crypto.randomUUID(), bot: draft.selected[0] ?? '' })
      : await call({
          op: 'group',
          requestId: crypto.randomUUID(),
          title: draft.title,
          bots: [...draft.selected],
        });
  return reply.data.id;
}
