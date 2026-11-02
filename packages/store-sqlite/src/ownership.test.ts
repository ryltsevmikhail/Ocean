import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { acquireOwnership } from './ownership.js';

it('refuses a live owner and permits takeover only after disproving owner liveness', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const oldRelease = acquireOwnership(db, { id: 'old', pid: 12 }, () => false);
    expect(() => acquireOwnership(db, { id: 'other', pid: 13 }, () => true)).toThrow('owned');
    const release = acquireOwnership(db, { id: 'new', pid: 14 }, () => false);
    oldRelease();
    expect(() => acquireOwnership(db, { id: 'third', pid: 15 }, () => true)).toThrow('owned');
    release();
    const next = acquireOwnership(db, { id: 'third', pid: 15 }, () => true);
    next();
  } finally {
    db.close();
  }
});
