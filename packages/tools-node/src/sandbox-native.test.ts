import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSandbox, sandboxLimits } from './sandbox-supervision.js';

describe.runIf(process.platform === 'linux' && process.env['OCEAN_SANDBOX_NATIVE'] === '1')(
  'native coding isolation',
  () => {
    it('hides host canaries, environment, user bus, network and Git administration', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-sandbox-'));
      const secret = join(tmpdir(), 'ocean-canary-' + crypto.randomUUID());
      await writeFile(secret, 'synthetic-canary');
      await writeFile(join(root, '.git'), 'gitdir: /host/never-visible');
      try {
        const code = `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
        assert.equal(process.env.DBUS_SESSION_BUS_ADDRESS, undefined);
        assert.equal(fs.existsSync(${JSON.stringify(secret)}), false);
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
        await rm(secret);
      }
    }, 20000);
    it('kills detached descendants and proves cgroup emptiness after leader exit', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ocean-sandbox-'));
      try {
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
