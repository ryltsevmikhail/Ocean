import { randomUUID } from 'node:crypto';
import type { LocalDecision, LocalReviewSnapshot } from '@runnets/contracts';
import { DecisionPanel, visibleControls } from '../tui/decision-panel.js';
import { pages, type RemoteRoomView } from './remote-room-view.js';
import type { RoomConnection } from './room-connection.js';

const ref = ({ workspaceId, roomId, runId, decisionId }: LocalDecision) => ({
  workspaceId,
  roomId,
  runId,
  decisionId,
});
export function roomCommand(prompt: string) {
  if (prompt === '/review') return 'review';
  if (prompt === '/continue' || prompt.startsWith('/continue ')) return 'continue';
  if (prompt === '/decision' || prompt.startsWith('/decision ')) return 'decision';
  return null;
}
export class RemoteDecisions {
  #seen: LocalReviewSnapshot | null = null;
  readonly #cards = new Map<string, LocalDecision>();
  readonly #pending = new Map<string, LocalDecision>();
  readonly #applied = new Set<string>();
  #reading: Promise<void> = Promise.resolve();
  readonly panel: DecisionPanel;
  readonly #connection: RoomConnection;
  readonly #room: RemoteRoomView;
  constructor(connection: RoomConnection, room: RemoteRoomView) {
    this.#room = room;
    this.#connection = connection;
    this.panel = new DecisionPanel(async (card, choice) => {
      const command = {
        ...ref(card),
        choice,
        expectedVersion: card.version,
        bindingDigest: card.bindingDigest,
      };
      await connection.withClient((c) => c.resolveDecision(command));
      await this.refresh();
    });
  }
  refresh(full = true) {
    const reading = this.#reading.then(() => this.#readCards(full));
    this.#reading = reading.catch(() => {});
    return reading;
  }
  async #readCards(full: boolean) {
    const cards = await this.#connection.withClient((c) =>
      full
        ? pages<LocalDecision, string>(
            (after) =>
              c.listDecisions({ ...this.#room.scope, ...(after ? { after } : {}), limit: 200 }),
            (v) => v.decisionId,
          )
        : Promise.all([...this.#pending.values()].map((card) => c.getDecision(ref(card)))),
    );
    let changed = full;
    for (const card of cards) {
      if (JSON.stringify(this.#cards.get(card.decisionId)) !== JSON.stringify(card)) changed = true;
      this.#cards.set(card.decisionId, card);
      if (card.status === 'pending') this.#pending.set(card.decisionId, card);
      else this.#pending.delete(card.decisionId);
    }
    if (!changed) return;
    const summaries: string[] = [];
    for (const card of this.#cards.values()) {
      let result = '';
      if (card.kind === 'continue-text-only' && card.status === 'allowed') {
        const applied =
          this.#applied.has(card.decisionId) ||
          (await this.#connection.withClient((c) => c.continuationApplied(ref(card))));
        if (applied) this.#applied.add(card.decisionId);
        result = applied
          ? ' · future text-only messages allowed; earlier outcome remains unknown'
          : ' · continuation application unconfirmed';
      }
      summaries.push(
        `${card.kind} · ${card.status} v${card.version} · expires ${card.expiresAt}${result}\n/decision ${card.decisionId}`,
      );
    }
    this.panel.refresh([...this.#cards.values()]);
    this.#room.cards = summaries;
    this.#room.paint();
  }
  async handle(prompt: string): Promise<string | null> {
    const action = roomCommand(prompt);
    if (action === 'review') {
      this.#seen = null;
      const review = await this.#connection.withClient((c) => c.reviewRoom(this.#room.scope));
      this.#seen = review;
      this.#room.notice(
        'Interrupted run review\n' +
          JSON.stringify(review, null, 2).split('\n').map(visibleControls).join('\n') +
          '\n/continue text-only <reason>',
      );
      return 'review loaded';
    }
    let card: LocalDecision | undefined;
    if (action === 'continue') {
      if (!this.#seen) throw Error('Use /review before continuing');
      const prefix = '/continue text-only ';
      if (!prompt.startsWith(prefix) || !prompt.slice(prefix.length).trim())
        throw Error('Use /continue text-only <reason>');
      const command = {
        ...this.#room.scope,
        runId: this.#seen.runId,
        reviewVersion: this.#seen.version,
        requestId: randomUUID(),
        reason: prompt.slice(prefix.length),
      };
      card = await this.#connection.withClient((c) => c.requestContinuation(command));
      this.#seen = null;
    } else if (action === 'decision') {
      const id = prompt.slice('/decision '.length);
      await this.refresh();
      card = this.#cards.get(id);
      if (!card) throw Error('unknown_decision');
    } else return null;
    const exactRef = ref(card);
    const complete = await this.#connection.withClient((c) => c.decisionPreview(exactRef));
    const current = await this.#connection.withClient((c) => c.getDecision(exactRef));
    if (current.bindingDigest !== card.bindingDigest) throw Error('binding_conflict');
    this.panel.open(current, complete);
    await this.refresh();
    return current.status + ' decision';
  }
}
