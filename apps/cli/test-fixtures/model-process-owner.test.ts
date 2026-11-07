// eslint-disable-next-line no-restricted-imports -- Same-app source contract; child executes dist.
import type * as SourceModule1 from '../src/local-runtime/host.js';
import { ports } from './model-process-ports.ts';
import { dropper } from './model-process-drop.ts';
import { serve } from './model-process-rpc.ts';
const profile = process.argv[2]!;
const p = ports(profile, process.argv[3]!);
const drop = process.argv[4] === 'drop' ? dropper(profile, p.record) : null;
const { startLocalRuntime }: typeof SourceModule1 = await import(
  String('../dist/local-runtime/host.js')
);
const host = await startLocalRuntime({
  profile,
  providerSecretStore: p.secrets,
  providerHttpClient: p.http,
});
serve((method, input) => {
  if (method === 'snapshot') return p.snapshot();
  if (method === 'fault') return p.fault(input);
  if (method === 'drop') return drop!(input);
  if (method === 'hold') return p.hold();
  if (method === 'release') return p.release();
  throw Error('fixture_unknown_control');
});
process.send!({
  ready: {
    pid: process.pid,
    identity: host.identity,
    host: import.meta.resolve('../dist/local-runtime/host.js'),
    sdk: import.meta.resolve('@runnets/tools-node'),
    store: import.meta.resolve('@runnets/store-sqlite'),
  },
});
await host.closed;
