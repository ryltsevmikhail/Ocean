import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

// A detached Linux launcher creates a new session and process group with its own PID.
export function launchDesktopGroup(command, args, env) {
  const proc = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pgid = proc.pid;
  const leaderStat = pgid && readFileSync('/proc/' + pgid + '/stat', 'utf8');
  const leaderStart =
    leaderStat && leaderStat.slice(leaderStat.lastIndexOf(')') + 2).split(' ')[19];
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
      const current = readFileSync('/proc/' + pgid + '/stat', 'utf8');
      const fields = current.slice(current.lastIndexOf(')') + 2).split(' ');
      if (fields[19] !== leaderStart || Number(fields[3]) !== pgid)
        throw Error('Desktop session ownership changed');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
    const groups = new Set();
    for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
      try {
        const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[3]) === pgid && fields[0] !== 'Z') groups.add(Number(fields[2]));
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      }
    }
    // pnpm puts its command shell in a second group within our private session.
    // Await and signal every such group; never reach another user's session.
    if (!groups.size) {
      groupGone = true;
      return;
    }
    for (const group of groups) {
      try {
        process.kill(-group, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
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
