import { startLocalRuntime } from '../dist/local-runtime/host.js';
import { serve } from './model-process-rpc.ts';

const [, , profile, mode] = process.argv;
let finishDrain!: (result: 'uncertain') => void;
const gate = new Promise<'uncertain'>((resolve) => {
  finishDrain = resolve;
});
const host = await startLocalRuntime({
  profile: profile!,
  provider: null,
  ...(mode === 'restore' ? { restore: true } : {}),
  ...(mode === 'drain' ? { drain: () => gate } : {}),
});
serve((method) => {
  if (method === 'start-drain') {
    void host.stop();
    return host.status();
  }
  if (method === 'finish-drain') {
    finishDrain('uncertain');
    return host.stop();
  }
  throw Error('unknown fixture method');
});
process.send!({ ready: host.identity });
