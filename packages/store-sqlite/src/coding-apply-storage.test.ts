import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import type { CodingApplyReceipt } from '@runnets/domain';
import { openSqliteStore } from './index.js';
import { SqliteToolJournal } from './tool-journal.js';

const intent: CodingApplyReceipt = {
  id: 'apply-one',
  taskId: 'task',
  changesetHash: 'changeset',
  reviewRequestId: 'review',
  expectedBase: 'base',
  status: 'applying',
  files: [
    { path: 'one.ts', status: 'pending' },
    { path: 'two.ts', status: 'pending' },
  ],
};

it('rolls back intent and shared effect claim together, and retains partial application across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ocean-apply-store-'));
  const path = join(root, 'store.sqlite');
  try {
    const store = openSqliteStore({ path });
    expect(() =>
      store.codingApplications.atomic((tx) => {
        expect(tx.claimApplication(intent)).toBe(true);
        throw Error('crash before commit');
      }),
    ).toThrow('crash before commit');
    expect(store.codingApplications.atomic((tx) => tx.application(intent.id))).toBeNull();
    store.codingApplications.atomic((tx) => expect(tx.claimApplication(intent)).toBe(true));
    const started: CodingApplyReceipt = {
      ...intent,
      files: [{ path: 'one.ts', status: 'started' }, intent.files[1]!],
    };
    store.codingApplications.atomic((tx) => tx.putApplication(started));
    const firstDone: CodingApplyReceipt = {
      ...started,
      files: [{ path: 'one.ts', status: 'completed' }, intent.files[1]!],
    };
    store.codingApplications.atomic((tx) => tx.putApplication(firstDone));
    const secondStarted: CodingApplyReceipt = {
      ...firstDone,
      files: [firstDone.files[0]!, { path: 'two.ts', status: 'started' }],
    };
    store.codingApplications.atomic((tx) => tx.putApplication(secondStarted));
    store.close();
    const reopened = openSqliteStore({ path });
    const db = new DatabaseSync(path);
    try {
      expect(reopened.codingApplications.atomic((tx) => tx.application(intent.id))).toEqual(
        secondStarted,
      );
      const journal = new SqliteToolJournal(db);
      expect((await journal.pending())[0]).toMatchObject({ id: intent.id, outcome: 'started' });
      expect(
        reopened.codingApplications.atomic((tx) => tx.claimApplication({ ...intent, id: 'other' })),
      ).toBe(false);
      const uncertain: CodingApplyReceipt = {
        ...secondStarted,
        status: 'uncertain',
        files: [firstDone.files[0]!, { path: 'two.ts', status: 'uncertain' }],
      };
      reopened.codingApplications.atomic((tx) => tx.putApplication(uncertain));
      expect((await journal.pending())[0]?.outcome).toBe('uncertain');
      expect(() =>
        reopened.codingApplications.atomic((tx) => tx.putApplication(secondStarted)),
      ).toThrow();
      expect(
        await journal.claim('new', 'write', { taskRunId: 'run', attemptId: 'attempt' }, 'new'),
      ).toBe(false);
    } finally {
      db.close();
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects skipped file states and settles completed receipt and claim in one transaction', () => {
  const store = openSqliteStore({ path: ':memory:' });
  try {
    store.codingApplications.atomic((tx) => expect(tx.claimApplication(intent)).toBe(true));
    expect(() =>
      store.codingApplications.atomic((tx) =>
        tx.putApplication({ ...intent, status: 'completed' }),
      ),
    ).toThrow();
    expect(() =>
      store.codingApplications.atomic((tx) =>
        tx.putApplication({
          ...intent,
          files: intent.files.map((f) => ({ ...f, status: 'completed' })),
        }),
      ),
    ).toThrow();
    let receipt = intent;
    for (const index of [0, 1])
      for (const status of ['started', 'completed'] as const) {
        receipt = {
          ...receipt,
          files: receipt.files.map((file, n) => (n === index ? { ...file, status } : file)),
        };
        store.codingApplications.atomic((tx) => tx.putApplication(receipt));
      }
    store.codingApplications.atomic((tx) => tx.putApplication({ ...receipt, status: 'completed' }));
    expect(
      store.codingApplications.atomic((tx) => tx.claimApplication({ ...intent, id: 'next' })),
    ).toBe(true);
  } finally {
    store.close();
  }
});

it('settles an observation refusal without effects and never reopens that receipt', () => {
  const store = openSqliteStore({ path: ':memory:' });
  try {
    store.codingApplications.atomic((tx) => expect(tx.claimApplication(intent)).toBe(true));
    const refused: CodingApplyReceipt = { ...intent, status: 'not_started' };
    store.codingApplications.atomic((tx) => tx.putApplication(refused));
    expect(store.codingApplications.atomic((tx) => tx.claimApplication(intent))).toBe(false);
    expect(() => store.codingApplications.atomic((tx) => tx.putApplication(intent))).toThrow();
    expect(
      store.codingApplications.atomic((tx) => tx.claimApplication({ ...intent, id: 'next' })),
    ).toBe(true);
    const started: CodingApplyReceipt = {
      ...intent,
      id: 'next',
      files: [{ path: 'one.ts', status: 'started' }, intent.files[1]!],
    };
    store.codingApplications.atomic((tx) => tx.putApplication(started));
    expect(() =>
      store.codingApplications.atomic((tx) =>
        tx.putApplication({ ...started, status: 'not_started' }),
      ),
    ).toThrow();
  } finally {
    store.close();
  }
});

it.each(['started', 'uncertain', 'completed'] as const)(
  'reconciles receipt and existing %s journal atomically without upgrading certainty',
  async (outcome) => {
    const { CodingApplyService } = await import('@runnets/application');
    const store = openSqliteStore({ path: ':memory:' });
    try {
      store.codingApplications.atomic((tx) => expect(tx.claimApplication(intent)).toBe(true));
      const context = { taskRunId: 'apply-' + intent.id, attemptId: 'apply' };
      if (outcome === 'uncertain') await store.tools.recover(intent.id, context);
      if (outcome === 'completed') await store.tools.settle(intent.id, 'completed', context);
      const service = new CodingApplyService(
        store.codingApplications,
        {
          inspect: () => Promise.reject(Error('must not inspect')),
          sourceTree: () => Promise.reject(Error('must not inspect')),
          applyFile: () => Promise.reject(Error('must not execute')),
        },
        () => false,
      );
      if (outcome === 'completed') {
        expect(() => service.recover()).toThrow();
        expect(store.codingApplications.atomic((tx) => tx.application(intent.id))?.status).toBe(
          'applying',
        );
      } else {
        const [recovered] = service.recover();
        expect(recovered?.status).toBe('uncertain');
        expect(recovered).not.toHaveProperty('recoveryProtocol');
        expect((await store.tools.pending())[0]?.outcome).toBe('uncertain');
        expect(service.recover()).toEqual([]);
        expect(
          await store.tools.claim(
            'other',
            'write',
            { taskRunId: 'other', attemptId: 'other' },
            'other',
          ),
        ).toBe(false);
      }
    } finally {
      store.close();
    }
  },
);

it('admits only an absent or numeric v2 protocol and freezes it in either direction', async () => {
  for (const marker of [undefined, 1, null, '2', [2], 2, 'absent']) {
    const store = openSqliteStore({ path: ':memory:' });
    const receipt = (
      marker === 'absent' ? intent : { ...intent, recoveryProtocol: marker }
    ) as CodingApplyReceipt;
    try {
      const admitted = marker === 2 || marker === 'absent';
      expect(store.codingApplications.atomic((tx) => tx.claimApplication(receipt))).toBe(admitted);
      if (admitted) {
        expect((await store.tools.pending())[0]).toMatchObject({
          fingerprint: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
        });

        const changed = marker === 2 ? intent : { ...intent, recoveryProtocol: 2 as const };
        expect(() => store.codingApplications.atomic((tx) => tx.putApplication(changed))).toThrow();
        expect(() =>
          store.codingApplications.atomic((tx) =>
            tx.putApplication({
              ...receipt,
              recoveryProtocol: undefined,
            } as unknown as CodingApplyReceipt),
          ),
        ).toThrow();
        expect(store.codingApplications.atomic((tx) => tx.application(intent.id))).toEqual(receipt);
      }
    } finally {
      store.close();
    }
  }
});
