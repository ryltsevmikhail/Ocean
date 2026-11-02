import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSandbox, sandboxLimits } from './sandbox-supervision.js';

describe.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'native coding isolation',
  () => {
    it('hides host canaries, environment, user bus, network and Git administration', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-sandbox-'));
      const hostHome = await mkdtemp(join(tmpdir(), 'ocean-host-home-'));
      const canaries = [
        '.config/ocean/deepseek.key',
        '.local/share/ocean/profile.sqlite',
        '.local/share/ocean/backups/fixture',
        '.ssh/id_ed25519',
      ].map((path) => join(hostHome, path));

      await writeFile(join(root, '.git'), 'gitdir: /host/never-visible');
      try {
        for (const path of canaries) {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, 'synthetic-canary');
          expect(await readFile(path, 'utf8')).toBe('synthetic-canary');
        }
        const code = `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
        assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, undefined);
        for (const path of ${JSON.stringify(canaries)})
          assert.throws(() => fs.readFileSync(path), {code:'ENOENT'});
        assert.equal(fs.existsSync('/home/ryltsevmg/.config/ocean'), false);
        assert.equal(fs.existsSync('/run/user/1000/bus'), false);
        assert.equal(fs.existsSync('/sys/fs/cgroup'), false);
        assert.throws(() => fs.readFileSync('/workspace/.git', 'utf8'));
        assert.throws(() => fs.writeFileSync('/usr/ocean-canary', 'x'));
        assert.equal(fs.readdirSync('/proc').filter(x => /^[0-9]+$/.test(x)).length < 10, true);
        const net = require('node:net');
        const s = net.connect({host:'1.1.1.1',port:443});
        s.on('connect', () => process.exit(9));
        s.on('error', () => { console.log('isolated'); });
        setTimeout(() => { s.destroy(); console.log('no-network'); }, 100);
      `;
        const result = await runSandbox({ root, program: '/toolchain/node', args: ['-e', code] });
        expect(result.cleanupConfirmed).toBe(true);
        expect(result.exitCode, result.output).toBe(0);
        expect(result.output).toContain('isolated');
        expect(result.cgroup).toContain('ocean-worker-');
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(hostHome, { recursive: true, force: true });
      }
    }, 20000);
    it('isolates writable scratch from read-only dependencies and toolchain', async () => {
      const fixture = await mkdtemp(join(tmpdir(), 'ocean-mount-native-'));
      const root = join(fixture, 'task');
      const source = join(fixture, 'node_modules');
      try {
        await mkdir(join(root, 'node_modules'), { recursive: true });
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        await mkdir(source);
        await writeFile(join(source, 'fixture'), 'dependency');
        const result = await runSandbox({
          root,
          dependencyProjectRoot: fixture,
          mounts: [{ source, target: '/workspace/node_modules' }],
          program: '/toolchain/node',
          args: [
            '-e',
            `
            const fs=require('node:fs'), assert=require('node:assert/strict');
            assert.equal(fs.readFileSync('node_modules/fixture','utf8'),'dependency');
            assert.throws(()=>fs.writeFileSync('node_modules/fixture','overwrite'));
            assert.throws(()=>fs.openSync('/toolchain/node','r+'));
            for(const dir of [process.env.HOME,'/tmp','/workspace'])
              fs.writeFileSync(dir+'/scratch','private');
          `,
          ],
        });
        expect(result.exitCode, result.output).toBe(0);
        expect(result.cleanupConfirmed).toBe(true);
        expect(await readFile(join(root, 'scratch'), 'utf8')).toBe('private');
        expect(await readFile(join(source, 'fixture'), 'utf8')).toBe('dependency');
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
    it('contains descendants when project code kills the worker', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-interrupt-'));
      try {
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        const result = await runSandbox({
          root,
          program: '/toolchain/node',
          args: [
            '-e',
            `
            const child=require('node:child_process').spawn('/toolchain/node',
              ['-e',"setInterval(()=>require('node:fs').appendFileSync('/workspace/ticks','x'),10)"],
              {detached:true,stdio:'ignore'});
            child.unref();
            const timer=setInterval(()=>{
              if(require('node:fs').existsSync('/workspace/ticks')){
                clearInterval(timer);process.kill(process.ppid,'SIGKILL');
              }
            },5);
          `,
          ],
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.cleanupConfirmed).toBe(true);
        const ticks = await readFile(join(root, 'ticks'), 'utf8');
        await new Promise((r) => setTimeout(r, 80));
        expect(await readFile(join(root, 'ticks'), 'utf8')).toBe(ticks);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('refuses dispatch when cancelled during filesystem inventory', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-sandbox-'));
      try {
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        const controller = new AbortController();
        const pending = runSandbox({
          root,
          signal: controller.signal,
          program: '/toolchain/node',
          args: ['-e', "require('node:fs').writeFileSync('/workspace/dispatched','x')"],
        });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await expect(readFile(join(root, 'dispatched'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    it('kills detached descendants and proves cgroup emptiness after leader exit', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-sandbox-'));
      try {
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        const result = await runSandbox({
          root,
          program: '/toolchain/node',
          args: [
            '-e',
            `
        require('node:child_process').spawn('/toolchain/node', ['-e',
          "setInterval(()=>require('node:fs').appendFileSync('/workspace/ticks','x'),20)"],
          {detached:true,stdio:'ignore'}).unref();
        setTimeout(()=>process.exit(0),100);
      `,
          ],
        });
        expect(result.cleanupConfirmed).toBe(true);
        const before = await readFile(join(root, 'ticks'), 'utf8');
        await new Promise((r) => setTimeout(r, 100));
        expect(await readFile(join(root, 'ticks'), 'utf8')).toBe(before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 20000);
    it('bounds output, timeout and cancellation and confirms cleanup', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-sandbox-'));
      try {
        await writeFile(join(root, '.git'), 'synthetic-git-pointer');
        const loud = await runSandbox({
          root,
          program: '/toolchain/node',
          args: ['-e', "process.stdout.write('x'.repeat(100000))"],
        });
        expect(loud.output.length).toBeLessThanOrEqual(sandboxLimits.outputBytes);
        expect(loud.truncated).toBe(true);
        expect(loud.cleanupConfirmed).toBe(true);
        const timed = await runSandbox({
          root,
          program: '/toolchain/node',
          args: ['-e', 'setInterval(()=>{},100)'],
          timeoutMs: 200,
        });
        expect(timed.reason).toBe('timeout');
        expect(timed.cleanupConfirmed).toBe(true);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const cancelled = await runSandbox({
          root,
          program: '/toolchain/node',
          args: ['-e', 'setInterval(()=>{},100)'],
          signal: controller.signal,
        });
        expect(cancelled.reason).toBe('cancelled');
        expect(cancelled.cleanupConfirmed).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 30000);
  },
);
