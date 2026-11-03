import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { isatty } from 'node:tty';
import type { Readable, Writable } from 'node:stream';
import { isReviewSnapshot, localRuntimeRecord, type LocalRoomSummary } from '@runnets/contracts';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { visibleControls } from '../tui/decision-panel.js';
import { required, type OceanArguments } from './arguments.js';
import { pages } from './remote-room-view.js';
export const workspaceId = 'ws_ocean';
export const page = (after?: string) => (after ? { limit: 200, after } : { limit: 200 });
export const rooms = (c: LocalRuntimeClient) =>
  pages<LocalRoomSummary, string>(
    (after) => c.listRooms({ workspaceId, ...page(after) }),
    (r) => r.id,
  );
function terminal(stream: Readable | Writable) {
  const fd = (stream as { fd?: number }).fd;
  return typeof fd === 'number' && isatty(fd);
}
/** The immutable decision survives detachment. Only a terminal that saw its full bound preview can cast a vote. */
export async function remoteRun(
  c: LocalRuntimeClient,
  args: OceanArguments,
  requestId: string,
  input: Readable,
  error: Writable,
  signal: AbortSignal,
) {
  const [action, runId] = args.positional;
  const selected = args.flags.get('room');
  const candidates = selected ? [{ id: selected }] : await rooms(c);
  if (action === 'list') {
    const runs = [];
    for (const { id: roomId } of candidates) {
      const roomRuns = await pages(
        (after: string | undefined) => c.listRuns({ workspaceId, roomId, ...page(after) }),
        (r) => r.turnId,
      );
      for (const run of roomRuns) runs.push(run);
    }
    return { data: runs, code: 0 };
  }
  if (!runId) throw Error('invalid_input');
  for (const { id: roomId } of candidates) {
    const scope = { workspaceId, roomId, runId };
    const run = await c.getRun(scope);
    if (!run) continue;
    if (action === 'show') return { data: run, code: 0 };
    if (action === 'review') return { data: await c.reviewRun(scope), code: 0 };
    if (action !== 'acknowledge' || !args.textOnly) throw Error('invalid_input');
    if (!terminal(input) || !terminal(error)) throw Error('approval_required');
    const reason = required(args.flags, 'reason'),
      reviewVersion = required(args.flags, 'review-version');
    const card = await c.requestContinuation({ ...scope, requestId, reviewVersion, reason });
    const ref = { ...scope, decisionId: card.decisionId };
    let current = card;
    if (card.status === 'pending') {
      const full = await c.decisionPreview(ref);
      const body: unknown = JSON.parse(full);
      if (
        createHash('sha256').update(full).digest('hex') !== card.bindingDigest ||
        !localRuntimeRecord(body) ||
        body['mode'] !== 'text_only' ||
        body['reason'] !== reason ||
        body['requestId'] !== requestId ||
        !isReviewSnapshot(body['snapshot']) ||
        body['snapshot'].workspaceId !== workspaceId ||
        body['snapshot'].roomId !== roomId ||
        body['snapshot'].runId !== runId ||
        body['snapshot'].version !== reviewVersion
      )
        throw Error('binding_conflict');
      const heading = visibleControls(
        `Decision ${card.decisionId} v${card.version} · expires ${card.expiresAt} · SHA-256 ${card.bindingDigest}`,
      );
      await new Promise<void>((resolve, reject) =>
        error.write(heading + '\n' + visibleControls(full) + '\n', (e) =>
          e ? reject(e) : resolve(),
        ),
      );
      const reader = createInterface({ input, output: error });
      try {
        const answer = await reader.question(
          'Permit this exact text-only continuation and possible new charges? [y/N] ',
          { signal },
        );
        current = await c.resolveDecision({
          ...ref,
          expectedVersion: card.version,
          bindingDigest: card.bindingDigest,
          choice: answer === 'y' ? 'allow-once' : 'deny',
        });
      } finally {
        reader.close();
      }
    }
    const continuationApplied = await c.continuationApplied(ref);
    return {
      data: { ...current, requestId, continuationApplied },
      code: continuationApplied ? 0 : 4,
    };
  }
  throw Error('unknown_run');
}
