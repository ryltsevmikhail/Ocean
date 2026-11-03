import type {
  LocalTurnReceipt,
  LocalRoomSummary,
  LocalMemberSummary,
  LocalObservedRun,
  LocalRoomScope,
  LocalRunEvent,
} from '@runnets/contracts';
import { taskRunId } from '@runnets/domain';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type { ScreenEntry } from '../tui/runs.js';
import type { StreamLine } from '../tui/types.js';

/** A frame-budgeted page can be shorter than its limit. Only an empty page ends a scan. */
export async function pages<T, K extends string | number>(
  read: (after: K | undefined) => Promise<readonly T[]>,
  key: (row: T) => K,
  from?: K,
) {
  const rows: T[] = [];
  let after = from;
  for (;;) {
    const page = await read(after);
    if (!page.length) return rows;
    const next = key(page[page.length - 1]!);
    if (after !== undefined) {
      // The owner pages SQLite TEXT IDs with BINARY collation, including legacy Unicode IDs.
      const advanced =
        typeof next === 'string' && typeof after === 'string'
          ? Buffer.compare(Buffer.from(next), Buffer.from(after)) > 0
          : typeof next === 'number' && typeof after === 'number' && next > after;
      if (!advanced) throw Error('invalid_frame');
    }
    rows.push(...page);
    after = next;
  }
}
const afterPage = <K extends string | number>(after?: K) =>
  after === undefined ? { limit: 200 } : { after, limit: 200 };
export class RemoteRoomView {
  readonly entries: ScreenEntry[] = [];
  readonly scope: LocalRoomScope;
  readonly #members = new Map<string, LocalMemberSummary>();
  readonly #positions = new Map<string, number>();
  #stream: StreamLine[] = [];
  #seq = 0;
  #roomNotice = '';
  #receiptNotice = '';
  #readError = '';
  cards: readonly string[] = [];
  workspace = '';
  model = '';
  providerId: string | null = null;
  constructor(roomId: string) {
    this.scope = { workspaceId: 'ws_ocean', roomId };
  }
  async restore(c: LocalRuntimeClient) {
    const rooms = await pages<LocalRoomSummary, string>(
      (after) => c.listRooms({ workspaceId: this.scope.workspaceId, ...afterPage(after) }),
      (r) => r.id,
    );
    const room = rooms.find((r) => r.id === this.scope.roomId);
    if (!room) throw Error('unknown_room');
    this.workspace = room.title ?? room.id;
    const members = await pages<LocalMemberSummary, string>(
      (after) => c.listMembers({ ...this.scope, ...afterPage(after) }),
      (r) => r.id,
    );
    for (const m of members) this.#members.set(m.id, m);
    this.model = members.map((m) => '@' + m.handle + ' / ' + m.model).join(', ');
    this.providerId = room.kind === 'group' ? 'group' : (members[0]?.provider ?? null);
  }
  get active() {
    return this.entries.some(
      (e) => e.remote && ['accepted', 'dispatching', 'prepared'].includes(e.remote.turnStatus),
    );
  }
  draft(): ScreenEntry {
    const existing = this.entries.find((e) => e.taskRunId === null);
    if (existing) return existing;
    const entry: ScreenEntry = {
      taskRunId: null,
      aggregate: null,
      events: [],
      stream: [],
      liveMode: null,
    };
    this.entries.push(entry);
    this.paint();
    return entry;
  }
  latest() {
    return this.entries.reduce<ScreenEntry | undefined>(
      (a, b) =>
        !a ||
        (this.#positions.get(b.remote?.messageId ?? '') ?? 0) >
          (this.#positions.get(a.remote?.messageId ?? '') ?? 0)
          ? b
          : a,
      undefined,
    );
  }
  observed(receipt: LocalTurnReceipt) {
    return (
      this.#positions.has(receipt.messageId) &&
      (!receipt.runId || this.entries.some((e) => e.remote?.runId === receipt.runId))
    );
  }
  confirm(receipt: LocalTurnReceipt) {
    const entry = this.entries.find((e) => e.taskRunId === receipt.runId) ?? this.draft();
    entry.taskRunId = receipt.runId ? taskRunId(receipt.runId) : null;
    entry.receipt = receipt;
    this.#receiptNotice =
      'Receipt ' +
      receipt.requestId +
      ' · message ' +
      receipt.messageId +
      (receipt.runId ? ' · admitted ' + receipt.runId : ' · recorded without model dispatch');
    this.paint();
    return entry;
  }
  observationError(message: string) {
    this.#readError = message;
    this.paint();
  }
  notice(message: string) {
    this.#roomNotice = message;
    this.paint();
  }
  paint() {
    const stream = [
      ...this.#stream,
      ...[this.#roomNotice, ...this.cards, this.#receiptNotice, this.#readError]
        .filter(Boolean)
        .map((text) => ({ kind: 'text' as const, label: 'Ocean', text })),
    ];
    for (const entry of this.entries) entry.stream = stream;
  }
  async refresh(c: LocalRuntimeClient, reset: boolean) {
    const messages = await pages(
      (after) => c.history({ ...this.scope, ...afterPage(after) }),
      (m) => m.seq,
      reset ? 0 : this.#seq,
    );
    const runs = await pages<LocalObservedRun, string>(
      (after) => c.listRuns({ ...this.scope, ...afterPage(after) }),
      (r) => r.turnId,
    );
    if (reset) {
      this.#stream = [];
      this.#seq = 0;
      this.#positions.clear();
    }
    for (const m of messages) {
      this.#positions.set(m.id, m.seq);
      this.#seq = m.seq;
      this.#stream.push(
        m.author === 'user'
          ? { kind: 'user', text: m.body }
          : {
              kind: 'text',
              text: m.body,
              label: this.#members.get(m.authorBotId ?? '')?.name ?? 'Bot',
            },
      );
    }
    for (const r of runs) await this.#update(c, r, reset);
    this.paint();
  }
  async #update(c: LocalRuntimeClient, r: LocalObservedRun, reset: boolean) {
    let entry = this.entries.find((e) => e.taskRunId === r.runId);
    if (!entry) {
      entry = this.draft();
      entry.taskRunId = taskRunId(r.runId);
    }
    const after = reset ? 0 : (entry.events.at(-1)?.sequence ?? 0);
    if (r.version !== after || reset) {
      const events = await pages<LocalRunEvent, number>(
        (pos) => c.listEvents({ ...this.scope, runId: r.runId, ...afterPage(pos) }),
        (e) => e.sequence,
        after,
      );
      entry.events = [...(reset ? [] : entry.events), ...events];
    }
    entry.remote = r;
    const bot = this.#members.get(r.performerId);
    if (bot) entry.performer = bot;
  }
}
