import { assertNewOwnerDecision } from '@runnets/application';
import type {
  DecisionOutcome,
  OwnerDecision,
  OwnerDecisionRef,
  OwnerDecisionScope,
  OwnerDecisionStore,
} from '@runnets/application';
export class InMemoryOwnerDecisions implements OwnerDecisionStore {
  readonly #rows = new Map<string, { card: OwnerDecision; preview: string }>();
  insert(card: OwnerDecision, preview: string) {
    assertNewOwnerDecision(card, preview);
    if (this.#rows.has(card.decisionId)) throw Error('decision_conflict');
    this.#rows.set(card.decisionId, { card: { ...card }, preview });
  }
  has(id: string) {
    return this.#rows.has(id);
  }
  find(ref: OwnerDecisionRef) {
    const card = this.#rows.get(ref.decisionId)?.card;
    return card &&
      card.workspaceId === ref.workspaceId &&
      card.roomId === ref.roomId &&
      card.runId === ref.runId
      ? { ...card }
      : null;
  }
  preview(ref: OwnerDecisionRef, offset = 0, length?: number) {
    return this.find(ref)
      ? this.#rows
          .get(ref.decisionId)!
          .preview.slice(offset, length === undefined ? undefined : offset + length)
      : null;
  }
  list(scope: OwnerDecisionScope, after: string, limit: number) {
    return [...this.#rows.values()]
      .map((r) => r.card)
      .filter(
        (c) =>
          c.workspaceId === scope.workspaceId && c.roomId === scope.roomId && c.decisionId > after,
      )
      .sort((a, b) => (a.decisionId < b.decisionId ? -1 : 1))
      .slice(0, limit)
      .map((c) => ({ ...c }));
  }
  settle(expected: OwnerDecision, outcome: DecisionOutcome) {
    const card = this.find(expected);
    if (
      !card ||
      card.status !== 'pending' ||
      card.version !== expected.version ||
      card.bindingDigest !== expected.bindingDigest
    )
      return false;
    this.#rows.get(card.decisionId)!.card = { ...card, version: card.version + 1, status: outcome };
    return true;
  }
  retirePending() {
    for (const { card } of this.#rows.values())
      if (card.status === 'pending') this.settle(card, 'interrupted');
  }
}
