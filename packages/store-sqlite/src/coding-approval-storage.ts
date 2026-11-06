import { roomHostPhysicalScope } from './room-host-command.js';
import type { RoomHostBinding } from './room-host-storage.js';
import { readToolAdmission, exactCodingReceipt } from './coding-journal-receipt.js';
import {
  boundCodingEffect,
  codingRoomBasisMatches,
  codingReadAdmission,
} from '@runnets/application';
import { digest } from './coding-claim-evidence.js';
import { codingProjectId } from './service-run-scope.js';
import { readAuthorityGrant } from './service-authority-rows.js';
import { changesetStorage } from './changeset-storage.js';
import { SqliteToolJournal } from './tool-journal.js';
import { task as decodeTask } from './coding-store.js';
import type { DatabaseSync } from 'node:sqlite';
import type { CodingApprovalStore, CodingApprovalTransaction } from '@runnets/application';
import {
  assertCodingApprovalTransition,
  canonicalJson,
  codingApprovalClaimKey,
  type CodingApproval,
} from '@runnets/domain';
import { withImmediateTransaction } from './transaction.js';

export class SqliteCodingApprovalStore implements CodingApprovalStore {
  readonly #db: DatabaseSync;
  readonly #journal: SqliteToolJournal;
  readonly #host: RoomHostBinding;
  constructor(
    db: DatabaseSync,
    journal = new SqliteToolJournal(db),
    host: RoomHostBinding = () => null,
  ) {
    this.#host = host;
    this.#db = db;
    this.#journal = journal;
  }
  atomic<T>(work: (tx: CodingApprovalTransaction) => T): T {
    const db = this.#db;
    return withImmediateTransaction(db, () => {
      const approval = (id: string): CodingApproval | null => {
        const row = db.prepare('SELECT payload FROM ocean_coding_approvals WHERE id=?').get(id);
        if (!row) return null;
        const value = JSON.parse(String(row['payload'])) as CodingApproval;
        if (value.id !== id) throw Error('invalid approval identity');
        return value;
      };
      const tx: CodingApprovalTransaction = {
        roomScope: (run, at, selection) =>
          roomHostPhysicalScope(db, this.#host, run, at, selection),
        projectId: codingProjectId,
        grants: () =>
          db
            .prepare('SELECT id FROM ocean_owner_scope_grants ORDER BY id')
            .all()
            .map((r) => readAuthorityGrant(db, String(r['id']))!),
        grantCalls: (run, id) => this.#journal.grantCalls(run, id),
        claimRead: (r, admission, at) => {
          const p = codingReadAdmission(tx, r, at);
          return (
            !!p &&
            canonicalJson(p.preview.effect) === canonicalJson(admission) &&
            this.#journal.claimNow(
              r.invocationId,
              'coding_read',
              { taskRunId: r.runId, attemptId: r.attemptId },
              canonicalJson(r),
              admission,
              at,
            )
          );
        },
        readClaimed: (r, admission, at) => {
          const p = codingReadAdmission(tx, r, at, true);
          if (!p || canonicalJson(p.preview.effect) !== canonicalJson(admission)) return false;
          const row = db
            .prepare(
              "SELECT admission,fingerprint FROM tool_invocations_v2 WHERE task_run_id=? AND attempt_id=? AND id=? AND tool='coding_read' AND outcome='started'",
            )
            .get(r.runId, r.attemptId, r.invocationId);
          return (
            !!row &&
            row['fingerprint'] === digest(canonicalJson(r)) &&
            canonicalJson(readToolAdmission(row['admission'])) === canonicalJson(admission) &&
            !this.#journal
              .inspectConflicts(admission)
              .some(
                (e) =>
                  e.taskRunId !== r.runId || e.attemptId !== r.attemptId || e.id !== r.invocationId,
              )
          );
        },
        settleRead: (r, outcome) =>
          this.#journal.settleNow(r.invocationId, outcome, {
            taskRunId: r.runId,
            attemptId: r.attemptId,
          }),
        claimed: (a, at) => {
          if (at === undefined && tx.roomScope?.(a.binding.runId, NaN) !== null) return false;
          if (
            !codingRoomBasisMatches(tx, a.binding, a.preview, at ?? Date.now(), a.roomBasis, true)
          )
            return false;
          const b = a.binding;
          const row = db
            .prepare(
              `SELECT j.admission FROM tool_invocations_v2 j JOIN ocean_coding_approval_claims c ON c.invocation_key=? AND c.approval_id=?
            WHERE j.id=? AND j.task_run_id=? AND j.attempt_id=? AND j.tool=? AND j.outcome='started' AND j.fingerprint=?`,
            )
            .get(
              codingApprovalClaimKey(a),
              a.id,
              b.invocationId,
              b.runId,
              b.attemptId,
              'coding_' + b.operation,
              digest(JSON.stringify({ ...a, status: 'allowed' })),
            );
          return exactCodingReceipt(a, readToolAdmission(row?.['admission']));
        },
        worktree: (id) => changesetStorage(db).worktree(id),
        task: (id) => decodeTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id)),
        participates: (ws, room, bot) =>
          db
            .prepare('SELECT 1 FROM ocean_members WHERE workspace_id=? AND room_id=? AND bot_id=?')
            .get(ws, room, bot) !== undefined,
        approval,
        putApproval: (value) => {
          assertCodingApprovalTransition(approval(value.id), value);
          if (
            value.status === 'consumed' &&
            !db
              .prepare(
                'SELECT 1 FROM ocean_coding_approval_claims WHERE invocation_key=? AND approval_id=?',
              )
              .get(codingApprovalClaimKey(value), value.id)
          )
            throw Error('missing approval dispatch claim');
          db.prepare(
            'INSERT INTO ocean_coding_approvals VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
          ).run(value.id, JSON.stringify(value));
        },
        claimApprovalOperation: (value, at) => {
          if (at === undefined && tx.roomScope?.(value.binding.runId, NaN) !== null) return false;
          const stored = approval(value.id);
          if (
            !stored ||
            stored.status !== 'allowed' ||
            JSON.stringify(stored) !== JSON.stringify(value)
          )
            return false;
          if (
            !codingRoomBasisMatches(
              tx,
              value.binding,
              value.preview,
              at ?? Date.now(),
              value.roomBasis,
            )
          )
            return false;
          const key = codingApprovalClaimKey(value);
          if (
            db
              .prepare(
                'SELECT 1 FROM ocean_coding_approval_claims WHERE invocation_key=? OR approval_id=?',
              )
              .get(key, value.id)
          )
            return false;
          const b = value.binding;
          if (
            !this.#journal.claimNow(
              b.invocationId,
              'coding_' + b.operation,
              { taskRunId: b.runId, attemptId: b.attemptId },
              JSON.stringify(value),
              value.guardedDispatch === true
                ? boundCodingEffect(
                    b,
                    value.grantReference ?? null,
                    codingProjectId(b.projectRoot),
                    value.roomBasis,
                  )
                : undefined,
              at,
            )
          )
            return false;
          return (
            db
              .prepare('INSERT OR IGNORE INTO ocean_coding_approval_claims VALUES(?,?)')
              .run(codingApprovalClaimKey(value), value.id).changes === 1
          );
        },
      };
      return work(tx);
    });
  }
}
