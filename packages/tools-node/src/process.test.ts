import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { commandEnvironment, runCommand } from './process.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function child() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  return child;
}
it('does not pass provider credentials into child environments', () => {
  expect(
    commandEnvironment({ PATH: '/bin', DEEPSEEK_API_KEY: 'fake', AWS_SECRET_ACCESS_KEY: 'fake' }),
  ).toEqual({ PATH: '/bin' });
});
it('classifies timeout after a possible effect as uncertain and awaits close', async () => {
  vi.useFakeTimers();
  const proc = child();
  const result = runCommand('node', ['test.mjs'], '/workspace', new AbortController().signal);
  proc.stdout.write('changed file');
  await vi.advanceTimersByTimeAsync(60000);
  expect(process.kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
  proc.emit('close', null, 'SIGKILL');
  expect(await result).toMatchObject({
    isError: true,
    uncertain: true,
    output: expect.stringContaining('timed out'),
  });
});
it('cancels a process group without reporting ordinary failure', async () => {
  vi.useFakeTimers();
  const proc = child();
  const controller = new AbortController();
  const result = runCommand('node', [], '/workspace', controller.signal);
  controller.abort();
  proc.emit('close', null, 'SIGKILL');
  expect(await result).toMatchObject({ uncertain: true });
});
it('bounds waiting when descendants keep inherited pipes open', async () => {
  vi.useFakeTimers();
  const proc = child();
  const controller = new AbortController();
  const result = runCommand('node', [], '/workspace', controller.signal);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({
    isError: true,
    uncertain: true,
    output: expect.stringContaining('unconfirmed'),
  });
  expect(proc.unref).toHaveBeenCalled();
});
it('does not use a successful leader exit as proof that its process tree stopped', async () => {
  const proc = child();
  const result = runCommand('node', [], '/workspace', new AbortController().signal);
  proc.emit('close', 0, null);
  expect(await result).toMatchObject({ uncertain: true });
});
it('does not mistake a post-spawn process error for proof of no effect', async () => {
  vi.useFakeTimers();
  const proc = child();
  const result = runCommand('node', [], '/workspace', new AbortController().signal);
  proc.emit('error', new Error('kill failed'));
  proc.emit('close', 0, null);
  expect(await result).toMatchObject({ uncertain: true, isError: true });
});
