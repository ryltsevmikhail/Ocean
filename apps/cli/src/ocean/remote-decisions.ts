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
  #cards: readonly LocalDecision[] = [];
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
  refresh() {
    const reading = this.#reading.then(() => this.#readCards());
    this.#reading = reading.catch(() => {});
    return reading;
  }
  async #readCards() {
    const cards = await this.#connection.withClient((c) =>
      pages<LocalDecision, string>(
        (after) =>
          c.listDecisions({ ...this.#room.scope, ...(after ? { after } : {}), limit: 200 }),
        (v) => v.decisionId,
      ),
    );
    this.#cards = cards;
    const summaries: string[] = [];
    for (const card of cards) {
      let result = '';
      if (card.kind === 'continue-text-only' && card.status === 'allowed') {
        const applied = await this.#connection.withClient((c) => c.continuationApplied(ref(card)));
        result = applied
          ? ' · future text-only messages allowed; earlier outcome remains unknown'
          : ' · continuation application unconfirmed';
      }
      summaries.push(
        `${card.kind} · ${card.status} v${card.version} · expires ${card.expiresAt}${result}\n/decision ${card.decisionId}`,
      );
    }
    this.panel.refresh(cards);
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
      card = this.#cards.find((c) => c.decisionId === id);
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
