import { connectLocalRuntime } from '@runnets/tools-node';
import { serve } from './model-process-rpc.ts';
const client = await connectLocalRuntime({ profile: process.argv[2]! });
process.send!({ ready: client.identity });
serve(async (method, input) => {
  if (method === 'start') return client.roomTaskStart(input);
  if (method === 'get') return client.roomTaskGet(input);
  if (method === 'observe') return client.roomTaskObserve(input);
  if (method === 'cancel') return client.cancelRun(input);
  if (method === 'stop') return client.roomTaskStop(input);
  if (method === 'close') {
    client.close();
    return true;
  }
  throw Error('unknown fixture method');
});
