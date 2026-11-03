import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  codingFinalizationTransition,
  validCodingFinalizationRecord,
  type CodingFinalizationHold,
  type CodingFinalizationRecord,
  type CodingTask,
} from '@runnets/domain';
import type {
  CodingFinalizationStore,
  CodingFinalizationTransaction,
  ToolJournalPort,
} from '@runnets/application';
import { task as decodeTask, codingTransaction, participates } from './coding-store.js';
import { changesetStorage } from './changeset-storage.js';
import { withImmediateTransaction } from './transaction.js';
import { projectFinalizationHeld } from './coding-finalization-holds.js';
const columns = 'request_id,task_id,project_root,state,revision,binding_digest,payload';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/** Any active or finalized finalization for a task blocks a second operation. */
const ACTIVE = "state IN ('preview','finalizing','finalized','uncertain')";
function decode(row: Record<string, unknown> | undefined): CodingFinalizationRecord | null {
  if (!row) return null;
  const record = JSON.parse(String(row['payload'])) as CodingFinalizationRecord;
  if (
    !validCodingFinalizationRecord(record) ||
    record.requestId !== row['request_id'] ||
    record.taskId !== row['task_id'] ||
    record.projectRoot !== row['project_root'] ||
    record.state !== row['state'] ||
    record.revision !== row['revision'] ||
    record.bindingDigest !== row['binding_digest'] ||
    record.bindingDigest !== digest(JSON.stringify(record.preview))
  )
    throw Error('invalid_finalization_record');
  return record;
}
export function finalizationStore(
  db: DatabaseSync,
  journal: ToolJournalPort,
): CodingFinalizationStore {
  const read = (requestId: string) =>
    decode(
      db
        .prepare('SELECT ' + columns + ' FROM ocean_coding_finalizations WHERE request_id=?')
        .get(requestId),
    );
  const active = (taskId: string) =>
    decode(
      db
        .prepare(
          'SELECT ' + columns + ' FROM ocean_coding_finalizations WHERE task_id=? AND ' + ACTIVE,
        )
        .get(taskId),
    );
  const write = (record: CodingFinalizationRecord) =>
    db
      .prepare(
        `INSERT INTO ocean_coding_finalizations(request_id,task_id,project_root,state,revision,binding_digest,payload)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(request_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,payload=excluded.payload`,
      )
      .run(
        record.requestId,
        record.taskId,
        record.projectRoot,
        record.state,
        record.revision,
        record.bindingDigest,
        JSON.stringify(record),
      );
  const currentTask = (taskId: string): CodingTask => {
    const task = decodeTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(taskId));
    if (!task) throw Error('finalization_scope_conflict');
    return task;
  };
  const save: CodingFinalizationTransaction['save'] = (record, expectedRevision) => {
    if (
      !validCodingFinalizationRecord(record) ||
      record.bindingDigest !== digest(JSON.stringify(record.preview))
    )
      throw Error('invalid_finalization_record');
    const old = read(record.requestId);
    if ((old?.revision ?? null) !== expectedRevision) return false;
    if (record.revision !== (expectedRevision ?? 0) + 1) return false;
    if (old) {
      const sameIdentity =
        old.taskId === record.taskId &&
        old.projectRoot === record.projectRoot &&
        old.decisionId === record.decisionId &&
        old.bindingDigest === record.bindingDigest &&
        JSON.stringify(old.preview) === JSON.stringify(record.preview) &&
        old.requestId === record.requestId;
      if (!sameIdentity || !codingFinalizationTransition(old.state, record.state)) return false;
    } else if (record.state !== 'preview') return false;
    write(record);
    return true;
  };
  const disable: CodingFinalizationTransaction['disable'] = (record) => {
    const old = read(record.requestId),
      task = currentTask(record.taskId);
    if (
      !old ||
      old.state !== 'preview' ||
      record.state !== 'finalizing' ||
      record.revision !== old.revision + 1 ||
      record.taskId !== old.taskId ||
      record.projectRoot !== old.projectRoot ||
      record.decisionId !== old.decisionId ||
      record.bindingDigest !== old.bindingDigest ||
      JSON.stringify(record.preview) !== JSON.stringify(old.preview) ||
      task.status !== 'reserved' ||
      task.projectRoot !== record.projectRoot
    )
      throw Error('invalid_finalization_transition');
    codingTransaction(db).putTask({ ...task, status: 'finalizing' });
    write(record);
  };
  const publish: CodingFinalizationTransaction['publish'] = (record) => {
    const old = read(record.requestId),
      task = currentTask(record.taskId);
    if (
      !old ||
      old.state !== 'finalizing' ||
      record.state !== 'finalized' ||
      record.revision !== old.revision + 1 ||
      record.bindingDigest !== old.bindingDigest ||
      JSON.stringify(record.preview) !== JSON.stringify(old.preview) ||
      !record.release.receipt ||
      task.status !== 'finalizing'
    )
      throw Error('invalid_finalization_transition');
    codingTransaction(db).putTask({ ...task, status: 'finalized' });
    write(record);
  };
  const hold: CodingFinalizationTransaction['hold'] = (record) => {
    const old = read(record.requestId),
      task = currentTask(record.taskId);
    if (
      !old ||
      old.state !== 'finalizing' ||
      record.state !== 'uncertain' ||
      record.revision !== old.revision + 1 ||
      record.bindingDigest !== old.bindingDigest ||
      JSON.stringify(record.preview) !== JSON.stringify(old.preview) ||
      task.status !== 'finalizing'
    )
      throw Error('invalid_finalization_transition');
    write(record);
  };
  return {
    atomic: (work) =>
      withImmediateTransaction(db, () =>
        work({
          task: (id) =>
            decodeTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
          worktree: (id) => changesetStorage(db).worktree(id),
          participates: (ws, room, bot) => participates(db, ws, room, bot),
          assets: (taskId) => ({
            changesets: db
              .prepare('SELECT hash FROM ocean_changesets WHERE task_id=? ORDER BY rowid')
              .all(taskId)
              .map((row) => String(row['hash'])),
            reviews: db
              .prepare(
                "SELECT id FROM ocean_coding_review_requests WHERE json_extract(payload,'$.binding.taskId')=? ORDER BY rowid",
              )
              .all(taskId)
              .map((row) => String(row['id'])),
            evidence: db
              .prepare('SELECT hash FROM ocean_coding_test_evidence WHERE task_id=? ORDER BY rowid')
              .all(taskId)
              .map((row) => String(row['hash'])),
          }),
          holds: (taskId) => {
            const unresolved = journal.inspectPending?.();
            if (!unresolved) throw Error('finalization_effects_unavailable');
            const holds: CodingFinalizationHold[] = unresolved.map((effect) => ({
              id: effect.id,
              kind: effect.tool,
              outcome: effect.outcome,
              scope: 'global' as const,
            }));
            for (const row of db
              .prepare(
                "SELECT id,status FROM ocean_chat_turns WHERE status IN ('accepted','dispatching','prepared','uncertain') AND json_extract(payload,'$.codingTaskId')=?",
              )
              .all(taskId))
              holds.push({
                id: String(row['id']),
                kind: 'provider',
                outcome: String(row['status']),
                scope: 'task',
              });
            for (const row of db
              .prepare(
                "SELECT id FROM ocean_coding_approvals WHERE json_extract(payload,'$.binding.taskId')=? AND json_extract(payload,'$.status')='pending'",
              )
              .all(taskId))
              holds.push({
                id: String(row['id']),
                kind: 'approval',
                outcome: 'pending',
                scope: 'task',
              });
            for (const row of db
              .prepare(
                `SELECT c.invocation_key AS id FROM ocean_coding_approval_claims c
              JOIN ocean_coding_approvals a ON a.id=c.approval_id
              WHERE json_extract(a.payload,'$.binding.taskId')=?`,
              )
              .all(taskId))
              holds.push({
                id: String(row['id']),
                kind: 'claim',
                outcome: 'claimed',
                scope: 'task',
              });
            for (const row of db
              .prepare(
                "SELECT id FROM ocean_coding_review_requests WHERE json_extract(payload,'$.binding.taskId')=? AND json_extract(payload,'$.status') IN ('requested','dispatching','uncertain')",
              )
              .all(taskId))
              holds.push({
                id: String(row['id']),
                kind: 'review',
                outcome: 'unresolved',
                scope: 'task',
              });
            const worktree = changesetStorage(db).worktree(taskId);
            if (worktree && worktree.state !== 'ready')
              holds.push({
                id: worktree.taskId,
                kind: 'worktree',
                outcome: worktree.state,
                scope: 'task',
              });
            return holds;
          },
          record: read,
          active,
          save,
          disable,
          publish,
          hold,
        }),
      ),
    recover: () =>
      withImmediateTransaction(db, () => {
        for (const row of db
          .prepare('SELECT ' + columns + " FROM ocean_coding_finalizations WHERE state='preview'")
          .all()) {
          const record = decode(row)!;
          write({
            ...record,
            revision: record.revision + 1,
            state: 'refused',
            reason: 'confirmation_interrupted',
          });
        }
      }),
    unresolvedFinalizing: () =>
      db
        .prepare('SELECT ' + columns + " FROM ocean_coding_finalizations WHERE state='finalizing'")
        .all()
        .map((row) => decode(row)!),
    projectHeld: (projectRoot) => projectFinalizationHeld(db, projectRoot),
  };
}
