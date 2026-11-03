import { randomUUID, createHash } from 'node:crypto';
import {
  ProfileRebindService,
  type ProfileRebindStore,
  type RuntimeOwnerDecisions,
} from '@runnets/application';
import { validCodingBackupPolicy } from '@runnets/domain';
import {
  isLocalRestoreInspect,
  isLocalRestoreSelection,
  type LocalRestoreInspect,
  type LocalRestoreResult,
} from '@runnets/contracts';
import {
  RestoredProfileFiles,
  SqliteProjectLeases,
  GitCodingProject,
  GitCodingApplyProject,
} from '@runnets/tools-node';
import { readProfileRestoreSnapshot } from '@runnets/store-sqlite';
import type { RuntimeReply } from './queries.js';
export class RuntimeRestoration {
  readonly #store: ProfileRebindStore;
  readonly #files: RestoredProfileFiles;
  readonly #service: ProfileRebindService;
  readonly #jobs = new Set<Promise<RuntimeReply>>();
  #closing = false;
  constructor(profile: string, store: ProfileRebindStore, owner: RuntimeOwnerDecisions) {
    this.#store = store;
    this.#files = new RestoredProfileFiles(profile, readProfileRestoreSnapshot);
    this.#service = new ProfileRebindService({
      store,
      files: this.#files,
      owner,
      leases: new SqliteProjectLeases(),
      now: Date.now,
      nextId: randomUUID,
      digest: (s) => createHash('sha256').update(s).digest('hex'),
    });
  }
  dispatch(method: string, params: Record<string, unknown>): Promise<RuntimeReply> {
    if (this.#closing) return Promise.resolve({ error: { code: 'runtime_draining' } });
    if (this.#jobs.size >= 2) return Promise.resolve({ error: { code: 'query_limit' } });
    const job = this.#dispatch(method, params).finally(() => this.#jobs.delete(job));
    this.#jobs.add(job);
    return job;
  }
  async #dispatch(method: string, params: Record<string, unknown>): Promise<RuntimeReply> {
    try {
      if (method === 'restore.inspect' && isLocalRestoreInspect(params))
        return { result: await this.#inspect(params) };
      if (!isLocalRestoreSelection(params)) throw Error('invalid_params');
      if (method === 'restore.preview') return { result: await this.#service.preview(params) };
      if (method === 'restore.result') {
        const record = this.#service.result(params),
          p = record.preview;
        const result: LocalRestoreResult = {
          workspaceId: params.workspaceId,
          roomId: params.roomId,
          requestId: record.requestId,
          snapshotId: p.origin.snapshotId,
          epochId: p.epochId,
          successorTaskId: p.successorTaskId,
          bindingDigest: record.bindingDigest,
          state: record.state,
          reason: record.reason,
        };
        return { result };
      }
      throw Error('invalid_params');
    } catch (e) {
      return {
        error: {
          code:
            e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'restore_unavailable',
        },
      };
    }
  }
  async #inspect(input: LocalRestoreInspect) {
    if (!validCodingBackupPolicy(1, input.policy)) throw Error('invalid_input');
    const scope = this.#store.atomic((tx) => {
      const origin = tx.origin(),
        task = tx.task(input.taskId);
      if (!origin) throw Error('restore_again_from_archive_required');
      if (
        !task ||
        task.workspaceId !== input.workspaceId ||
        task.ownerRoomId !== input.roomId ||
        !origin.sourceOwners.includes(task.lease.ownerId) ||
        !tx.participates(task.workspaceId, task.ownerRoomId, task.devBotId)
      )
        throw Error('rebind_scope_conflict');
      return { origin, task, holds: tx.holds() };
    });
    const project = await new GitCodingProject().inspect(input.projectRoot);
    if (project.root !== input.projectRoot || project.baseCommit !== scope.task.baseCommit)
      throw Error('rebind_project_changed');
    const selection = {
      ...input,
      profileId: scope.origin.profileId,
      snapshotId: scope.origin.snapshotId,
      sourceOwnerId: scope.task.lease.ownerId,
      baseCommit: project.baseCommit,
      treeHash: await new GitCodingApplyProject().tree(project.root, project.baseCommit),
    };
    const observations = this.#files.diagnose(scope.origin, scope.task, project.root);
    this.#store.atomic((tx) => {
      if (
        JSON.stringify(tx.task(input.taskId)) !== JSON.stringify(scope.task) ||
        JSON.stringify(tx.origin()) !== JSON.stringify(scope.origin)
      )
        throw Error('rebind_inputs_changed');
      tx.observe({
        id: randomUUID(),
        selection,
        observedAt: Date.now(),
        holds: scope.holds,
        observations,
      });
    });
    return {
      selection,
      holds: scope.holds,
      observations,
      postSnapshotInterval: 'unknown-never-replayed',
    };
  }
  async drain(): Promise<void> {
    this.#closing = true;
    await this.#service.close();
    await Promise.all([...this.#jobs]);
  }
}
