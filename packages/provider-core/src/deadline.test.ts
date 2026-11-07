import { expect, it } from 'vitest';
import { createAnthropicProvider } from '@runnets/provider-anthropic';
import { createOpenAIProvider } from '@runnets/provider-openai';
import { createDeepSeekProvider } from '@runnets/provider-deepseek';
for (const create of [createAnthropicProvider, createOpenAIProvider, createDeepSeekProvider]) {
  it.each([2147483648, 4294967296, Number.MAX_SAFE_INTEGER, -1, NaN, 1.5])(
    `rejects unsupported native deadlines in ${create.name}: %s`,
    (timeoutMs) => {
      expect(() => create({ apiKey: 'fixture', timeoutMs })).toThrow(
        expect.objectContaining({ code: 'invalid_request', dispatch: 'not_sent' }),
      );
    },
  );
  it.each([0, 2147483647])(
    `accepts disabled and supported timer bounds in ${create.name}: %s`,
    (timeoutMs) => {
      expect(() => create({ apiKey: 'fixture', timeoutMs })).not.toThrow();
    },
  );
}
