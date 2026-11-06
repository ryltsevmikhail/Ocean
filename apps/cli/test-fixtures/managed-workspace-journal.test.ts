import { openSqliteStore } from '@runnets/store-sqlite';
import { serve } from './model-process-rpc.ts';
import type { ServiceResourceFacts, ToolEffectRecord } from '@runnets/application';
const store = openSqliteStore({ path: process.argv[2]! });
process.send!({ ready: true });
serve(
  async (
    method,
    input: {
      claim: Omit<ToolEffectRecord, 'outcome' | 'fingerprint'>;
      facts: ServiceResourceFacts;
    },
  ) => {
    if (method === 'claim')
      return store.serviceAuthority.atomic((tx) => tx.claimLifetime(input.claim, input.facts));
    if (method === 'pending') return store.tools.pending();
    if (method === 'recover') {
      for (const row of await store.tools.pending())
        if (row.outcome === 'started') await store.tools.recover(row.id, row);
      return true;
    }
    if (method === 'close') {
      store.close();
      return true;
    }
    throw Error('unknown method');
  },
);
