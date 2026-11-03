import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

// A detached Linux launcher creates a new session and process group with its own PID.
export function launchDesktopGroup(command, args, env) {
  const proc = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pgid = proc.pid;
  let groupGone = false,
    closeCode,
    launchError;
  proc.once('close', (code) => {
    closeCode = code;
  });
  proc.once('error', (error) => {
    launchError = error;
  });

  function signalGroup(signal) {
    if (groupGone || pgid === undefined) return;
    if (!Number.isSafeInteger(pgid) || pgid <= 1) throw Error('Invalid Desktop process group');
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      groupGone = true;
    }
  }

  async function waitForClose(timeoutMs = 10000) {
    const deadline = performance.now() + timeoutMs;
    do {
      if (launchError) throw launchError;
      if (closeCode !== undefined) {
        signalGroup(0);
        if (groupGone) return closeCode;
      }
      await setTimeout(20);
    } while (performance.now() < deadline);
    throw Error('Desktop launcher close timed out (stdio or process group still present)');
  }

  async function dispose(timeoutMs = 10000) {
    try {
      signalGroup('SIGKILL');
      await waitForClose(timeoutMs);
    } finally {
      // Release our handles even if OS permission or an escaped pipe holder prevents proof.
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.unref();
    }
  }
  return { proc, waitForClose, dispose };
}
