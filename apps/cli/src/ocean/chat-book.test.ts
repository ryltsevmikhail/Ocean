import { applyUpdate } from '../tui/runs.js';
import { expect, it, vi } from 'vitest';
import { createRuntime } from '../runtime.js';
import { ChatRunBook } from './chat-book.js';
it('forwards the selected task and pending cancellation from TUI to common chat service', async () => {
  const runtime = createRuntime({ mode: 'ephemeral' });
  try {
    const conversations = runtime.conversations;
    conversations.execute({
      type: 'BindWorkspace',
      workspaceId: 'ws_ocean',
      requestId: 'init',
      root: '/project',
    });
    const bot = conversations.execute({
      type: 'CreateBot',
      workspaceId: 'ws_ocean',
      requestId: 'bot',
      handle: 'dev',
      name: 'Dev',
      role: 'Role',
      provider: 'fixture',
      model: 'fixture',
    });
    if (!bot.ok || bot.value.kind !== 'bot') throw Error('fixture bot');
    const room = conversations.execute({
      type: 'OpenDirectRoom',
      workspaceId: 'ws_ocean',
      requestId: 'room',
      botId: bot.value.data.id,
    });
    if (!room.ok || room.value.kind !== 'room') throw Error('fixture room');
    const send = vi.spyOn(runtime.chat, 'send').mockImplementation(async (input) => {
      input.emit({
        sessionUpdate: 'tool_call',
        toolCallId: 'test',
        title: 'run_test',
        kind: 'execute',
        status: 'pending',
      });
      input.emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'test',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'exitCode=0 cleanupConfirmed=true' } },
        ],
      });
      expect(input.taskId).toBe('task');
      expect(input.signal.aborted).toBe(true);
      return {
        ok: true,
        value: {
          status: 'recorded',
          roomId: room.value.data.id,
          messageId: 'fixture',
          taskRunId: null,
        },
      };
    });
    const book = new ChatRunBook(runtime, room.value.data.id, null, 'task');
    await book.restore();
    const entry = await book.add(null);
    book.cancel();
    await book.turn(entry, 'Hello', (update) => applyUpdate(entry, update));
    expect(
      entry.stream.some(
        (line) => line.kind === 'tool' && line.text.includes('cleanupConfirmed=true'),
      ),
    ).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  } finally {
    runtime.close();
  }
});
