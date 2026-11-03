// Run from the built checkout. The only Ocean dependency is the public client.
import { connectLocalRuntime } from '@runnets/tools-node/local-runtime-client';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
const [profile, action = 'status', roomId, id, extra] = process.argv.slice(2);
const c = await connectLocalRuntime({ profile });
const workspaceId = 'ws_ocean',
  scope = { workspaceId, roomId },
  run = { ...scope, runId: id };
const output = (data) =>
  process.stdout.write(
    JSON.stringify(data).replace(
      /[^\x20-\x7e]/g,
      (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
    ) + '\n',
  );
try {
  switch (action) {
    case 'status':
      output(await c.status());
      break;
    case 'rooms':
      output(await c.listRooms({ workspaceId, ...(roomId ? { after: roomId } : {}) }));
      break;
    case 'history':
      output(await c.history({ ...scope, after: Number(id ?? 0) }));
      break;
    case 'submit': {
      const reader = createInterface({ input: process.stdin });
      try {
        const { value: text, done } = await reader[Symbol.asyncIterator]().next();
        if (done || typeof text !== 'string') throw Error('expected one line of text on stdin');
        output(await c.submit({ ...scope, requestId: id, text, ...(extra ? { to: extra } : {}) }));
      } finally {
        reader.close();
      }
      break;
    }
    case 'resume':
      output(await c.getReceipt({ ...scope, requestId: id }));
      break;
    case 'observe':
      output(await c.observeRun({ ...run, ...(extra ? { cursor: extra, waitMs: 10000 } : {}) }));
      break;
    case 'result':
      output(await c.getResult(run));
      break;
    case 'decide': {
      const ref = { ...run, decisionId: extra };
      const card = await c.getDecision(ref);
      output(card);
      output(await c.decisionPreview(ref));
      if (card.status !== 'pending') break;
      process.stdout.write('Enter allow-once or deny for this displayed operation.\n');
      const reader = createInterface({ input: process.stdin });
      try {
        const { value: choice } = await reader[Symbol.asyncIterator]().next();
        if (choice !== 'allow-once' && choice !== 'deny') throw Error('explicit vote required');
        output(
          await c.resolveDecision({
            ...ref,
            choice,
            bindingDigest: card.bindingDigest,
            expectedVersion: card.version,
          }),
        );
      } finally {
        reader.close();
      }
      break;
    }
    default:
      throw Error('expected status, rooms, history, submit, resume, observe, result or decide');
  }
} finally {
  c.close();
}
