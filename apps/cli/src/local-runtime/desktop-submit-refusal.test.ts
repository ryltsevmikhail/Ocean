import { expect, it } from 'vitest';
import { desktopSubmitRefusal } from './desktop-assets.js';

/** Minimal store shaped like DesktopAssetStore for the pure refusal contract. */
function store(
  prepared: { prepared: string; to: string | null } | undefined,
  state = 'completed',
): Parameters<typeof desktopSubmitRefusal>[0] {
  return {
    operation: () => (state === 'missing' ? undefined : { state }),
    prepared: () => prepared,
  } as unknown as Parameters<typeof desktopSubmitRefusal>[0];
}
const broadcast = {
  roomId: 'room_1',
  requestId: 'request_1',
  text: 'Вопрос всем',
};
it('enforces the prepared binding for explicit broadcast submissions', () => {
  expect(desktopSubmitRefusal(store({ prepared: 'Вопрос всем', to: null }), broadcast)).toBeNull();
  expect(
    desktopSubmitRefusal(store({ prepared: 'Вопрос всем', to: null }, 'pending'), broadcast),
  ).toBe('desktop_outcome_unknown');
  expect(desktopSubmitRefusal(store({ prepared: 'Другой текст', to: null }), broadcast)).toBe(
    'request_conflict',
  );
  expect(desktopSubmitRefusal(store({ prepared: 'Вопрос всем', to: 'bot_1' }), broadcast)).toBe(
    'request_conflict',
  );
  expect(desktopSubmitRefusal(store(undefined), broadcast)).toBe('request_conflict');
  expect(desktopSubmitRefusal(store(undefined, 'missing'), broadcast)).toBeNull();
});
