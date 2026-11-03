import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { acquireOwnership } from './ownership.js';

it('refuses a live owner and permits takeover only after disproving owner liveness', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const oldRelease = acquireOwnership(db, { id: randomUUID(), pid: 12 }, () => false);
    expect(() => acquireOwnership(db, { id: randomUUID(), pid: 13 }, () => true)).toThrow('owned');
    const release = acquireOwnership(db, { id: randomUUID(), pid: 14 }, () => false);
    oldRelease();
    expect(() => acquireOwnership(db, { id: randomUUID(), pid: 15 }, () => true)).toThrow('owned');
    release();
    const next = acquireOwnership(db, { id: randomUUID(), pid: 15 }, () => true);
    next();
  } finally {
    db.close();
  }
});
