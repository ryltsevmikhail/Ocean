import { expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connection } from '../test-fixtures/admission.js';
import { managedLifetimeFixture } from '../../store-sqlite/test-fixtures/managed-lifetime.js';
const state = vi.hoisted(() => ({
  program: '',
  cleanup: false,
  release: Promise.resolve(),
  finished: [] as boolean[],
}));
vi.mock('@runnets/tools-node', () => ({
  prepareManagedStdio: async () => ({
    parameters: { command: process.execPath, args: ['-e', state.program], env: {}, stderr: 'pipe' },
    footprint: {},
    nonce: 'nonce',
    unit: 'unit',
    cgroup: 'cgroup',
    inspect: () => true,
    start() {},
    observe: async () => {},
    running: async () => false,
    cleanup: async () => {
      state.cleanup = true;
      await state.release;
      return 'confirmed';
    },
  }),
}));
import { createMcpServiceTransport } from './index.js';
it.each([50, 800])(
  'bounds actual owned subprocess EOF with stdout lifetime %sms and joins held cleanup without replay',
  async (linger) => {
    const root = mkdtempSync(join(tmpdir(), 'managed-early-close-')),
      done = join(root, 'child-done');
    const response =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'early-close', version: '1' },
        },
      }) + '\n';
    const child = `setTimeout(()=>{process.stdout.write(${JSON.stringify(response)});require('node:fs').writeFileSync(${JSON.stringify(done)},'done')},50);setTimeout(()=>{},${linger})`;
    state.program = `process.stdin.once('data',()=>{require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore',process.stdout,'ignore']});process.exit(0)})`;
    let release!: () => void;
    state.release = new Promise<void>((r) => {
      release = r;
    });
    state.cleanup = false;
    state.finished = [];
    const t = createMcpServiceTransport({
      stdio: { profileRoot: root },
      prepareManagedLifetime: async () => ({
        record: managedLifetimeFixture().record,
        begin: () => true,
        finish: (_status, lost) => {
          state.finished.push(lost);
        },
      }),
    });
    const c = connection({
      kind: 'stdio',
      executable: '/owned/server.mjs',
      sha256: 'a'.repeat(64),
      args: [],
      workspaceRoot: '/owned/root',
    });
    let settled = false;
    const discovery = t
      .discover(c, {
        signal: new AbortController().signal,
        deadlineMs: 200,
        authorizeMetadata: () => true,
      })
      .then(
        () => 'unexpected',
        () => 'refused',
      )
      .then((r) => {
        settled = true;
        return r;
      });
    try {
      await vi.waitFor(() => expect(state.cleanup).toBe(true), { timeout: 1800 });
      expect(existsSync(done)).toBe(true);
      expect(settled).toBe(false);
      expect(state.finished).toEqual([]);
      release();
      expect(await Promise.race([discovery, delay(1000).then(() => 'timeout')])).toBe('refused');
      expect(await t.close()).toEqual({ status: 'confirmed' });
      expect(state.finished).toEqual([true]);
    } finally {
      release();
      if (settled) await t.close();
      else void t.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  },
);
