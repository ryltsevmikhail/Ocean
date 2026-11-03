import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProfileRebindRecord, ProfileRebindHold } from '@runnets/domain';
import type {
  ProfileRebindStore,
  ProfileRebindTransaction,
  ToolJournalPort,
} from '@runnets/application';
import { validateRebindResult } from '@runnets/application';
import { restoreOriginStore } from './restore-origin.js';
import { task, participates, codingTransaction } from './coding-store.js';
import { SqliteOwnerDecisions } from './owner-decisions.js';
import { withImmediateTransaction } from './transaction.js';
import { activeRebind } from './restoration-authority.js';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function migrateRebinds(db: DatabaseSync): void {
  db.exec(`CREATE TABLE ocean_profile_rebinds (
    request_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL
  ) STRICT;
  CREATE TABLE ocean_execution_epoch (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), request_id TEXT NOT NULL UNIQUE REFERENCES ocean_profile_rebinds(request_id)
  ) STRICT;
  CREATE TABLE ocean_rebind_observations(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT`);
}
function decode(row: Record<string, unknown> | undefined): ProfileRebindRecord | null {
  if (!row) return null;
  const r = JSON.parse(String(row['payload'])) as ProfileRebindRecord;
  if (
    r.requestId !== row['request_id'] ||
    r.revision !== row['revision'] ||
    r.state !== row['state'] ||
    r.bindingDigest !== createHash('sha256').update(JSON.stringify(r.preview)).digest('hex') ||
    r.preview.selection.requestId !== r.requestId
  )
    throw Error('invalid_rebind_record');
  return r;
}
export function profileRebindStore(db: DatabaseSync, journal: ToolJournalPort): ProfileRebindStore {
  const origin = restoreOriginStore(db);
  const current = (r: ProfileRebindRecord) => same(r.preview.origin, origin.origin());
  const record = (id: string) =>
    decode(db.prepare('SELECT * FROM ocean_profile_rebinds WHERE request_id=?').get(id));
  const write = (r: ProfileRebindRecord) =>
    db
      .prepare(
        `INSERT INTO ocean_profile_rebinds VALUES(?,?,?,?)
    ON CONFLICT(request_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,payload=excluded.payload`,
      )
      .run(r.requestId, r.revision, r.state, JSON.stringify(r));
  const save: ProfileRebindTransaction['save'] = (r, expected) => {
    const old = record(r.requestId);
    if ((old?.revision ?? null) !== expected) return false;
    if (
      r.revision !== (expected ?? 0) + 1 ||
      !same(r.preview.origin, origin.origin()) ||
      r.bindingDigest !== createHash('sha256').update(JSON.stringify(r.preview)).digest('hex')
    )
      throw Error('immutable_rebind');
    if (
      old &&
      (!same(
        {
          ...old,
          revision: r.revision,
          state: r.state,
          projectLease: r.projectLease,
          worktreeLease: r.worktreeLease,
          result: r.result,
          reason: r.reason,
        },
        r,
      ) ||
        (old.projectLease !== null && !same(old.projectLease, r.projectLease)) ||
        (old.worktreeLease !== null && !same(old.worktreeLease, r.worktreeLease)))
    )
      throw Error('immutable_rebind');
    const transitions: Record<
      ProfileRebindRecord['state'],
      readonly ProfileRebindRecord['state'][]
    > = {
      preview: ['confirmed', 'refused', 'held'],
      confirmed: ['confirmed', 'preparing', 'held'],
      preparing: ['held'],
      ready: [],
      held: [],
      refused: [],
    };
    if (
      (!old && (r.state !== 'preview' || r.projectLease || r.worktreeLease || r.result)) ||
      (old && !transitions[old.state].includes(r.state)) ||
      r.result !== null ||
      (r.state === 'preparing' && (!r.projectLease || !r.worktreeLease))
    )
      throw Error('invalid_rebind_transition');
    write(r);
    return true;
  };
  const holds = (): readonly ProfileRebindHold[] => {
    const unresolved = journal.inspectPending?.();
    if (!unresolved) throw Error('rebind_effects_unavailable');
    return [
      ...unresolved.map((e) => ({
        id: e.id,
        kind: e.tool,
        outcome: e.outcome,
        scope: 'global' as const,
      })),
      ...db
        .prepare(
          "SELECT id,status FROM ocean_chat_turns WHERE status IN ('accepted','dispatching','prepared','uncertain')",
        )
        .all()
        .map((r) => ({
          id: String(r['id']),
          kind: 'provider',
          outcome: String(r['status']),
          scope: 'global' as const,
        })),
      ...db
        .prepare("SELECT id,state FROM ocean_desktop_operations WHERE state='started'")
        .all()
        .map((r) => ({
          id: String(r['id']),
          kind: 'desktop',
          outcome: String(r['state']),
          scope: 'operation' as const,
        })),
    ];
  };
  const active = () => activeRebind(db);
  const publish: ProfileRebindTransaction['publish'] = (r, result) => {
    const old = record(r.requestId);
    if (
      !old ||
      old.state !== 'preparing' ||
      active() ||
      !same(r, { ...old, state: 'ready', revision: old.revision + 1, result }) ||
      holds().some((h) => h.scope === 'global')
    )
      throw Error('rebind_publication_conflict');
    const p = r.preview;
    const decision = new SqliteOwnerDecisions(db).find({
      workspaceId: p.selection.workspaceId,
      roomId: p.selection.roomId,
      runId: 'rebind-' + p.epochId,
      decisionId: r.decisionId,
    });
    if (
      decision?.status !== 'allowed' ||
      decision.kind !== 'restore-rebind' ||
      decision.bindingDigest !== r.bindingDigest ||
      decision.version !== 2
    )
      throw Error('rebind_confirmation_inactive');
    validateRebindResult(r, result);
    const coding = codingTransaction(db);
    if (coding.task(result.task.id) || coding.worktree(result.task.id))
      throw Error('rebind_publication_conflict');
    coding.putTask(result.task);
    coding.putWorktree(result.worktree);
    if (
      db
        .prepare('UPDATE ocean_workspace SET root=? WHERE id=?')
        .run(result.task.projectRoot, result.task.workspaceId).changes !== 1
    )
      throw Error('rebind_scope_conflict');
    if (result.desktop)
      db.prepare("UPDATE meta SET value=? WHERE key='desktop_assets_binding'").run(
        JSON.stringify(result.desktop),
      );
    write(r);
    db.prepare('INSERT INTO ocean_execution_epoch VALUES(1,?)').run(r.requestId);
  };
  return {
    active,
    atomic: (work) =>
      withImmediateTransaction(db, () =>
        work({
          observe(value) {
            const payload = JSON.stringify(value);
            const total = db
              .prepare(
                'SELECT count(*) AS count,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM ocean_rebind_observations',
              )
              .get()!;
            if (
              Buffer.byteLength(payload) > 1048576 ||
              Number(total['count']) >= 10000 ||
              Number(total['bytes']) + Buffer.byteLength(payload) > 16777216
            )
              throw Error('rebind_observation_limit');
            db.prepare('INSERT INTO ocean_rebind_observations VALUES(?,?)').run(value.id, payload);
          },
          origin: () => origin.origin(),
          record,
          save,
          holds,
          task: (id) => task(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
          participates: (ws, room, bot) => participates(db, ws, room, bot),
          busy: () =>
            db
              .prepare(
                "SELECT * FROM ocean_profile_rebinds WHERE state IN ('confirmed','preparing','ready','held')",
              )
              .all()
              .some((r) => current(decode(r)!)),
          publish,
        }),
      ),
    recover: () =>
      withImmediateTransaction(db, () => {
        for (const row of db
          .prepare(
            "SELECT * FROM ocean_profile_rebinds WHERE state IN ('preview','confirmed','preparing')",
          )
          .all()) {
          const r = decode(row)!;
          if (!current(r)) continue;
          write({
            ...r,
            revision: r.revision + 1,
            state: r.state === 'preview' ? 'refused' : 'held',
            reason: r.state === 'preview' ? 'confirmation_interrupted' : 'rebind_outcome_unknown',
          });
        }
      }),
  };
}
