import { ToolService, type ToolInvocation } from '@runnets/application';
import { expect, it } from 'vitest';
import type { ToolEffectAdmission } from '@runnets/application';
import { DatabaseSync } from 'node:sqlite';
import { SqliteToolJournal } from './tool-journal.js';
import { initializeSchema } from './schema.js';
const ctx = { taskRunId: 'run', attemptId: 'at' };
function admission(
  repo: string,
  effectKind: ToolEffectAdmission['effectKind'] = 'mutation',
): ToolEffectAdmission {
  return {
    scope: {
      kind: 'resources',
      resources: [
        { kind: 'github-repository', connectionId: 'conn', accountId: 'acct', repository: repo },
      ],
    },
    effectKind,
    grantReference: { grantId: 'g', revision: 1 },
    binding: {
      tool: 'tool',
      githubRepositoryIds: { [repo.toLowerCase()]: repo === 'owner/other' ? '2' : '1' },
    },
  };
}
it('partitions qualified effects, permits a trusted observation and preserves replay exclusion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    const j = new SqliteToolJournal(db);
    expect(j.claimNow('i', 'tool', ctx, 'payload', admission('owner/Repo'))).toBe(true);
    j.settleNow('i', 'uncertain', ctx);
    expect(j.claimNow('i', 'tool', ctx, 'changed', admission('owner/other'))).toBe(false);
    expect(j.claimNow('j', 'tool', ctx, 'changed', admission('OWNER/repo'))).toBe(false);
    expect(j.claimNow('alias', 'tool', ctx, 'changed', admission('owner/renamed'))).toBe(false);
    expect(
      j.claimNow('unproven', 'tool', ctx, 'changed', { ...admission('owner/other'), binding: {} }),
    ).toBe(false);
    expect(j.claimNow('k', 'tool', ctx, 'changed', admission('owner/other'))).toBe(true);
    expect(j.claimNow('read', 'tool', ctx, 'read', admission('owner/Repo', 'observation'))).toBe(
      true,
    );
    expect(j.inspectPending()[0]?.admission).toEqual(admission('owner/Repo'));
    expect(j.grantCalls('run', 'g')).toBe(3);
  } finally {
    db.close();
  }
});
it('uses scoped holds before ToolService preparation without promoting a read hint or clearing uncertainty', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    const journal = new SqliteToolJournal(db);
    expect(journal.claimNow('lost', 'tool', ctx, 'lost', admission('owner/Repo'))).toBe(true);
    journal.settleNow('lost', 'uncertain', ctx);
    let prepared = 0;
    const executor = {
      definitions: [],
      classify: (call: ToolInvocation) =>
        admission(
          call.name === 'other' ? 'owner/other' : 'owner/Repo',
          call.name === 'reconcile' ? 'observation' : 'mutation',
        ),
      prepare: async () => {
        prepared++;
        return {
          title: 'tool',
          preview: 'tool',
          kind: 'read' as const,
          execute: async () => ({ isError: false, output: 'ok' }),
        };
      },
    };
    const tools = new ToolService(executor, { review: async () => 'allow_once' }, journal);
    const invoke = (name: string) =>
      tools.execute({ id: name, name, arguments: '{}' }, new AbortController().signal, ctx);
    expect((await invoke('unsafe-read')).uncertain).toBe(true);
    expect(prepared).toBe(0);
    expect((await invoke('other')).isError).toBe(false);
    expect((await invoke('reconcile')).isError).toBe(false);
    expect(prepared).toBe(2);
    expect(journal.inspectPending().map((r) => r.id)).toEqual(['lost']);
  } finally {
    db.close();
  }
});
it('exposes a malformed historical scope as unknown and rejects malformed new scope before any claim', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = new SqliteToolJournal(db);
    const bad = {
      ...admission('owner/Repo'),
      scope: { kind: 'resources' as const, resources: [] },
    };
    expect(() => journal.claimNow('bad', 'tool', ctx, 'request', bad)).toThrow(
      'invalid tool effect admission',
    );
    expect(journal.inspectPending()).toEqual([]);
    db.prepare(
      "INSERT INTO tool_invocations_v2 VALUES('old','tool','run','at','old-fingerprint','uncertain',?)",
    ).run(JSON.stringify(bad));
    expect(journal.inspectPending()[0]).toMatchObject({
      id: 'old',
      outcome: 'uncertain',
      fingerprint: 'old-fingerprint',
    });
    expect(journal.inspectPending()[0]?.admission).toBeUndefined();
    expect(
      journal.claimNow('new', 'tool', ctx, 'new', admission('owner/other', 'observation')),
    ).toBe(false);
  } finally {
    db.close();
  }
});
