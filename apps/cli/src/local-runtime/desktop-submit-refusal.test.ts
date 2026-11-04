import { expect, it } from 'vitest';
import { encodeDesktopAttachments } from '@runnets/domain';
import { desktopSubmitRefusal } from './desktop-assets.js';

const requestId = '22345678-1234-4123-8123-123456789abc';
const attachment = {
  id: '12345678-1234-4123-8123-123456789abc',
  name: 'photo.png',
  bytes: 10,
  sha256: 'a'.repeat(64),
  kind: 'image' as const,
  mime: 'image/png',
};
const prepared = encodeDesktopAttachments('Вопрос всем', requestId, [attachment]);
const malformed = 'Вопрос всем\n\n[Ocean Desktop attachments v1]\n{"version":1}';

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
const broadcast = { roomId: 'room_1', requestId, text: prepared };
const bound = { prepared, to: null };

it('enforces the prepared binding for explicit broadcast submissions', () => {
  expect(desktopSubmitRefusal(store(bound), broadcast, true)).toBeNull();
  expect(desktopSubmitRefusal(store(bound, 'pending'), broadcast, true)).toBe(
    'desktop_outcome_unknown',
  );
  expect(desktopSubmitRefusal(store({ prepared: 'Другой текст', to: null }), broadcast, true)).toBe(
    'request_conflict',
  );
  expect(desktopSubmitRefusal(store({ prepared, to: 'bot_1' }), broadcast, true)).toBe(
    'request_conflict',
  );
  expect(desktopSubmitRefusal(store(undefined), broadcast, true)).toBe('request_conflict');
});

it('refuses every marker body without a completed bound preparation', () => {
  // No durable preparation at all: admitting it would persist a body that every
  // later model turn in the room must refuse.
  expect(desktopSubmitRefusal(store(undefined, 'missing'), broadcast, true)).toBe(
    'image_unavailable',
  );
  expect(desktopSubmitRefusal(store(undefined, 'missing'), broadcast)).toBe('image_unavailable');
  // A marker that does not even decode names no preparation and must not be stored.
  expect(desktopSubmitRefusal(store(undefined, 'missing'), { ...broadcast, text: malformed })).toBe(
    'image_unavailable',
  );
  // A model-bound admission whose marker names another preparation request is refused
  // before the batch/message is committed.
  expect(
    desktopSubmitRefusal(store(undefined, 'missing'), {
      ...broadcast,
      requestId: '32345678-1234-4123-8123-123456789abc',
    }),
  ).toBe('image_unavailable');
});

it('keeps plain text and malformed-parameter handling unchanged', () => {
  expect(
    desktopSubmitRefusal(store(undefined, 'missing'), {
      roomId: 'room_1',
      requestId,
      text: 'Настоящий текст без вложений',
    }),
  ).toBeNull();
  // Plain text keeps the pre-existing prepared-outcome rules for its request id.
  expect(
    desktopSubmitRefusal(store(undefined, 'pending'), {
      roomId: 'room_1',
      requestId,
      text: 'Настоящий текст без вложений',
    }),
  ).toBe('desktop_outcome_unknown');
  expect(
    desktopSubmitRefusal(store(bound), {
      roomId: 'room_1',
      requestId,
      text: 'Настоящий текст без вложений',
    }),
  ).toBe('request_conflict');
  expect(desktopSubmitRefusal(store(undefined, 'missing'), { text: prepared })).toBeNull();
  expect(
    desktopSubmitRefusal(store(undefined, 'missing'), { roomId: 'room_1', text: 42 }),
  ).toBeNull();
});
