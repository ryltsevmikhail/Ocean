import { describe, expect, it } from 'vitest';
import { validConversationText, validateBotProfile } from './conversations.js';

describe('conversation input boundaries', () => {
  it('bounds text by UTF-8 bytes and rejects malformed text', () => {
    expect(validConversationText('😀'.repeat(4096), 16384)).toBe(true);
    expect(validConversationText('😀'.repeat(4097), 16384)).toBe(false);
    expect(validConversationText('я'.repeat(8192), 16384)).toBe(true);
    for (const text of ['', ' \n', '\0', '\ud800', '\udfff'])
      expect(validConversationText(text, 16384)).toBe(false);
  });
  it('accepts a complete profile and rejects unaddressable or oversized profiles', () => {
    const profile = {
      handle: 'dev',
      name: 'Разработчик',
      role: 'Role',
      provider: 'deepseek',
      model: 'test',
    };
    expect(validateBotProfile(profile)).toEqual({ ok: true, value: profile });
    for (const change of [
      { handle: 'Dev' },
      { handle: 'a'.repeat(33) },
      { handle: '@dev' },
      { name: ' ' },
      { role: 'a'.repeat(8193) },
      { provider: '' },
      { model: '' },
    ])
      expect(validateBotProfile({ ...profile, ...change })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
  });
});
