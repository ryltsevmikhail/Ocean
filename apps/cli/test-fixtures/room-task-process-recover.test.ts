// eslint-disable-next-line no-restricted-imports -- Built CLI host fixture in this package.
import type * as RuntimeHost from '../src/local-runtime/host.js';
import { serve } from './model-process-rpc.ts';
const { startLocalRuntime }: typeof RuntimeHost = await import(
  String('../dist/local-runtime/host.js')
);
let calls = 0;
const host = await startLocalRuntime({
  profile: process.argv[2]!,
  providerHttpClient: {
    send() {
      calls++;
      throw Error('successor inference tripwire');
    },
  },
});
process.send!({ ready: host.identity });
serve(async (method) => {
  if (method === 'requests') return calls;
  if (method === 'close') return host.stop();
  throw Error('unknown fixture method');
});
