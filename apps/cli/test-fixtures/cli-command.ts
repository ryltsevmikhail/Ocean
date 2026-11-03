// Run the built public CLI against a published or offline profile and decode its JSON envelope.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
export const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
export async function runCli(
  args: string[],
  repository = repositoryRoot,
): Promise<{ code: number; output: unknown }> {
  const child = spawn(process.execPath, ['apps/cli/dist/main.js', ...args, '--json'], {
    cwd: repository,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    errors += data.toString();
  });
  const [code] = (await once(child, 'close')) as [number];
  try {
    return { code, output: JSON.parse(output) as unknown };
  } catch {
    throw Error('cli output is not JSON: ' + output + errors);
  }
}
