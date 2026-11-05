import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { setInterval, clearInterval } from 'node:timers';

export function processIdentity(pid, read = readFileSync) {
  try {
    const stat = read('/proc/' + pid + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (!/^[1-9][0-9]*$/.test(fields[19]) || !Number.isInteger(Number(fields[3])))
      throw Error('invalid process identity');
    return {
      pid,
      start: fields[19],
      parent: Number(fields[1]),
      session: Number(fields[3]),
      group: Number(fields[2]),
      state: fields[0],
    };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}

// A detached Linux launcher creates a new session and process group with its own PID.
export function launchDesktopGroup(command, args, env, { track = false } = {}) {
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

  const seen = new Map();
  let observationError;
  function sample() {
    if (!pgid) return [];
    const rows = readdirSync('/proc')
      .filter((p) => /^\d+$/.test(p))
      .map((p) => processIdentity(Number(p)))
      .filter(Boolean);
    const leader = rows.find((row) => row.pid === pgid);
    if (leader && leader.start !== leaderStart) throw Error('Desktop session ownership changed');
    const own = new Set(
      rows
        .filter((row) => row.session === pgid || seen.has(row.pid + ':' + row.start))
        .map((row) => row.pid),
    );
    // Descendants may form child process groups or sessions.
    for (let before = -1; before !== own.size;) {
      before = own.size;
      for (const row of rows) if (own.has(row.parent)) own.add(row.pid);
    }
    for (const row of rows) if (own.has(row.pid)) seen.set(row.pid + ':' + row.start, row);
    return Array.from(seen.values()).filter((row) => processIdentity(row.pid)?.start === row.start);
  }
  const monitor = track
    ? setInterval(() => {
        try {
          sample();
        } catch (e) {
          observationError ??= e;
        }
      }, 150).unref()
    : null;
  function finishTracking() {
    clearInterval(monitor);
    if (observationError) throw observationError;
  }
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
    if (track) {
      const remaining = sample();
      if (!remaining.length) {
        groupGone = true;
        return;
      }
      for (const row of remaining) {
        const current = processIdentity(row.pid);
        if (!current || current.start !== row.start) continue;
        if (current.session !== row.session) throw Error('Owned process changed session');
        try {
          process.kill(row.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      return;
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
        if (groupGone) {
          finishTracking();
          return closeCode;
        }
      }
      await setTimeout(20);
    } while (performance.now() < deadline);
    throw Error('Desktop launcher close timed out (stdio or process group still present)');
  }

  async function dispose(timeoutMs = 10000) {
    try {
      if (track) {
        signalGroup('SIGTERM');
        try {
          await waitForClose(Math.min(timeoutMs, 1000));
          return;
        } catch (error) {
          if (!error.message.includes('close timed out')) throw error;
        }
      }
      signalGroup('SIGKILL');
      await waitForClose(timeoutMs);
    } finally {
      // Release our handles even if OS permission or an escaped pipe holder prevents proof.
      clearInterval(monitor);
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.unref();
    }
  }
  return { proc, waitForClose, dispose, records: () => [...seen.values()], sample };
}
