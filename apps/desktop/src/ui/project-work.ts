import { computed, ref, shallowRef } from 'vue';
import {
  projectWorkspace,
  type OperationKey,
  type OperationStatus,
  type ProjectReplies,
} from '../project-protocol.js';
import type { ProjectRequest } from './project-bridge.js';
import { textDigest, type WorkMemory } from './project-memory.js';
import {
  projectActions,
  projectAdmission,
  projectError,
  projectSendRefused,
} from './project-state.js';
import {
  beginProjectOperation,
  projectPreparationAvailable,
  unresolvedProjectOperation,
} from './project-work-operations.js';

const settled = new Set(['completed', 'failed', 'cancelled']);
type Memory = { read(): WorkMemory | undefined; write(value: WorkMemory): void };
export function createProjectWork(
  request: ProjectRequest,
  memory: Memory,
  taskId: string,
  roomId: string,
) {
  const scope = { workspaceId: projectWorkspace, roomId, taskId } as const;
  const local = shallowRef(memory.read() ?? {});
  const task = shallowRef<ProjectReplies['task'] | null>(null);
  const receipt = shallowRef<ProjectReplies['receipt']>(null);
  const run = shallowRef<ProjectReplies['observe']>(null);
  const diff = shallowRef<ProjectReplies['diff'] | null>(null);
  const tests = shallowRef<ProjectReplies['tests'] | null>(null);
  const history = shallowRef<ProjectReplies['history']>([]);
  const operations = shallowRef<Partial<Record<OperationKey['operation'], OperationStatus>>>({});
  const moreHistory = ref(false),
    text = ref(''),
    error = ref(''),
    busy = ref(false);
  const cancelRequested = computed(() => Boolean(local.value.turn?.cancelId));
  const current = ref(false);
  let closed = false;
  const update = (next: WorkMemory) => {
    memory.write(next);
    local.value = next;
  };
  const savedTurn = () => local.value.turn && { ...scope, requestId: local.value.turn.requestId };
  async function refreshRun() {
    const q = savedTurn();
    if (!q) return;
    receipt.value = await request('receipt', q);
    run.value = receipt.value?.runId ? await request('observe', q) : null;
  }
  async function refreshHistory(reset: boolean) {
    const cursor = reset ? 0 : (history.value.at(-1)?.seq ?? 0);
    const page = await request('history', { ...scope, after: cursor });
    history.value = reset ? page : [...history.value, ...page];
    moreHistory.value = page.length === 30;
  }
  async function readDiff(hash: string) {
    diff.value = await request('diff', { ...scope, hash });
    tests.value = null;
    tests.value = await request('tests', { ...scope, afterTreeHash: diff.value.afterTreeHash });
  }
  async function refreshOperations() {
    for (const key of [local.value.prepare, local.value.review, local.value.apply]) {
      if (!key || closed) continue;
      try {
        const result = await request('operation-status', key);
        operations.value = { ...operations.value, [key.operation]: result };
      } catch (e) {
        error.value = projectError(e);
        operations.value = { ...operations.value, [key.operation]: undefined };
      }
    }
  }
  async function perform(action: () => Promise<void>, invalidate = false) {
    if (busy.value || closed) return;
    busy.value = true;
    error.value = '';
    try {
      await action();
    } catch (e) {
      error.value = projectError(e);
      if (invalidate) current.value = false;
    } finally {
      busy.value = false;
    }
  }
  const refresh = () =>
    perform(async () => {
      current.value = false;
      task.value = await request('task', scope);
      await refreshRun();
      await refreshHistory(true);
      await refreshOperations();
      if (local.value.capture?.hash) {
        try {
          await readDiff(local.value.capture.hash);
        } catch (e) {
          error.value = projectError(e);
        }
      }
      current.value = true;
    }, true);
  const active = computed(() =>
    Boolean(
      run.value && !settled.has(run.value.turnStatus) && run.value.turnStatus !== 'uncertain',
    ),
  );
  const unknownTurn = computed(() => Boolean(local.value.turn && !receipt.value));
  const unknownRun = computed(() => Boolean(receipt.value?.runId && !run.value));
  const review = computed(() =>
    operations.value.review?.operation === 'review' ? operations.value.review.result : null,
  );
  const can = computed(() => {
    const reviewResult = review.value;
    const uncertain = unresolvedProjectOperation(local.value, operations.value);
    return projectActions({
      ready:
        current.value && task.value?.worktreeReady === true && task.value.status === 'reserved',
      active: active.value,
      uncertain:
        uncertain ||
        unknownTurn.value ||
        unknownRun.value ||
        run.value?.turnStatus === 'uncertain' ||
        Boolean(local.value.capture && !local.value.capture.hash),
      hash: diff.value?.hash ?? '',
      reviewedHash: reviewResult?.verdict?.binding.changesetHash ?? '',
      approved:
        reviewResult?.verdict?.verdict === 'approve' &&
        reviewResult.tests === 'matches_snapshot' &&
        Boolean(tests.value?.length) &&
        tests.value?.every((item) => item.state === 'passed') === true,
      stale: reviewResult?.stale ?? true,
    });
  });
  const recoveryReady = computed(
    () => current.value && task.value?.status === 'reserved' && task.value.worktreeReady,
  );
  const canPrepare = computed(
    () =>
      current.value &&
      projectPreparationAvailable(task.value, local.value, operations.value.prepare),
  );
  const send = (recover = false) =>
    perform(async () => {
      const allowed = recover ? recoveryReady.value && unknownTurn.value : can.value.send;
      if (!text.value.trim() || !allowed) return;
      const body = text.value;
      const digest = await textDigest(body);
      const before = local.value.turn;
      if (recover && before?.textDigest !== digest) throw Error('request_conflict');
      const turn = {
        requestId: recover && before ? before.requestId : crypto.randomUUID(),
        textDigest: digest,
      };
      update({ ...local.value, turn });
      run.value = null;
      receipt.value = null;
      try {
        receipt.value = await request('send', { ...scope, requestId: turn.requestId, text: body });
      } catch (e) {
        if (!recover && projectSendRefused(e)) {
          const { turn: _turn, ...rest } = local.value;
          update({ ...rest, ...(before ? { turn: before } : {}) });
          await refreshRun();
        }
        throw e;
      }
      text.value = '';
      await refreshRun();
      await refreshHistory(true);
    });
  const cancel = () =>
    perform(async () => {
      const q = savedTurn(),
        snapshot = run.value;
      if (!q || !snapshot || !active.value) return;
      const previous = local.value;
      if (!previous.turn || previous.turn.cancelId) return;
      const cancelId = crypto.randomUUID();
      update({ ...previous, turn: { ...previous.turn, cancelId } });
      await projectAdmission(
        () => request('cancel', { ...q, cancelId, expectedVersion: snapshot.version }),
        () => update(previous),
      );
      await refreshRun();
    });
  const capture = (recover = false) =>
    perform(async () => {
      const pending = local.value.capture && !local.value.capture.hash;
      const allowed = recover ? recoveryReady.value && pending : can.value.capture;
      if (!allowed || !task.value) return;
      const key = recover
        ? local.value.capture!
        : { requestId: crypto.randomUUID(), policyVersion: task.value.policyVersion };
      const previous = local.value,
        previousDiff = diff.value,
        previousTests = tests.value;
      update({ ...previous, capture: key });
      diff.value = null;
      tests.value = null;
      const summary = await projectAdmission(
        () =>
          request('capture', {
            ...scope,
            requestId: key.requestId,
            expectedPolicyVersion: key.policyVersion,
          }),
        () => {
          if (!recover) {
            update(previous);
            diff.value = previousDiff;
            tests.value = previousTests;
          }
        },
      );
      update({ ...local.value, capture: { ...key, hash: summary.hash } });
      await readDiff(summary.hash);
    });
  const begin = (operation: 'prepare' | 'review' | 'apply') =>
    perform(async () => {
      const { value: info } = task;
      if (!info || (operation === 'prepare' ? !canPrepare.value : !can.value[operation])) return;
      const requestId = crypto.randomUUID();
      const key: OperationKey = {
        ...scope,
        roomId: operation === 'review' ? info.reviewRoomId : roomId,
        requestId,
        operation,
      };
      const previous = local.value,
        previousOperations = operations.value;
      update({ ...previous, [operation]: key });
      operations.value = { ...previousOperations, [operation]: undefined };
      const restore = () => {
        update(previous);
        operations.value = previousOperations;
      };
      const status = await projectAdmission(
        () => beginProjectOperation(request, key, info, diff.value, review.value),
        restore,
      );
      if (status.operation === 'prepare' && !status.result.decision) {
        const { prepare: _prepare, ...rest } = local.value;
        update(rest);
        task.value = await request('task', scope);
      } else operations.value = { ...operations.value, [operation]: status };
    });
  async function observeCurrent() {
    if (busy.value || closed || !current.value || !local.value.turn) return;
    await perform(async () => {
      const version = run.value?.version;
      await refreshRun();
      if (run.value?.version !== version && !moreHistory.value) await refreshHistory(false);
    }, true);
  }
  return {
    local,
    task,
    receipt,
    run,
    diff,
    tests,
    history,
    operations,
    moreHistory,
    text,
    error,
    busy,
    active,
    unknownTurn,
    unknownRun,
    can,
    canPrepare,
    cancelRequested,
    review,
    recoveryReady,
    refresh,
    send,
    cancel,
    capture,
    begin,
    savedTurn,
    observeCurrent,
    nextHistory: () => perform(() => refreshHistory(false)),
    close: () => {
      closed = true;
    },
  };
}
