import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openSqliteStore } from '@runnets/store-sqlite';
import { createRuntime } from '../runtime.js';
import { codingApplyRecoverySlot, captureScopedCodingApplyRecovery } from '@runnets/tools-node';
const repository =
  process.env['OCEAN_RC_INSTALL'] ??
  resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const worker = String.raw`
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const [root,path,project,phase]=process.argv.slice(1);
const halt=()=>{fs.writeSync(1,phase+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const rename=fs.renameSync;
fs.renameSync=(from,to)=>{rename(from,to);if(phase==='rename'&&String(to).endsWith('.before'))halt();};
const fsync=fs.fsyncSync;
fs.fsyncSync=fd=>{fsync(fd);if(phase==='scope_header'&&fs.readlinkSync('/proc/self/fd/'+fd).endsWith('/scope.json'))halt();};
syncBuiltinESMExports();
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('@runnets/')) {
  const name=specifier.slice(9);
  const built=join(root,'node_modules/@runnets',name,'dist/index.js');
  const source=join(root,'packages',name,'src/index.ts');
  if(fs.existsSync(built)||fs.existsSync(source))return next(pathToFileURL(fs.existsSync(built)?built:source).href,context);
 }
 if(specifier.endsWith('.js')&&context.parentURL?.startsWith(pathToFileURL(root).href)) {
  const url=new URL(specifier,context.parentURL);url.pathname=url.pathname.slice(0,-3)+'.ts';
  if(fs.existsSync(fileURLToPath(url)))return next(url.href,context);
 }
 return next(specifier,context);
}});
const {openSqliteStore,ownSqliteRuntime}=await import('@runnets/store-sqlite');
const {GitCodingApplyProject}=await import('@runnets/tools-node');
const release=ownSqliteRuntime(path), store=openSqliteStore({path});
const content=text=>({text,mode:'100644',sha256:createHash('sha256').update(text).digest('hex')});
let receipt={recoveryProtocol:2,id:'apply',taskId:'task',changesetHash:'a'.repeat(64),reviewRequestId:'review',expectedBase:'base',status:'applying',files:['a','b','c'].map(path=>({path,status:'pending'}))};
store.codingApplications.atomic(tx=>{if(!tx.claimApplication(receipt))throw Error('fixture claim refused');});
if(phase==='intent')halt();
const adapter=new GitCodingApplyProject();
for(const [index,name] of ['a','b','c'].entries()) {
 receipt={...receipt,files:receipt.files.map((f,n)=>n===index?{...f,status:'started'}:f)};
 store.codingApplications.atomic(tx=>tx.putApplication(receipt));
 if(phase==='started'&&index===0)halt();
 fs.appendFileSync(path+'.effects',name+'\n');
 await adapter.applyFile(project,{path:name,before:content('old-'+name),after:content('new-'+name)},{ownerId:'fixture',taskId:'task',applicationId:receipt.id,changesetHash:receipt.changesetHash});
 if((phase==='file'&&index===0)||(phase==='partial'&&index===1))halt();
 receipt={...receipt,files:receipt.files.map((f,n)=>n===index?{...f,status:'completed'}:f)};
 store.codingApplications.atomic(tx=>tx.putApplication(receipt));
}
if(phase==='all_files')halt();
store.close();release();
`;
async function killAt(path: string, project: string, phase: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', worker, repository, path, project, phase],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let errors = '';
  child.stderr.on('data', (buffer: Buffer) => {
    errors += buffer.toString();
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve());
    child.once('error', reject);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('fault boundary timeout: ' + errors)), 10000);
      child.stdout.once('data', (buffer: Buffer) => {
        clearTimeout(timeout);
        if (buffer.toString().trim() === phase) resolve();
        else reject(Error('unexpected boundary'));
      });
      child.once('close', () => {
        clearTimeout(timeout);
        reject(Error('worker exited: ' + errors));
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
}
it
  .runIf(process.platform === 'linux')
  .each(['intent', 'started', 'scope_header', 'rename', 'file', 'partial', 'all_files'])(
  'holds a real apply process killed at %s without replay or inferred completion',
  async (phase) => {
    const directory = mkdtempSync(join(tmpdir(), 'ocean-coding-crash-'));
    const project = join(directory, 'project'),
      path = join(directory, 'runtime.sqlite');
    mkdirSync(project);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      for (const name of ['a', 'b', 'c']) writeFileSync(join(project, name), 'old-' + name);
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'base',
      );
      const base = git('rev-parse', 'HEAD');
      await killAt(path, project, phase);
      const before = ['a', 'b', 'c'].map((name) =>
        existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : null,
      );
      const effects = existsSync(path + '.effects') ? readFileSync(path + '.effects', 'utf8') : '';
      const context = {
        ownerId: 'fixture',
        taskId: 'task',
        applicationId: 'apply',
        changesetHash: 'a'.repeat(64),
      };
      const common = join(project, '.git');
      const scope = join(
        common,
        'ocean-apply-recovery-v2',
        codingApplyRecoverySlot(project, context),
      );
      const header = phase === 'scope_header' ? readFileSync(join(scope, 'scope.json')) : null;
      if (header) {
        expect(header.toString()).toBe(
          JSON.stringify({
            version: 2,
            root: project,
            ownerId: 'fixture',
            taskId: 'task',
            applicationId: 'apply',
            changesetHash: 'a'.repeat(64),
          }) + '\n',
        );
        expect(before).toEqual(['old-a', 'old-b', 'old-c']);
        expect(existsSync(join(scope, 'files'))).toBe(false);
      }
      for (let reopen = 0; reopen < 2; reopen++) {
        const runtime = createRuntime({ dbPath: path });
        try {
          const recovery = await runtime.ready;
          expect(recovery.effects).toMatchObject([
            { id: 'apply', tool: 'coding_apply', outcome: 'uncertain' },
          ]);
          const store = openSqliteStore({ path });
          try {
            const receipt = store.codingApplications.atomic((tx) => tx.application('apply'))!;
            expect(receipt.recoveryProtocol).toBe(2);
            const observed = captureScopedCodingApplyRecovery(common, project, context, {
              ...receipt,
              recoveryProtocol: receipt.recoveryProtocol ?? null,
            });
            expect(observed.presence).toBe(
              phase === 'intent' || phase === 'started'
                ? 'absent'
                : phase === 'scope_header'
                  ? 'header-only'
                  : phase === 'rename'
                    ? 'incomplete'
                    : 'scoped',
            );
            expect(observed.status).toBe('uncertain');
            if (header)
              expect(observed.capture?.manifest.entries).toMatchObject([
                { path: '', kind: 'directory' },
                { path: 'scope.json', kind: 'file', bytes: header.byteLength },
              ]);
            expect(receipt.status).toBe('uncertain');
            expect(receipt.files.map((file) => file.status)).toEqual(
              phase === 'intent'
                ? ['pending', 'pending', 'pending']
                : phase === 'partial'
                  ? ['completed', 'uncertain', 'pending']
                  : phase === 'all_files'
                    ? ['completed', 'completed', 'completed']
                    : ['uncertain', 'pending', 'pending'],
            );
            expect(
              store.codingApplications.atomic((tx) =>
                tx.claimApplication({ ...receipt, status: 'applying' }),
              ),
            ).toBe(false);
          } finally {
            store.close();
          }
        } finally {
          runtime.close();
        }
        if (header) {
          expect(readFileSync(join(scope, 'scope.json'))).toEqual(header);
          expect(existsSync(join(scope, 'files'))).toBe(false);
          expect(readdirSync(scope)).toEqual(['scope.json']);
        }
      }
      expect(
        ['a', 'b', 'c'].map((name) =>
          existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : null,
        ),
      ).toEqual(before);
      expect(existsSync(path + '.effects') ? readFileSync(path + '.effects', 'utf8') : '').toBe(
        effects,
      );
      expect(git('rev-parse', 'HEAD')).toBe(base);
      expect(git('diff', '--cached')).toBe('');
      if (phase === 'rename') {
        expect(before[0]).toBeNull();
        const recovery = join(scope, 'files');
        expect(
          readFileSync(
            join(
              recovery,
              readdirSync(recovery).find((name) => name.endsWith('.before'))!,
            ),
            'utf8',
          ),
        ).toBe('old-a');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20000,
);
