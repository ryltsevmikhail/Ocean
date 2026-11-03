import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  validCodingRecoveryProtocol,
  validCodingBackupFiles,
  validCodingBackupPolicy,
  type CodingBackupInventory,
  type CodingApplyReceipt,
  type CodingFileContent,
} from '@runnets/domain';
import { task as decodeTask } from './coding-store.js';
import { changesetStorage } from './changeset-storage.js';
import { SCHEMA_VERSION } from './schema.js';
import { ownerBusy } from './maintenance-owner.js';
const MAX_TASKS = 1000,
  MAX_RECORDS = 10000,
  MAX_PAYLOAD = 67108864;
/** Read only verified snapshot metadata. Never opens any path referenced by its contents. */
export function readCodingBackupInventory(path: string): CodingBackupInventory {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (ownerBusy(db)) throw Error('owner_busy');
    return readMaintenanceCodingInventory(db);
  } finally {
    db.close();
  }
}
/** Internal only: caller already holds maintenance ownership of this connection. */
export function readMaintenanceCodingInventory(db: DatabaseSync): CodingBackupInventory {
  try {
    const version = Number(
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.['value'],
    );
    if (!Number.isSafeInteger(version) || version < 5 || version > SCHEMA_VERSION)
      throw Error('unsupported_schema');
    db.exec('BEGIN');
    if (db.prepare('PRAGMA foreign_key_check').all().length !== 0)
      throw Error('invalid_coding_inventory');
    let payloadBytes = 0,
      metadataBytes = 0;
    // Table/column names are fixed adapter constants, never input data.
    const ids = (table: string, key: string, limit: number) => {
      const rows = db
        .prepare(
          `SELECT ${key} AS id,length(CAST(payload AS BLOB)) AS bytes FROM ${table} ORDER BY ${key} LIMIT ?`,
        )
        .all(limit + 1);
      if (rows.length > limit) throw Error('coding_inventory_limit');
      return rows.map((row) => {
        const bytes = Number(row['bytes']);
        payloadBytes += bytes;
        if (!Number.isSafeInteger(bytes) || bytes > MAX_PAYLOAD || payloadBytes > 268435456)
          throw Error('coding_inventory_limit');
        return String(row['id']);
      });
    };
    const bounded = <T>(value: T): T => {
      metadataBytes += Buffer.byteLength(JSON.stringify(value));
      if (metadataBytes > 16777216) throw Error('coding_inventory_limit');
      return value;
    };
    const text = (value: unknown): value is string =>
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4096 &&
      !value.includes('\0');
    const revision = (value: unknown) =>
      typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
    const treeHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const tasks: CodingBackupInventory['tasks'][number][] = [];
    if (version >= 6)
      for (const id of ids('ocean_coding_tasks', 'id', MAX_TASKS)) {
        const value = decodeTask(db.prepare('SELECT * FROM ocean_coding_tasks WHERE id=?').get(id));
        if (
          !value ||
          !text(value.id) ||
          !validCodingBackupPolicy(value.policyVersion, value.policy) ||
          !text(value.workspaceId) ||
          !text(value.projectRoot) ||
          !revision(value.baseCommit) ||
          !text(value.lease?.ownerId) ||
          value.lease.taskId !== id ||
          value.lease.projectRoot !== value.projectRoot ||
          !['reserved', 'cancelled', 'finalizing', 'finalized'].includes(value.status)
        )
          throw Error('invalid_coding_inventory');
        tasks.push(
          bounded({
            id,
            workspaceId: value.workspaceId,
            policyVersion: value.policyVersion,
            policy: value.policy,
            projectRoot: value.projectRoot,
            baseCommit: value.baseCommit,
            worktreeRoot: value.worktreeRoot ?? null,
            ownerId: value.lease.ownerId,
            status: value.status,
          }),
        );
      }
    const byTask = new Map(tasks.map((value) => [value.id, value]));
    const artifacts = changesetStorage(db);
    const worktrees: CodingBackupInventory['worktrees'][number][] = [];
    if (version >= 7)
      for (const id of ids('ocean_worktrees', 'task_id', MAX_TASKS)) {
        const value = artifacts.worktree(id),
          task = byTask.get(id);
        if (
          !value ||
          !task ||
          !text(value.root) ||
          !text(value.branch) ||
          !text(value.gitCommonDir) ||
          value.root !== task.worktreeRoot ||
          value.projectRoot !== task.projectRoot ||
          value.workspaceId !== task.workspaceId ||
          value.baseCommit !== task.baseCommit ||
          value.lease.ownerId !== task.ownerId ||
          value.lease.taskId !== id ||
          value.lease.projectRoot !== value.root ||
          !['preparing', 'ready', 'uncertain'].includes(value.state)
        )
          throw Error('invalid_coding_inventory');
        worktrees.push(bounded(value));
      }
    const byWorktree = new Map(worktrees.map((value) => [value.taskId, value]));
    if (tasks.some((value) => value.worktreeRoot !== null && !byWorktree.has(value.id)))
      throw Error('invalid_coding_inventory');
    const descriptor = (content: CodingFileContent | null) => {
      if (content === null) return null;
      if (
        !content ||
        !['100644', '100755'].includes(content.mode) ||
        typeof content.text !== 'string' ||
        content.text.includes('\0') ||
        Buffer.byteLength(content.text) > 131072 ||
        Buffer.from(content.text).toString('utf8') !== content.text ||
        createHash('sha256').update(content.text).digest('hex') !== content.sha256
      )
        throw Error('invalid_coding_inventory');
      return { mode: content.mode, sha256: content.sha256 };
    };
    const changesets: CodingBackupInventory['changesets'][number][] = [];
    if (version >= 7)
      for (const hash of ids('ocean_changesets', 'hash', MAX_RECORDS)) {
        const value = artifacts.changeset(hash),
          task = value ? byTask.get(value.taskId) : null;
        if (
          !value ||
          !task ||
          !byWorktree.has(task.id) ||
          value.baseCommit !== task.baseCommit ||
          !treeHash(value.beforeTreeHash) ||
          !treeHash(value.afterTreeHash) ||
          value.files.length > 1000
        )
          throw Error('invalid_coding_inventory');
        const paths = new Set<string>();
        const files = value.files.map(({ path, before, after }) => {
          if (!text(path) || paths.has(path) || (!before && !after))
            throw Error('invalid_coding_inventory');
          paths.add(path);
          return { path, before: descriptor(before), after: descriptor(after) };
        });
        changesets.push(
          bounded({
            hash,
            taskId: value.taskId,
            baseCommit: value.baseCommit,
            beforeTreeHash: value.beforeTreeHash,
            afterTreeHash: value.afterTreeHash,
            files,
          }),
        );
      }
    const byChangeset = new Map(changesets.map((value) => [value.hash, value]));
    const applications: CodingBackupInventory['applications'][number][] = [];
    if (version >= 10)
      for (const id of ids('ocean_coding_applications', 'id', MAX_RECORDS)) {
        const row = db.prepare('SELECT payload FROM ocean_coding_applications WHERE id=?').get(id)!;
        const value = JSON.parse(String(row['payload'])) as CodingApplyReceipt;
        const artifact = byChangeset.get(value.changesetHash);
        if (
          !validCodingRecoveryProtocol(value) ||
          value.id !== id ||
          !text(id) ||
          !artifact ||
          artifact.taskId !== value.taskId ||
          artifact.baseCommit !== value.expectedBase ||
          !['applying', 'completed', 'uncertain', 'not_started'].includes(value.status)
        )
          throw Error('invalid_coding_inventory');
        if (!validCodingBackupFiles(value.files)) throw Error('invalid_coding_inventory');
        if (
          JSON.stringify(value.files.map((file) => file.path)) !==
          JSON.stringify(artifact.files.map((file) => file.path))
        )
          throw Error('invalid_coding_inventory');
        applications.push(
          bounded({
            id,
            taskId: value.taskId,
            changesetHash: value.changesetHash,
            recoveryProtocol: value.recoveryProtocol ?? null,
            files: value.files.map(({ path, status }) => ({ path, status })),
            status: value.status,
          }),
        );
      }
    const body = { format: 1 as const, tasks, worktrees, changesets, applications };
    return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
  } catch (error) {
    if (
      error instanceof Error &&
      ['owner_busy', 'unsupported_schema', 'coding_inventory_limit'].includes(error.message)
    )
      throw error;
    throw Error('invalid_coding_inventory');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
  }
}
