// Package resolution occurs only inside the separately verified, frozen fixture installation.
import { rolldown } from 'rolldown';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const dir = process.argv[2]!;
for (const [entry, name] of [
  [join(dir, 'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js'), 'filesystem'],
  [fileURLToPath(new URL('./native-fault.ts', import.meta.url)), 'fault'],
] as const) {
  const bundle = await rolldown({ input: entry, platform: 'node' });
  try {
    await bundle.write({ file: join(dir, name + '.mjs'), format: 'esm', codeSplitting: false });
  } finally {
    await bundle.close();
  }
}
