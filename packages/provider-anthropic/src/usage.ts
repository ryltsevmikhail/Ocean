import { retainTokenUsage, validateTokenUsage, type TokenUsage } from '@runnets/provider-core';
import { asRecord } from './wire.js';
import { malformedStream } from './errors.js';
const fields = [
  'input_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'output_tokens',
] as const;
/** Prefix counts stay private. Only the terminal accounting phase qualifies whole-request usage. */
export class UsageAccumulator {
  readonly #counts = new Map<string, number>();
  #qualified: TokenUsage | null = null;
  get actual(): TokenUsage | null {
    return this.#qualified;
  }
  accept(value: unknown, final: boolean): void {
    const record = asRecord(value);
    let valid = record !== null;
    const next = new Map(this.#counts);
    let conflict = false;
    for (const field of fields) {
      const count = record?.[field];
      if (count === undefined || count === null) continue;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        valid = false;
        next.delete(field);
        continue;
      }
      const previous = this.#counts.get(field);
      if (previous !== undefined && count < previous) conflict = true;
      next.set(field, count);
    }
    this.#counts.clear();
    for (const [field, count] of next) this.#counts.set(field, count);
    if (!final) {
      if (conflict) throw malformedStream();
      return;
    }
    const output = record?.['output_tokens'];
    if (!valid || typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) {
      if (this.#qualified !== null || conflict) throw malformedStream();
      return;
    }
    const input = next.get('input_tokens'),
      write = next.get('cache_creation_input_tokens'),
      read = next.get('cache_read_input_tokens');
    if (input === undefined || write === undefined || read === undefined) {
      if (conflict) throw malformedStream();
      return;
    }
    const aggregate = input + write + read;
    const tuple = validateTokenUsage({
      inputTokens: aggregate,
      outputTokens: output,
      totalTokens: aggregate + output,
    });
    if (tuple === null) {
      if (conflict) throw malformedStream();
      return;
    }
    const retained = retainTokenUsage(this.#qualified, tuple);
    this.#qualified = retained.usage;
    if (retained.conflict || conflict) throw malformedStream();
  }
}
