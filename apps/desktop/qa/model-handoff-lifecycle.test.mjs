import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { wait } from './current-window.mjs';
import { processIdentity } from './desktop-launcher.mjs';
import { retireHandoff, writeHandoffMarker } from './model-handoff-lifecycle.mjs';
import { createNativeCase } from './model-native-case.mjs';

test('rejecting reopened GUI disposal still retires runtime and preserves primary plus secondary errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oa-retire-'));
  const primary = Error('original case failure'),
    guiError = Error('GUI retirement failed'),
    runtimeError = Error('runtime retirement failed'),
    calls = [];
  const session = {
    desktop: {},
    async dispose(error) {
      assert.equal(error, primary);
      calls.push('runtime');
      throw runtimeError;
    },
  };
  const gui = {
    async dispose() {
      calls.push('GUI');
      throw guiError;
    },
  };
  try {
    await assert.rejects(
      async () => {
        try {
          throw primary;
        } finally {
          await retireHandoff({ root, original: primary, gui, session });
        }
      },
      (error) => error === primary,
    );
    assert.deepEqual(calls, ['GUI', 'runtime']);
    assert.deepEqual(primary.handoffCleanupError.errors, [guiError, runtimeError]);
    const proof = JSON.parse(readFileSync(join(root, 'handoff-retirement.json'), 'utf8'));
    assert.equal(proof.primary, String(primary));
    assert.deepEqual(proof.failures, [String(guiError), String(runtimeError)]);
  } finally {
    rmSync(root, { recursive: true });
  }
});

for (const name of ['release-held-gui', 'drop-chat', 'tui-detach', 'release-held-tui']) {
  test('expired delayed observation cannot issue ' + name, async () => {
    const root = mkdtempSync(join(tmpdir(), 'oa-marker-'));
    const control = createNativeCase(),
      pending = Promise.withResolvers();
    try {
      await assert.rejects(
        control.run(
          async (step) => {
            await step(() => pending.promise);
            assert.equal(control.signal.aborted, true);
            writeHandoffMarker(root, name, step);
          },
          20,
          async () => pending.resolve(),
        ),
        /timed out/,
      );
      assert.equal(existsSync(join(root, name)), false);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
}

test('active handoff marker uses the owning step gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oa-marker-'));
  const control = createNativeCase();
  try {
    await control.run(
      (step) => writeHandoffMarker(root, 'release-held-gui', step),
      500,
      async () => {},
    );
    assert.equal(readFileSync(join(root, 'release-held-gui'), 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true });
  }
});

test(
  'SIGTERM wrapper runs finally, joins its owned PTY child and driver witnesses cleanup',
  { timeout: 18000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'oa-pty-retire-'));
    const env = {
      PATH: dirname(process.execPath) + ':/usr/bin',
      LANG: 'C.UTF-8',
      DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    };
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
      'TMPDIR',
    ]) {
      env[key] = join(root, key);
      mkdirSync(env[key], { mode: 0o700 });
    }
    const cli = join(root, 'fixture.mjs');
    // Prompt/hold fixture only: no Ocean runtime, provider or authority state.
    writeFileSync(
      cli,
      `import fs from 'node:fs';
    const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8');
    fs.writeFileSync(${JSON.stringify(join(root, 'child.json'))},JSON.stringify({pid:process.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]}));
    process.stdout.write('@bot001 / ');
    process.stdin.on('data',b=>{if(b.toString().includes('held-tui')) process.stdout.write('held-tui tr_owned \\n');});
    setInterval(()=>{},1000);`,
    );
    const terminal = spawn(
      'python3',
      [
        join(import.meta.dirname, 'model-handoff-tui.py'),
        process.execPath,
        cli,
        join(root, 'profile'),
        'room',
        root,
      ],
      { env },
    );
    let stderr = '',
      retired = false;
    terminal.stderr.on('data', (b) => {
      stderr += b;
    });
    const terminalClosed = new Promise((resolve, reject) => {
      terminal.once('close', (code, signal) => resolve({ code, signal }));
      terminal.once('error', reject);
    });
    const primary = Error('fixture interrupted; no cancellation inferred');
    const calls = [],
      gui = {
        async dispose() {
          calls.push('GUI');
        },
      },
      session = {
        desktop: {},
        async dispose(error) {
          assert.equal(error, primary);
          calls.push('runtime');
        },
      };
    const retire = () =>
      retireHandoff({ root, terminal, terminalClosed, gui, session, original: primary });
    try {
      await wait(() => {
        assert.equal(terminal.exitCode, null, stderr);
        return existsSync(join(root, 'tui-ready'));
      }, 5000);
      const identity = JSON.parse(readFileSync(join(root, 'child.json'), 'utf8'));
      assert.equal(processIdentity(identity.pid).start, identity.start);
      await retire();
      retired = true;
      assert.deepEqual(await terminalClosed, { code: 143, signal: null });
      assert.deepEqual(calls, ['GUI', 'runtime']);
      const proof = JSON.parse(readFileSync(join(root, 'handoff-retirement.json'), 'utf8'));
      assert.equal(proof.tui.pid, identity.pid);
      assert.equal(proof.tui.startTime, identity.start);
      assert.equal(proof.tui.interrupted, true);
      assert.equal(proof.tui.joined, true);
      assert.equal(proof.tui.exit, -9);
      assert.equal(proof.tui.effectCancellationConfirmed, false);
      assert.equal(processIdentity(identity.pid), null);
      assert.deepEqual(proof.failures, []);
      t.diagnostic(
        JSON.stringify({
          wrapper: proof.tui.wrapperPid,
          wrapperExit: proof.tui.wrapperExit,
          child: identity,
          childExit: proof.tui.exit,
          childGone: true,
          cancellationConfirmed: false,
        }),
      );
    } finally {
      if (!retired) await retire();
      rmSync(root, { recursive: true });
    }
  },
);
