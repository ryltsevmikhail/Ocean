// eslint-disable-next-line no-restricted-imports -- Same-app source types; runtime executes dist.
import type * as Host from '../src/local-runtime/host.js';
import { TaskRunService } from '@runnets/application';
import { dropTurn } from './model-mixed-drop.ts';
import { mixedPorts } from './model-mixed-ports.ts';
import { ports } from './model-process-ports.ts';
import { serve } from './model-process-rpc.ts';
const profile = process.argv[2]!;
const p = ports(profile, process.argv[3]!);
const mixed = mixedPorts(profile);
const drop = dropTurn(profile);
let crashGap = false,
  beforeFail = false;
const execute = TaskRunService.prototype.execute;
TaskRunService.prototype.execute = async function (command) {
  if (beforeFail && command.type === 'Fail') await new Promise<void>(() => {});
  const result = await execute.call(this, command);
  if (crashGap && command.type === 'Fail' && result.ok) await new Promise<void>(() => {});
  return result;
};
const { startLocalRuntime }: typeof Host = await import(String('../dist/local-runtime/host.js'));
const host = await startLocalRuntime({
  profile,
  restore: process.argv[4] === 'restore',
  providerSecretStore: p.secrets,
  providerHttpClient: mixed.http,
});
serve((method, input) => {
  if (method === 'dropTurn') return drop(input);
  if (method === 'snapshot') return p.snapshot();
  if (method === 'mixedSnapshot') return mixed.snapshot();
  if (method === 'mode') return mixed.mode(input);
  if (method === 'hold') return mixed.hold();
  if (method === 'release') return mixed.release();
  if (method === 'beforeFail') {
    beforeFail = true;
    return;
  }
  if (method === 'crashGap') {
    crashGap = true;
    return;
  }
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
