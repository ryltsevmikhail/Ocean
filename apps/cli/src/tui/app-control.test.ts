/**
 * App control tests: cancellation, quitting, terminal restoration and the
 * redirected-stream path. All streams, services and providers are injected.
 */

import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunService, type CommandReceipt } from '@runnets/application';
import type { AnyCommand, Result } from '@runnets/domain';
import type { ModelRequest, ProviderEvent, ProviderPort } from '@runnets/provider-core';
import {
  InMemoryCommandDedup,
  InMemoryEventLog,
  SequentialIdGenerator,
  systemClock,
} from '@runnets/store';

import { createService } from '../lifecycle.js';
import { TuiApp } from './app.js';
import { runTui } from './run.js';

const MODEL = 'fake-model';
const SIZE = { columns: 100, rows: 30 };
const CAPABILITIES = { streaming: true, reasoning: true, usage: true } as const;

interface Streams {
  readonly input: PassThrough;
  readonly output: PassThrough;
}

interface TtyStreams extends Streams {
  readonly raw: boolean[];
}

interface FakeInput extends PassThrough {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

interface FakeOutput extends PassThrough {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

function streams(): Streams {
  return { input: new PassThrough(), output: new PassThrough() };
}

function ttyStreams(): TtyStreams {
  const input: FakeInput = new PassThrough();
  input.isTTY = true;
  const raw: boolean[] = [];
  input.setRawMode = (mode: boolean): void => {
    raw.push(mode);
  };
  const output: FakeOutput = new PassThrough();
  output.isTTY = true;
  output.columns = SIZE.columns;
  output.rows = SIZE.rows;
  return { input, output, raw };
}

function readAll(stream: PassThrough): string {
  let text = '';
  for (;;) {
    const chunk: unknown = stream.read();
    if (chunk === null || chunk === undefined) break;
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return text;
}

function appOf(harness: Streams, provider: ProviderPort | null): TuiApp {
  return new TuiApp({
    input: harness.input,
    output: harness.output,
    service: createService(),
    provider,
    size: SIZE,
  });
}

class FailingService extends TaskRunService {
  override async execute(_command: AnyCommand): Promise<Result<CommandReceipt>> {
    throw new Error('boom');
  }
}

function failingService(): TaskRunService {
  return new FailingService({
    log: new InMemoryEventLog(),
    clock: systemClock,
    ids: new SequentialIdGenerator(),
    dedup: new InMemoryCommandDedup(),
  });
}

/**
 * A provider whose stream never produces an event: it reports that it started
 * and waits until the turn signal is aborted. Implemented as a raw async
 * iterable (not a generator) so the abort listener is registered on the first
 * `next()` and a cancellation that races the first read cannot be missed.
 */
function hangingProvider(markStarted: () => void): ProviderPort {
  return {
    id: 'fake',
    models: [MODEL],
    capabilities: CAPABILITIES,
    stream(request: ModelRequest): AsyncIterable<ProviderEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          return {
            next: (): Promise<IteratorResult<ProviderEvent>> => {
              markStarted();
              const signal = request.signal;
              if (signal === undefined) return new Promise(() => {});
              if (signal.aborted) {
                return Promise.reject(new DOMException('aborted', 'AbortError'));
              }
              return new Promise((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    reject(new DOMException('aborted', 'AbortError'));
                  },
                  { once: true },
                );
              });
            },
          };
        },
      };
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('TuiApp control', () => {
  it('requests cancellation with Escape without inventing remote completion', async () => {
    const harness = streams();
    let markStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const app = appOf(
      harness,
      hangingProvider(() => markStarted()),
    );
    await app.start();

    harness.input.write('\r');
    harness.input.write('stop me');
    harness.input.write('\r');
    await started;

    expect(app.ui.busy).toBe(true);
    expect(app.frame()).toContain('running');

    vi.useFakeTimers();
    harness.input.write('\u001b');
    vi.advanceTimersByTime(50);
    expect(app.ui.status).toBe('cancelling turn…');
    await app.idle();

    expect(app.ui.busy).toBe(false);
    expect(app.selectedRun()?.aggregate?.status).toBe('cancelling');
    expect(app.frame()).toContain('outcome unknown');
    harness.input.write('\x1bOR');
    expect(app.frame()).toContain('task_run.cancelling');
    expect(app.frame()).not.toContain('task_run.cancelled');

    app.stop();
  });

  it('quits on the second idle Ctrl+C', async () => {
    const harness = streams();
    const app = appOf(harness, null);
    await app.start();

    harness.input.write('\u0003');
    expect(app.ui.ctrlCArmed).toBe(true);
    expect(app.ui.status).toContain('Ctrl+C again');

    harness.input.write('\u0003');
    await app.whenExit();
    expect(app.ui.ctrlCArmed).toBe(false);

    app.stop();
  });

  it('quits when the input stream ends (closed or piped stdin)', async () => {
    const harness = streams();
    const app = appOf(harness, null);
    await app.start();

    harness.input.end();
    await app.whenExit();

    app.stop();
  });

  it('quits with /quit and restores the terminal on a TTY', async () => {
    const tty = ttyStreams();
    const app = new TuiApp({
      input: tty.input,
      output: tty.output,
      service: createService(),
      provider: null,
    });
    await app.start();
    expect(tty.raw).toEqual([true]);

    tty.input.write('/quit\r');
    await app.whenExit();

    const text = readAll(tty.output);
    expect(text).toContain('\u001b[?1049h');
    expect(text).toContain('\u001b[?25h');
    expect(text).toContain('\u001b[?1049l');
    expect(tty.raw).toEqual([true, false]);
  });

  it('writes plain frames and no escape sequences on redirected streams', async () => {
    const harness = streams();
    const app = appOf(harness, null);
    await app.start();

    const text = readAll(harness.output);
    expect(text).not.toContain('\u001b');
    expect(text).toContain('RunneTS TUI');
    expect(text).toContain('tr_tui_0001');

    app.stop();
  });

  it('keeps drafts when Escape closes a panel and continues editing after return', async () => {
    const harness = streams();
    const app = appOf(harness, null);
    await app.start();

    harness.input.write('\r');
    harness.input.write('draft');
    expect(app.ui.prompt).toBe('draft');
    expect(app.ui.focus).toBe('prompt');

    harness.input.write('\x1bOQ');
    vi.useFakeTimers();
    harness.input.write('\u001b');
    vi.advanceTimersByTime(50);
    expect(app.ui.prompt).toBe('draft');
    expect(app.ui.focus).toBe('prompt');
    harness.input.write('q');
    expect(app.ui.prompt).toBe('draftq');

    app.stop();
  });

  it('restores the terminal when runTui fails after entering it', async () => {
    const tty = ttyStreams();
    const service = failingService();

    await expect(
      runTui({ input: tty.input, output: tty.output, service, provider: null }),
    ).rejects.toThrow('boom');

    const text = readAll(tty.output);
    expect(text).toContain('\u001b[?1049h');
    expect(text).toContain('\u001b[?25h');
    expect(text).toContain('\u001b[?1049l');
    expect(tty.raw).toEqual([true, false]);
  });

  it('exits 0 when the user quits the runTui entry point', async () => {
    const harness = streams();
    const exit = runTui({
      input: harness.input,
      output: harness.output,
      service: createService(),
      provider: null,
      size: SIZE,
    });

    harness.input.write('/quit\r');
    await expect(exit).resolves.toBe(0);
    expect(readAll(harness.output)).toContain('RunneTS TUI');
  });
});
