import type { LocalDecision } from '@runnets/contracts';
import type { Size } from './types.js';
import type { Key } from './keys.js';
import { fit, wrap } from './text.js';

export function visibleControls(text: string) {
  return text.replace(
    /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
type Choose = (card: LocalDecision, choice: 'allow-once' | 'deny') => Promise<void>;
/** A verified complete preview owns all input until dismissed. Never convert a close into a vote. */
export class DecisionPanel {
  #card: LocalDecision | null = null;
  #preview = '';
  #offset = 0;
  #lines: string[] = [];
  #width = 0;
  #height = 0;
  #sending = false;
  #seenThrough = 0;
  readonly #choose: Choose;
  constructor(choose: Choose) {
    this.#choose = choose;
  }
  open(card: LocalDecision, preview: string) {
    this.#card = card;
    this.#preview = visibleControls(preview);
    this.#offset = 0;
    this.#width = 0;
    this.#seenThrough = 0;
  }
  refresh(cards: readonly LocalDecision[]) {
    if (!this.#card) return;
    const next = cards.find((c) => c.decisionId === this.#card?.decisionId);
    if (!next || next.bindingDigest !== this.#card.bindingDigest) {
      this.#card = null;
      return;
    }
    if (next.version >= this.#card.version) this.#card = next;
  }
  handle(key: Key, interactive: boolean, size: Size): boolean | Promise<void> {
    const card = this.#card;
    if (!card) return false;
    if (key.type === 'escape' || key.type === 'ctrl-c') {
      this.#card = null;
      return true;
    }
    const last = Math.max(0, this.#lines.length - this.#height);
    switch (key.type) {
      case 'home':
        this.#offset = 0;
        break;
      case 'end':
        this.#offset = last;
        break;
      case 'up':
      case 'page-up':
        this.#offset = Math.max(0, this.#offset - (key.type === 'up' ? 1 : this.#height));
        break;
      case 'down':
      case 'page-down':
        this.#offset = Math.min(last, this.#offset + (key.type === 'down' ? 1 : this.#height));
        break;
      case 'char':
        if (
          interactive &&
          card.status === 'pending' &&
          !this.#sending &&
          (key.value === 'n' ||
            (key.value === 'y' &&
              this.#width >= 20 &&
              this.#height > 0 &&
              this.#width === size.columns &&
              this.#height === size.rows - 2 &&
              this.#seenThrough === this.#lines.length &&
              this.#offset === last))
        ) {
          this.#sending = true;
          return this.#choose(card, key.value === 'y' ? 'allow-once' : 'deny').finally(() => {
            this.#sending = false;
          });
        }
        break;
      case 'backspace':
      case 'enter':
      case 'left':
      case 'newline':
      case 'panel':
      case 'paste':
      case 'right':
      case 'shift-tab':
      case 'tab':
      case 'toggle-thoughts':
      case 'unknown':
        break;
    }
    return true;
  }
  frame(size: Size) {
    const card = this.#card;
    if (!card) return null;
    const width = size.columns,
      height = size.rows - 2;
    if (width < 20 || height < 1) {
      this.#width = 0;
      this.#height = 0;
      this.#seenThrough = 0;
      this.#offset = 0;
      return size.rows > 0 ? fit('Resize to review', width) : '';
    }
    if (width !== this.#width || height !== this.#height) {
      this.#lines = wrap(
        (
          card.kind +
          '\n' +
          card.decisionId +
          '\n' +
          card.bindingDigest +
          '\nexpires ' +
          card.expiresAt +
          '\n' +
          this.#preview
        ).replace(/[^\x20-\x7e\n]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
        width,
      );
      this.#width = width;
      this.#offset = 0;
      this.#seenThrough = 0;
    }
    this.#height = height;
    const last = Math.max(0, this.#lines.length - this.#height);
    this.#offset = Math.min(this.#offset, last);
    const footer =
      card.status !== 'pending'
        ? 'Esc close'
        : this.#offset === last && this.#offset <= this.#seenThrough
          ? 'y allow once · n deny · Esc close'
          : 'PgDn review complete preview · n deny · Esc close';
    return [
      fit(card.status + ' v' + card.version + ' · ' + card.kind, width),
      ...this.#lines.slice(this.#offset, this.#offset + this.#height),
      fit(footer, width),
    ].join('\n');
  }
  /** Only advance through consecutive pages actually handed to the terminal output. */
  presented() {
    if (this.#card && this.#height > 0 && this.#offset <= this.#seenThrough)
      this.#seenThrough = Math.max(
        this.#seenThrough,
        Math.min(this.#lines.length, this.#offset + this.#height),
      );
  }
}
