import type { Writable } from 'node:stream';
import { connectLocalRuntime } from '@runnets/tools-node';
import type { OceanArguments } from './arguments.js';
import { profileDirectory } from './profile.js';
import { startLocalRuntime } from '../local-runtime/host.js';
/** Explicit foreground lifecycle. Status/stop never construct a runtime or read provider keys. */
export async function runRuntimeCommand(args: OceanArguments, output: Writable): Promise<number> {
  const action = args.positional[0];
  if (
    args.positional.length !== 1 ||
    !['start', 'restore', 'status', 'stop'].includes(action ?? '') ||
    args.textOnly ||
    [...args.flags.keys()].some((flag) => flag !== 'profile')
  )
    throw Error('invalid_input');
  const profile = profileDirectory(args.flags.get('profile'));
  const write = (data: unknown) =>
    output.write(JSON.stringify({ version: 1, ok: true, data }) + '\n');
  if (action === 'start' || action === 'restore') {
    const host = await startLocalRuntime({
      profile,
      ...(action === 'restore' && { restore: true }),
    });
    const stop = () => {
      void host.stop().then((result) => {
        if (result.outcome === 'uncertain')
          output.write(
            JSON.stringify({ version: 1, ok: false, error: { code: 'stop_incomplete' } }) + '\n',
          );
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      write(host.status());
      await host.closed;
      return 0;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  const client = await connectLocalRuntime({ profile });
  try {
    if (action === 'status') {
      write(await client.status());
      return 0;
    }
    const result = await client.stop();
    write(result);
    return result.outcome === 'complete' ? 0 : 4;
  } finally {
    client.close();
  }
}
