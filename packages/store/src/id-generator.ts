/**
 * Sequential identity source.
 *
 * Ids are minted as `<kind>_<namespace><sequence>` — for example `ev_0001` or
 * `cm_0002` — which satisfies the domain id contract. Event and command
 * identities have independent sequences; the optional namespace keeps two
 * generators in one process from minting colliding ids.
 */

import type { IdGenerator } from '@runnets/application';
import { isValidId } from '@runnets/domain';

const COUNTER_DIGITS = 4;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

export class SequentialIdGenerator implements IdGenerator {
  readonly #namespace: string;
  #eventSequence = 0;
  #commandSequence = 0;

  /** `prefix` is an optional namespace, not a replacement for `ev`/`cm`. */
  constructor(prefix = '') {
    if (prefix !== '' && !NAMESPACE_PATTERN.test(prefix)) {
      throw new RangeError(
        `invalid id namespace: expected [a-z0-9][a-z0-9_-]{0,49}, received ${JSON.stringify(prefix)}`,
      );
    }
    this.#namespace = prefix;
  }

  eventId(): string {
    this.#eventSequence += 1;
    return this.#format('ev', this.#eventSequence);
  }

  commandId(): string {
    this.#commandSequence += 1;
    return this.#format('cm', this.#commandSequence);
  }

  /** Validate the formatted id against the domain contract before returning. */
  #format(kind: 'ev' | 'cm', sequence: number): string {
    const raw = `${kind}_${this.#namespace}${String(sequence).padStart(COUNTER_DIGITS, '0')}`;
    if (!isValidId(raw, kind)) {
      throw new RangeError(`generated id violates the domain id contract: ${raw}`);
    }
    return raw;
  }
}
