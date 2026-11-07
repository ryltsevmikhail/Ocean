import assert from 'node:assert/strict';
import { once } from 'node:events';
import process from 'node:process';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { launchDesktopGroup } from './desktop-launcher.mjs';

function absent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return true;
  }
}

for (const action of ['dispose', 'waitForClose']) {
  test(action + ' handles a dead group leader and a child holding the launcher pipe', async () => {
    const leader = `
      const {spawn} = require('node:child_process');
      process.on('SIGUSR2', () => process.exit(0));
      const child = spawn(process.execPath, ['-e','setInterval(() => {}, 1000)'], {stdio:'inherit'});
      child.once('spawn', () => console.log(child.pid));
      setInterval(() => {}, 1000);
    `;
    const group = launchDesktopGroup(process.execPath, ['-e', leader], {});
    const { proc } = group;
    const closed = once(proc, 'close');
    let closedAlready = false;
    void closed.then(() => {
      closedAlready = true;
    });
    try {
      const childPid = Number(String((await once(proc.stdout, 'data'))[0]).trim());
      assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
      const exited = once(proc, 'exit');
      const normalExit = action === 'waitForClose';
      proc.kill(normalExit ? 'SIGUSR2' : 'SIGTERM');
      const status = normalExit ? [0, null] : [null, 'SIGTERM'];
      assert.deepEqual(await exited, status);
      assert.equal(absent(childPid), false);
      assert.equal(closedAlready, false);
      const watchdog = () =>
        setTimeout(1000, null, { ref: false }).then(() => {
          throw Error('independent watchdog');
        });
      if (action === 'waitForClose') {
        await assert.rejects(
          Promise.race([group.waitForClose(40), watchdog()]),
          /Desktop launcher close timed out/,
        );
      }
      await Promise.race([group.dispose(500), watchdog()]);
      assert.equal(absent(childPid), true, 'owned child still running after disposal');
      assert.equal(absent(-proc.pid), true, 'owned process group survived');
      assert.deepEqual(await closed, status);
      await group.dispose(100);
    } finally {
      if (!absent(-proc.pid)) process.kill(-proc.pid, 'SIGKILL');
      await closed;
    }
  });
}

test('a denied group signal reports the permission error', async (t) => {
  const group = launchDesktopGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {});
  const { proc } = group;
  const denied = Object.assign(Error('synthetic permission failure'), { code: 'EPERM' });
  const signal = t.mock.method(process, 'kill', (pid) => {
    assert.equal(pid, -proc.pid);
    throw denied;
  });
  try {
    await assert.rejects(group.dispose(500), (error) => error === denied);
  } finally {
    signal.mock.restore();
    await group.dispose(1000);
  }
  assert.equal(absent(-proc.pid), true);
});

test('dispose awaits a pnpm-style child in another group of the owned session', async () => {
  const code = `
    const {spawn} = require('node:child_process');
    const child = spawn('python3', ['-c', 'import os,time; os.setpgrp(); print(os.getpid(),flush=True); time.sleep(60)'], {stdio:'inherit'});
    setInterval(() => {}, 1000);
  `;
  const group = launchDesktopGroup(process.execPath, ['-e', code], {});
  const childPid = Number(String((await once(group.proc.stdout, 'data'))[0]).trim());
  try {
    await group.dispose(500);
    assert.equal(absent(childPid), true);
  } finally {
    if (!absent(childPid)) process.kill(childPid, 'SIGKILL');
    await group.dispose(1000);
  }
});

test('tracked immediate exit retains its own launch identity before the first poll', async () => {
  const group = launchDesktopGroup('/usr/bin/false', [], {}, { track: true });
  const initial = group.records();
  try {
    assert.equal(initial.length, 1);
    assert.equal(initial[0].pid, group.proc.pid);
    assert.equal(initial[0].session, group.proc.pid);
    assert.match(initial[0].start, /^[1-9][0-9]*$/);
    assert.equal(await group.waitForClose(), 1);
    assert.deepEqual(group.records(), initial);
    assert.equal(absent(initial[0].pid), true);
  } finally {
    await group.dispose();
  }
});

test('failed spawn reports no PID and no observed identities', async () => {
  const group = launchDesktopGroup('/missing/ocean-qa-executable', [], {}, { track: true });
  assert.equal(group.launch.observation, 'no-pid');
  assert.deepEqual(group.records(), []);
  await assert.rejects(group.waitForClose(500), { code: 'ENOENT' });
  await assert.rejects(group.dispose(500), { code: 'ENOENT' });
});
