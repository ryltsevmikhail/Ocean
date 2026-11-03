import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  connectLocalRuntime,
  DesktopAttachmentClient,
  captureDesktopAssets,
  archiveDesktopAssets,
  restoreDesktopAssets,
  verifyProfileBackupEnvelope,
} from '@runnets/tools-node';
import {
  snapshotCodingDatabase,
  snapshotDatabase,
  readDesktopBackupInventory,
} from '@runnets/store-sqlite';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';
import { openOceanProfile } from '../ocean/profile.js';
import { startLocalRuntime } from './host.js';
import { rooms } from '../../test-fixtures/local-runtime-admission.test.js';
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ocean-desktop-process-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile'),
    userData = join(root, 'userData'),
    home = join(root, 'home'),
    run = join(root, 'run');
  for (const dir of [userData, home, run]) fs.mkdirSync(dir, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const room = rooms(runtime.conversations).groupId;
  runtime.close();
  const launch = (script: string) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, profile, userData, room],
      {
        cwd: resolve('.'),
        env: {
          ...Object.fromEntries(
            [
              'HOME',
              'XDG_RUNTIME_DIR',
              'XDG_CONFIG_HOME',
              'XDG_DATA_HOME',
              'XDG_STATE_HOME',
              'XDG_CACHE_HOME',
              'TMPDIR',
            ].map((key) => [key, process.env[key]]),
          ),
          PATH: process.env['PATH'],
          HOME: home,
          XDG_RUNTIME_DIR: run,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    const exit = new Promise<number | null>((ok, no) => {
      child.once('close', ok);
      child.once('error', no);
    });
    cleanup.push(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
    });
    const line = async (index: number) => {
      await vi.waitFor(
        () => {
          expect(stdout.split('\n').length, stderr).toBeGreaterThan(index + 1);
        },
        { timeout: 10000 },
      );
      return JSON.parse(stdout.split('\n')[index]!) as Record<string, unknown>;
    };
    return { child, exit, line, output: () => stdout, error: () => stderr };
  };
  return { root, profile, userData, room, launch };
}
const sdk = `import { connectLocalRuntime, DesktopAttachmentClient } from '@runnets/tools-node';
const [profile,userData,room]=process.argv.slice(1);`;
it.runIf(process.platform === 'linux')(
  'excludes an independent actual host adapter upload and captures after reconnect with zero coding tasks',
  async () => {
    const f = await fixture();
    const owner = await startLocalRuntime({ profile: f.profile, provider: null });
    cleanup.push(() => owner.stop());
    const writer = f.launch(
      sdk +
        `
const client=await connectLocalRuntime({profile});
let pause=true;
const host=new DesktopAttachmentClient({desktopAssets:async(c)=>{const r=await client.desktopAssets(c);if(c.op==='chunk'&&pause){pause=false;console.log(JSON.stringify({paused:true}));await new Promise(ok=>process.stdin.once('data',ok));}return r;}});
await host.enroll(userData);
const id=crypto.randomUUID(), upload=crypto.randomUUID();
const info=await host.import(room,'process.txt',Buffer.alloc(700000,97).toString('base64'),upload);
const receipt=await host.prepare(room,id,'process caption',null,[info.id]);
await client.submit({workspaceId:'ws_ocean',roomId:room,requestId:id,text:receipt.prepared});
client.close();const next=await connectLocalRuntime({profile});
const retry=await new DesktopAttachmentClient(next).prepare(room,id,'process caption',null,[info.id]);
console.log(JSON.stringify({info,requestId:id,receipt,retry}));next.close();process.stdin.destroy();`,
    );
    expect(await writer.line(0)).toEqual({ paused: true });
    await expect(
      snapshotDatabase(join(f.profile, 'runtime.sqlite'), join(f.root, 'blocked.sqlite')),
    ).rejects.toThrow('owner_busy');
    writer.child.stdin.write('continue\n');
    const result = await writer.line(1);
    expect(await writer.exit, writer.error()).toBe(0);
    expect(result['retry']).toEqual(result['receipt']);
    await owner.stop();
    const archive = join(f.root, 'archive');
    await snapshotCodingDatabase(
      join(f.profile, 'runtime.sqlite'),
      join(f.root, 'snapshot.sqlite'),
      async (coding, desktop) => {
        expect(coding.tasks).toHaveLength(0);
        expect(desktop.messages).toHaveLength(1);
        const contender = f.launch(
          `import { startLocalRuntime } from './apps/cli/dist/local-runtime/host.js';try {await startLocalRuntime({profile:process.argv[1],provider:null});process.exit(2);}catch(e){console.log(JSON.stringify({error:e.code??e.message}));}`,
        );
        expect(await contender.exit).toBe(0);
        expect((await contender.line(0))['error']).toBe('owner_busy');
        return archiveDesktopAssets(captureDesktopAssets(desktop), archive);
      },
    );
    const fullArchive = join(f.root, 'full-archive');
    expect((await backupProfile(f.profile, fullArchive)).format).toBe(2);
    fs.rmSync(f.profile, { recursive: true });
    fs.rmSync(f.userData, { recursive: true });
    restoreProfile(fullArchive, join(f.root, 'full-quarantine'));
    restoreDesktopAssets(archive, join(f.root, 'quarantine'));
    const info = result['info'] as { id: string };
    expect(
      fs
        .readFileSync(join(f.root, 'quarantine', 'tree', f.room, info.id, 'blob'))
        .equals(Buffer.alloc(700000, 97)),
    ).toBe(true);
  },
);
it.runIf(process.platform === 'linux')(
  'SIGKILL preparation aliases and interrupted public publication retain evidence through source-deleted quarantine without replay',
  async () => {
    const f = await fixture();
    const owner =
      f.launch(String.raw`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {startLocalRuntime} from './apps/cli/dist/local-runtime/host.js';
const unlink=fs.unlinkSync;fs.unlinkSync=(p)=>{if(/\.json\.[a-f0-9-]+\.tmp$/.test(String(p)))process.kill(process.pid,'SIGKILL');return unlink(p);};syncBuiltinESMExports();
const host=await startLocalRuntime({profile:process.argv[1],provider:null});console.log(JSON.stringify({ready:true}));await host.closed;`);
    expect(await owner.line(0)).toEqual({ ready: true });
    const client = await connectLocalRuntime({ profile: f.profile });
    cleanup.push(() => client.close());
    const host = new DesktopAttachmentClient(client);
    await host.enroll(f.userData);
    const info = await host.import(f.room, 'notes.md', Buffer.from('test').toString('base64')),
      requestId = randomUUID();
    await expect(host.prepare(f.room, requestId, 'caption', null, [info.id])).rejects.toThrow();
    expect(await owner.exit).toBeNull();
    expect(owner.child.signalCode).toBe('SIGKILL');
    const next = await startLocalRuntime({ profile: f.profile, provider: null });
    cleanup.push(() => next.stop());
    const c = await connectLocalRuntime({ profile: f.profile });
    cleanup.push(() => c.close());
    await expect(
      new DesktopAttachmentClient(c).prepare(f.room, requestId, 'caption', null, [info.id]),
    ).rejects.toThrow('desktop_outcome_unknown');
    await next.stop();
    const inventory = readDesktopBackupInventory(join(f.profile, 'runtime.sqlite'));
    expect(
      inventory.operations.some(
        (o) => o.id === 'prepare:' + f.room + ':' + requestId && o.state === 'started',
      ),
    ).toBe(true);
    const names = fs.readdirSync(join(inventory.binding!.root, f.room));
    expect(names.filter((n) => n.startsWith(requestId))).toHaveLength(2);
    const again = await startLocalRuntime({ profile: f.profile, provider: null });
    const againClient = await connectLocalRuntime({ profile: f.profile });
    try {
      await expect(
        new DesktopAttachmentClient(againClient).prepare(f.room, requestId, 'caption', null, [
          info.id,
        ]),
      ).rejects.toThrow('desktop_outcome_unknown');
    } finally {
      againClient.close();
      await again.stop();
    }
    const killed =
      f.launch(String.raw`import fs from 'node:fs';import {dirname,join} from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const destination=join(dirname(process.argv[1]),'killed-backup'),unlink=fs.unlinkSync;
fs.unlinkSync=(path)=>{if(String(path).endsWith('/.incomplete')&&fs.realpathSync(dirname(String(path)))===destination){fs.writeSync(1,JSON.stringify({publication:'before-root-marker'})+'\n');process.kill(process.pid,'SIGKILL');}return unlink(path);};syncBuiltinESMExports();
const {backupProfile}=await import('./apps/cli/dist/ocean/snapshots.js');await backupProfile(process.argv[1],destination);process.exit(2);`);
    expect(await killed.exit, killed.error()).toBeNull();
    expect(killed.child.signalCode).toBe('SIGKILL');
    expect(await killed.line(0)).toEqual({ publication: 'before-root-marker' });
    expect(fs.existsSync(join(f.root, 'killed-backup', '.incomplete'))).toBe(true);
    expect(() => verifyProfileBackupEnvelope(join(f.root, 'killed-backup'))).toThrow();
    expect(fs.readdirSync(join(inventory.binding!.root, f.room))).toEqual(names);
    const archive = join(f.root, 'complete-backup');
    const manifest = await backupProfile(f.profile, archive);
    expect(manifest.format).toBe(2);
    fs.rmSync(f.profile, { recursive: true });
    fs.rmSync(f.userData, { recursive: true });
    expect(verifyProfileBackupEnvelope(archive)).toEqual(manifest);
    const quarantine = join(f.root, 'quarantine');
    restoreProfile(archive, quarantine);
    const saved = readDesktopBackupInventory(join(quarantine, 'runtime.sqlite'));
    expect(
      saved.operations.find((o) => o.id === 'prepare:' + f.room + ':' + requestId)?.state,
    ).toBe('started');
    const restoredRoom = join(quarantine, 'assets', 'desktop', 'tree', f.room),
      pair = names.filter((n) => n.startsWith(requestId));
    expect(fs.statSync(join(restoredRoom, pair[0]!)).ino).toBe(
      fs.statSync(join(restoredRoom, pair[1]!)).ino,
    );
    for (let reopening = 0; reopening < 2; reopening++)
      await expect(startLocalRuntime({ profile: quarantine, provider: null })).rejects.toThrow(
        'restore_restricted',
      );
    expect(readDesktopBackupInventory(join(quarantine, 'runtime.sqlite')).operations).toEqual(
      saved.operations,
    );
    expect(fs.existsSync(f.profile)).toBe(false);
    expect(fs.existsSync(f.userData)).toBe(false);
  },
);
