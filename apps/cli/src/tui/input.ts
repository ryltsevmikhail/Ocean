import { StringDecoder } from 'node:string_decoder';
import { decodeKeys, type Key } from './keys.js';

/** Preserve split UTF-8 characters and partial escape/paste frames across stream reads. */
export class KeyReader {
  readonly #decoder = new StringDecoder('utf8');
  #rest = '';
  /** Only an isolated Escape needs a short ambiguity timeout. */
  get escapePending(): boolean {
    return this.#rest === '\x1b';
  }
  /** Resolve a standalone Escape after allowing the next stream chunk to arrive. */
  flushEscape(): readonly Key[] {
    if (!this.escapePending) return [];
    this.#rest = '';
    return [{ type: 'escape' }];
  }
  read(chunk: Buffer | string): readonly Key[] {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    const decoded = decodeKeys(this.#rest + text, false);
    this.#rest = decoded.rest;
    return decoded.keys;
  }
}

/** Deliver complete input frames; distinguish physical Escape from split CSI/paste markers. */
export class KeyInput {
  readonly #reader = new KeyReader();
  readonly #deliver: (keys: readonly Key[]) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(deliver: (keys: readonly Key[]) => void) {
    this.#deliver = deliver;
  }
  /** Cancel deferred input on teardown, so no key fires after terminal restoration. */
  close(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  /** Batch each chunk and defer only a standalone ambiguous Escape for 50ms. */
  read(chunk: Buffer | string): void {
    this.close();
    this.#deliver(this.#reader.read(chunk));
    if (this.#reader.escapePending) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#deliver(this.#reader.flushEscape());
      }, 50);
    }
  }
}
