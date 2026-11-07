import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
/** Success requires the actual bounded result delivered back to the scripted provider. */
export function verifyNormalResult(mode: string, content: unknown): void {
  if (mode !== 'http' && mode !== 'stdio') return;
  assert.equal(typeof content, 'string');
  const output = content as string;
  assert.ok(Buffer.byteLength(output) <= 32768);
  const reply = JSON.parse(output) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
  };
  assert.notEqual(reply.isError, true);
  const expected = mode === 'stdio' ? 'owned synthetic canary\n' : 'synthetic result';
  assert.ok(reply.content?.some((part) => part.type === 'text' && part.text === expected));
}
export function verifyNormalJournal(mode: string, path: string): void {
  if (mode !== 'http' && mode !== 'stdio') return;
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare('SELECT tool,outcome FROM tool_invocations_v2').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['tool'], mode === 'stdio' ? 'read_file' : 'write');
    assert.equal(rows[0]?.['outcome'], 'completed');
  } finally {
    db.close();
  }
}
