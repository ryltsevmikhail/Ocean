import type { ToolCall } from '@runnets/provider-core';
import { asRecord } from './wire.js';

/** Assemble bounded indexed deltas; partial identities must never reach an executor. */
export class ToolAssembler {
  readonly #calls = new Map<number, ToolCall>();
  #size = 0;

  accept(record: Record<string, unknown>): void {
    const choices = record['choices'];
    if (!Array.isArray(choices)) return;
    const delta = asRecord(asRecord(choices[0])?.['delta']);
    const calls = delta?.['tool_calls'];
    if (calls === undefined) return;
    if (!Array.isArray(calls)) throw new Error('invalid tool delta');
    for (const raw of calls) {
      const call = asRecord(raw);
      const index = call?.['index'];
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 32) {
        throw new Error('invalid tool index');
      }
      const previous = this.#calls.get(index) ?? { id: '', name: '', arguments: '' };
      const discriminator = call?.['type'];
      const functionValue = call?.['function'];
      const fn = asRecord(functionValue);
      if (
        (discriminator !== undefined && discriminator !== 'function') ||
        (functionValue !== undefined && fn === null)
      ) {
        throw new Error('invalid tool function shape');
      }
      const id = call?.['id'];
      const name = fn?.['name'];
      const args = fn?.['arguments'];
      if ([id, name, args].some((value) => value !== undefined && typeof value !== 'string')) {
        throw new Error('invalid tool fields');
      }
      const next = {
        id: previous.id + (typeof id === 'string' ? id : ''),
        name: previous.name + (typeof name === 'string' ? name : ''),
        arguments: previous.arguments + (typeof args === 'string' ? args : ''),
      };
      this.#size +=
        next.id.length +
        next.name.length +
        next.arguments.length -
        previous.id.length -
        previous.name.length -
        previous.arguments.length;
      if (this.#size > 131072) throw new Error('tool arguments exceed limit');
      this.#calls.set(index, next);
    }
  }

  finish(): readonly ToolCall[] {
    const calls = [...this.#calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    const seen = new Set<string>();
    for (const call of calls) {
      if (
        !call.id ||
        call.id.length > 128 ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name) ||
        seen.has(call.id)
      ) {
        throw new Error('invalid tool identity');
      }
      seen.add(call.id);
    }
    return calls;
  }
}
