import { expect, it } from 'vitest';
import { maintenanceRead } from './restoration-check.js';

/**
 * The restore-mode maintenance host serves reads plus the explicit rebind owner
 * decision. Removing `decisions.resolve` breaks restore/rebind confirmation
 * (RC2 final review M1), so the entry is load-bearing; every model turn, tool,
 * provider/plugin/broadcast mutation and review continuation stays refused.
 */
it('admits exactly the restore-mode reads and no decision or review mutation', () => {
  const reads = [
    'rooms.list',
    'rooms.members',
    'history.list',
    'runs.list',
    'runs.events',
    'runs.result',
    'runs.get',
    'receipts.get',
    'observe',
    'bots.list',
    'coding.show',
    'coding.diff',
    'coding.pending',
    'coding.panel',
    'decisions.list',
    'decisions.get',
    'decisions.preview',
    // The one admitted mutation: the rebind confirmation card is opened by
    // restore.preview inside this host and answered through decisions.resolve.
    'decisions.resolve',
    'provider.status',
    'plugin.catalog',
    'plugin.inspect',
    'plugin.connections',
    'plugin.access-list',
    'broadcasts.get',
    'broadcasts.list',
  ];
  for (const read of reads) expect(maintenanceRead(read), read).toBe(true);
  const mutations = [
    'reviews.get',
    'reviews.continue',
    'reviews.result',
    'turns.submit',
    'broadcasts.submit',
    'broadcasts.continue',
    'broadcasts.abandon',
    'desktop.assets',
    'provider.set',
    'provider.check',
    'provider.disconnect',
    'provider.removeSavedKey',
    'plugin.install',
    'plugin.repair',
    'plugin.enable',
    'plugin.disable',
    'plugin.connection-add',
    'plugin.connection-discover',
    'plugin.connection-consent',
    'plugin.connection-disconnect',
    'plugin.access-grant',
    'plugin.access-revoke',
  ];
  for (const mutation of mutations) expect(maintenanceRead(mutation), mutation).toBe(false);
  // No non-decision mutation may ever be admitted by this allowlist.
  expect(mutations).not.toContain('decisions.resolve');
});
