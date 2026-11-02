export interface OwnerDecisionScope {
  readonly workspaceId: string;
  readonly roomId: string;
}
export interface OwnerDecisionRef extends OwnerDecisionScope {
  readonly runId: string;
  readonly decisionId: string;
}
export type DecisionOutcome =
  'allowed' | 'denied' | 'cancelled' | 'expired' | 'invalidated' | 'interrupted';
export interface OwnerDecision extends OwnerDecisionRef {
  readonly kind: 'write' | 'test' | 'continue-text-only';
  readonly version: number;
  readonly status: 'pending' | DecisionOutcome;
  readonly bindingDigest: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly previewLength: number;
}
export function assertNewOwnerDecision(card: OwnerDecision, preview: string) {
  if (
    card.status !== 'pending' ||
    card.version !== 1 ||
    !Number.isSafeInteger(card.createdAt) ||
    !Number.isSafeInteger(card.expiresAt) ||
    card.expiresAt - card.createdAt !== 300000 ||
    !preview.length ||
    card.previewLength !== preview.length
  )
    throw Error('invalid_decision');
}
/** A decision records an owner response. Only the operation service may grant or consume authority. */
export interface OwnerDecisionStore {
  insert(card: OwnerDecision, preview: string): void;
  list(scope: OwnerDecisionScope, after: string, limit: number): readonly OwnerDecision[];
  find(ref: OwnerDecisionRef): OwnerDecision | null;
  preview(ref: OwnerDecisionRef, offset?: number, length?: number): string | null;
  settle(expected: OwnerDecision, outcome: DecisionOutcome): boolean;
  retirePending(): void;
}
type Waiter = {
  current(): Promise<boolean>;
  finish(outcome: DecisionOutcome): void;
};
/** Only live, admitted operations install a waiter. A stored row cannot recreate one. */
export class RuntimeOwnerDecisions {
  readonly #checks = new Map<string, Promise<OwnerDecision>>();
  readonly #waiters = new Map<string, Waiter>();
  readonly store: OwnerDecisionStore;
  readonly now: () => number;
  constructor(store: OwnerDecisionStore, now: () => number) {
    this.store = store;
    this.now = now;
    store.retirePending();
  }
  open(card: OwnerDecision, preview: string, signal: AbortSignal, current: () => Promise<boolean>) {
    signal.throwIfAborted();
    if (card.expiresAt - card.createdAt !== 300000 || this.#expired(card))
      throw Error('decision_expired');
    this.store.insert(card, preview);
    return new Promise<DecisionOutcome>((resolve) => {
      const cancel = () => this.#settle(card, 'cancelled');
      const timer = setTimeout(
        () => this.#settle(card, 'expired'),
        Math.max(0, card.expiresAt - this.now()),
      );
      this.#waiters.set(card.decisionId, {
        current,
        finish: (outcome) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', cancel);
          this.#waiters.delete(card.decisionId);
          resolve(outcome);
        },
      });
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  #expired(card: OwnerDecision) {
    const at = this.now();
    return !Number.isSafeInteger(at) || at < card.createdAt || at >= card.expiresAt;
  }
  #settle(card: OwnerDecision, outcome: DecisionOutcome) {
    if (this.store.settle(card, outcome)) this.#waiters.get(card.decisionId)?.finish(outcome);
  }
  get(ref: OwnerDecisionRef) {
    const card = this.store.find(ref);
    if (!card) throw Error('unknown_decision');
    if (card.status === 'pending' && this.#expired(card)) {
      this.#settle(card, 'expired');
      return this.store.find(ref)!;
    }
    return card;
  }
  async resolve(
    ref: OwnerDecisionRef,
    digest: string,
    version: number,
    choice: 'allow-once' | 'deny' | 'cancel',
  ): Promise<OwnerDecision> {
    const card = this.get(ref);
    if (card.bindingDigest !== digest) throw Error('binding_conflict');
    if (card.status !== 'pending') return card;
    if (card.version !== version) throw Error('version_conflict');
    const waiter = this.#waiters.get(card.decisionId);
    if (!waiter) throw Error('decision_inactive');
    if (choice === 'allow-once') {
      const running = this.#checks.get(card.decisionId);
      if (running) return running;
      const checked = this.#allow(card, waiter).finally(() => this.#checks.delete(card.decisionId));
      this.#checks.set(card.decisionId, checked);
      return checked;
    }
    this.#settle(card, choice === 'deny' ? 'denied' : 'cancelled');
    return this.get(ref);
  }
  async #allow(card: OwnerDecision, waiter: Waiter) {
    const current = await waiter.current().catch(() => false);
    this.#settle(card, this.#expired(card) ? 'expired' : current ? 'allowed' : 'invalidated');
    return this.get(card);
  }
  async joinChecks() {
    await Promise.allSettled(this.#checks.values());
  }
}
