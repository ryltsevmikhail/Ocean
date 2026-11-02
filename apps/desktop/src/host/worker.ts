import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliArguments } from './arguments.js';

// This adapter runs inside a new private Node process for each operation. The fixed,
// bundled CLI entry owns profile validation, recovery, membership and every durable write.
async function main() {
  const profile = process.argv[2];
  const workspace = process.argv[3];
  if(!profile || !workspace) throw new Error();
  const chunks: Buffer[]=[];
  let bytes=0;
  for await (const chunk of process.stdin) {
    const buf=Buffer.from(chunk as Uint8Array);
    bytes+=buf.length;
    if(bytes>131072)throw new Error();
    chunks.push(buf);
  }
  const raw: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const args=cliArguments(raw,profile,workspace);
  const resources=fileURLToPath(new URL('.',import.meta.url));
  const entry=resolve(join(resources,'runtime/apps/cli/dist/main.js'));
  // Pass text in memory, never in the OS process argument list or shell.
  process.argv=[process.execPath,entry,...args];
  await import(pathToFileURL(entry).href);
}

try { await main(); }
catch(error){
  const code=error instanceof Error && error.message==='choose_recipient'?'choose_recipient':'invalid_request';
  process.stdout.write(JSON.stringify({version:1,ok:false,error:{code}})+'\n');
  process.exitCode=2;
}
