import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
/** Redacted physical model evidence; preserves positional public event checks separately. */
export function admissionModelWitness(profile: string, runId: string) {
  const db = new DatabaseSync(profile + '/runtime.sqlite', { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT sequence,type,payload FROM events WHERE aggregate_id=? ORDER BY sequence')
      .all(runId);
    const starts = rows.filter((r) => r['type'] === 'attempt.model_request_started');
    const settlements = rows.filter((r) => r['type'] === 'attempt.model_request_settled');
    const payload = JSON.parse(String(settlements.at(-1)?.['payload'] ?? 'null')) as {
      completion: { kind: string };
      usage: { kind: string };
    } | null;
    return {
      starts: starts.length,
      settlements: settlements.length,
      completion: payload?.completion.kind ?? null,
      usage: payload?.usage.kind ?? null,
      tail: rows.slice(-3).map((r) => ({ sequence: r['sequence'], type: r['type'] })),
    };
  } finally {
    db.close();
  }
}

export function assertAdmissionModelWitness(
  profile: string,
  runId: string,
  scenario: string,
  known: boolean,
) {
  const physical = admissionModelWitness(profile, runId);
  assert.equal(physical.starts, 1);
  assert.equal(physical.settlements, 1);
  assert.equal(physical.completion, known ? 'terminal' : 'unknown');
  assert.equal(physical.usage, known ? 'actual' : 'unavailable');
  console.log(JSON.stringify({ scenario, physical }));
}
