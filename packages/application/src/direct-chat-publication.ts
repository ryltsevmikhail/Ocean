import { taskRunId, type ChatTurn } from '@runnets/domain';
import type { ConversationStore } from './conversation-ports.js';
import type { TaskRunService } from './service.js';
import type { Clock } from './ports.js';

/** Publish only a proven succeeded task with its complete prepared response. */
export async function publishChat(
  store: ConversationStore,
  tasks: TaskRunService,
  clock: Clock,
  turn: ChatTurn,
): Promise<ChatTurn> {
  const state = await tasks.state(taskRunId(turn.taskRunId));
  if (state.status !== 'succeeded') throw new Error('chat task has not succeeded');
  return store.atomic((tx) => {
    const current = tx.chatTurn(turn.id);
    if (current === null) throw new Error('chat turn missing');
    if (current.status === 'completed') return current;
    if (current.continuationReviewId !== undefined)
      throw new Error('Reviewed turns cannot publish late output');
    if (current.status !== 'prepared') throw new Error('chat answer is not prepared');
    tx.putMessage({
      id: 'reply_' + turn.id,
      workspaceId: turn.workspaceId,
      roomId: turn.roomId,
      seq: tx.nextSequence(turn.roomId),
      author: 'bot',
      authorBotId: turn.bot.id,
      turnId: turn.id,
      targetBotId: turn.bot.id,
      body: current.text,
      createdAt: clock.now().toISOString(),
    });
    const completed = { ...current, status: 'completed' as const };
    tx.putChatTurn(completed);
    return completed;
  });
}

/** Recover local completion/publication before generic task reconciliation, without dispatch. */
export async function recoverChats(
  store: ConversationStore,
  tasks: TaskRunService,
  clock: Clock,
): Promise<void> {
  const turns = store.atomic((tx) => tx.chatTurns());
  for (const turn of turns) {
    // A queued broadcast child was never dispatched; batch recovery owns its state.
    if (['queued', 'completed', 'failed', 'cancelled', 'uncertain'].includes(turn.status)) continue;
    let state = await tasks.state(taskRunId(turn.taskRunId));
    if (
      turn.status === 'prepared' &&
      state.status === 'running' &&
      state.version === turn.preparedVersion
    ) {
      const result = await tasks.execute({
        type: 'Complete',
        commandId: 'chat-complete-' + turn.id,
        taskRunId: taskRunId(turn.taskRunId),
        expectedVersion: state.version,
        actor: { kind: 'runtime', id: 'ocean' },
        payload: {
          summary: turn.text.trim().slice(0, 1024),
          attemptId: state.activeAttempt?.attemptId ?? '',
        },
      });
      if (!result.ok) throw result.error;
      state = await tasks.state(taskRunId(turn.taskRunId));
    }
    if (turn.status === 'prepared' && state.status === 'succeeded') {
      await publishChat(store, tasks, clock, turn);
    } else {
      store.atomic((tx) =>
        tx.putChatTurn({ ...turn, status: turn.status === 'accepted' ? 'failed' : 'uncertain' }),
      );
    }
  }
}
