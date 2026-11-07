import type { ToolCall } from '@runnets/provider-core';
import { asRecord, objectArguments, validToolIdentity } from './wire.js';
import { malformedStream } from './errors.js';
type Block =
  | { type: 'text' }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; json: string };
/** Bounded native indexed lifecycle, with JSON-object tool inputs validated before release. */
export class ContentBlocks {
  readonly #open = new Map<number, Block>();
  readonly #calls: ToolCall[] = [];
  readonly #ids = new Set<string>();
  #nextIndex = 0;
  #bytes = 0;
  get closed(): boolean {
    return this.#open.size === 0;
  }
  get calls(): readonly ToolCall[] {
    return this.#calls;
  }
  #index(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= 64)
      throw malformedStream();
    return value;
  }
  start(record: Record<string, unknown>): string | null {
    const index = this.#index(record['index']),
      block = asRecord(record['content_block']);
    if (index !== this.#nextIndex++ || block === null) throw malformedStream();
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      this.#open.set(index, { type: 'text' });
      return block['text'];
    }
    const id = block['id'],
      name = block['name'],
      input = asRecord(block['input']);
    if (
      block['type'] !== 'tool_use' ||
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      !validToolIdentity(id, name) ||
      this.#ids.has(id) ||
      this.#ids.size >= 32 ||
      input === null
    )
      throw malformedStream();
    this.#ids.add(id);
    this.#bytes += Buffer.byteLength(JSON.stringify(input), 'utf8') + id.length + name.length;
    if (this.#bytes > 131072) throw malformedStream();
    this.#open.set(index, { type: 'tool_use', id, name, input, json: '' });
    return null;
  }
  delta(record: Record<string, unknown>): string | null {
    const block = this.#open.get(this.#index(record['index'])),
      delta = asRecord(record['delta']);
    if (block === undefined || delta === null) throw malformedStream();
    if (
      block.type === 'text' &&
      delta['type'] === 'text_delta' &&
      typeof delta['text'] === 'string'
    )
      return delta['text'];
    if (
      block.type !== 'tool_use' ||
      delta['type'] !== 'input_json_delta' ||
      typeof delta['partial_json'] !== 'string' ||
      Object.keys(block.input).length !== 0
    )
      throw malformedStream();
    this.#bytes += Buffer.byteLength(delta['partial_json'], 'utf8');
    if (this.#bytes > 131072) throw malformedStream();
    block.json += delta['partial_json'];
    return null;
  }
  stop(record: Record<string, unknown>): void {
    const index = this.#index(record['index']),
      block = this.#open.get(index);
    if (block === undefined) throw malformedStream();
    if (block.type === 'tool_use') {
      let input: Record<string, unknown>;
      try {
        input = block.json === '' ? block.input : objectArguments(block.json);
      } catch {
        throw malformedStream();
      }
      this.#calls.push({ id: block.id, name: block.name, arguments: JSON.stringify(input) });
    }
    this.#open.delete(index);
  }
}
