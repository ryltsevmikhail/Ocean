import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderPort } from '@runnets/application';
import { LOCAL_CODING_WORKSPACE } from '@runnets/contracts';
import { connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime } from '../local-runtime/host.js';
import * as capabilities from '../local-runtime/capabilities.js';
import { gatedProvider, rooms } from '../../test-fixtures/local-runtime-admission.test.js';
import { gate } from '../../test-fixtures/remote-terminal.test.js';
import { codingWorkflowFixture, initialMath } from './coding-workflow-fixture.js';
import { runOceanCommand } from './command.js';
import { openOceanProfile } from './profile.js';

const workspaceId = 'ws_ocean';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

function terminal(profile: string, ...flags: string[]) {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 140, rows: 32 });
  const error = new PassThrough();
  let screen = '',
    errors = '';
  output.on('data', (b: Buffer) => (screen += b.toString()));
  error.on('data', (b: Buffer) => (errors += b.toString()));
  const session = runOceanCommand(['tui', '--profile', profile, ...flags], {
    input,
    output,
    error,
  });
  cleanup.push(async () => {
    input.end();
    await session;
  });
  return {
    input,
    session,
    screen: () => screen,
    errors: () => errors,
    wait: (text: string) => vi.waitFor(() => expect(screen).toContain(text), { timeout: 2000 }),
    send: (text: string) => input.write(text + '\r'),
  };
}

async function basicProfile() {
  const root = mkdtempSync(join(tmpdir(), 'project-chooser-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('XDG_RUNTIME_DIR', root);
  const profile = join(root, 'p');
  const offline = openOceanProfile(profile, true);
  await offline.ready;
  try {
    return { profile, ...rooms(offline.conversations) };
  } finally {
    offline.close();
  }
}
async function owner(profile: string, provider: ProviderPort | null = null) {
  const host = await startLocalRuntime({ profile, provider });
  cleanup.push(async () => {
    await host.stop();
    await host.closed;
  });
  const peer = await connectLocalRuntime({ profile });
  cleanup.push(() => peer.close());
  return peer;
}

it.each([
  ['--room', 'room'],
  ['--task', 'task'],
])('rejects --projects with %s before profile access', async (flag, value) => {
  const ui = terminal('/not-a-profile', '--projects', flag, value);
  expect(await ui.session).toBe(2);
  expect(ui.errors()).toContain('--projects cannot be used with --room or --task');
});

it('reports an unsupported owner while the explicit room command still attaches', async () => {
  const base = capabilities.runtimeCapabilities;
  vi.spyOn(capabilities, 'runtimeCapabilities').mockImplementation((...args) =>
    base(...args).filter((capability) => capability !== LOCAL_CODING_WORKSPACE),
  );
  const { profile, roomId } = await basicProfile();
  const peer = await owner(profile);
  expect(peer.identity.capabilities).not.toContain(LOCAL_CODING_WORKSPACE);
  const project = terminal(profile, '--projects');
  expect(await project.session).toBe(2);
  expect(project.errors()).toContain('project_runtime_upgrade_required');
  const legacy = terminal(profile, '--room', roomId, '--task', 'legacy-task');
  await legacy.wait('@dev / test');
  legacy.send('/quit');
  expect(await legacy.session).toBe(0);
});

it('shows an empty catalog without entering a room or stopping the owner', async () => {
  const { profile } = await basicProfile();
  const peer = await owner(profile);
  const ui = terminal(profile, '--projects');
  expect(await ui.session).toBe(0);
  expect(ui.screen()).toContain('No registered projects');
  expect(ui.screen()).not.toContain('Enter send');
  expect(await peer.status()).toMatchObject({ state: 'ready' });
});

async function projectFixture() {
  const f = await codingWorkflowFixture('group');
  cleanup.push(f.close);
  const task = f.runtime.coding.inspect(workspaceId, 'task');
  if (!task.ok) throw Error('fixture task');
  f.runtime.close();
  chmodSync(join(f.directory, 'runtime.sqlite'), 0o600);
  const run = join(f.directory, 'run');
  mkdirSync(run, { mode: 0o700 });
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  writeFileSync(
    join(f.directory, 'coding-projects.json'),
    JSON.stringify([
      { id: 'fixture', root: f.project, testPresets: task.value.policy.testPresets, mounts: [] },
    ]),
    { mode: 0o600 },
  );
  return { ...f, task: task.value, scope: { workspaceId, roomId: f.room } };
}

async function openProject(profile: string) {
  const ui = terminal(profile, '--projects');
  await ui.wait('1. fixture');
  ui.send('1');
  await ui.wait('1. task');
  ui.send('1');
  await ui.wait('Project fixture · task task · dev @dev');
  return ui;
}

it('binds group chat to the selected project task and detaches without replay', async () => {
  const f = await projectFixture();
  const release = gate();
  const selectedRelease = gate();
  const signals: AbortSignal[] = [];
  const provider = {
    ...gatedProvider(
      () => (signals.length === 1 ? release.wait : selectedRelease.wait),
      (signal) => signals.push(signal),
    ),
    id: 'fixture',
    models: ['fixture'],
  };
  const peer = await owner(f.directory, provider);
  cleanup.push(release.open, selectedRelease.open);
  const { scope } = f;
  const other = await peer.submit({ ...scope, requestId: 'ordinary', text: '@dev ordinary' });
  expect(other.runId).toBeTruthy();
  await vi.waitFor(() => expect(signals).toHaveLength(1));

  const chooser = terminal(f.directory, '--projects');
  await chooser.wait('1. fixture');
  chooser.input.end();
  expect(await chooser.session).toBe(0);
  const ui = await openProject(f.directory);
  await ui.wait('@dev ordinary');
  ui.input.write('\x1bOP');
  await ui.wait('Help · Esc close');
  expect(ui.screen()).not.toContain('/broadcast TEXT');
  const help = ui.screen().length;
  ui.input.write('\x1b');
  await vi.waitFor(() => expect(ui.screen().slice(help)).toContain('Dialogue'));
  ui.input.write('\x1b');
  await ui.wait('project_run_out_of_scope');
  expect(signals[0]?.aborted).toBe(false);
  for (const command of ['/broadcast unrelated', '/plugin disable', '/review']) {
    const before = ui.screen().length;
    ui.send(command);
    // Repeated status may share a screen row with a previous refusal.
    await vi.waitFor(() =>
      expect(ui.screen().slice(before)).toContain('Unavailable in project chat'),
    );
  }
  expect(await peer.history(scope)).toHaveLength(1);
  expect(await peer.listRuns(scope)).toHaveLength(1);

  release.open();
  await vi.waitFor(async () =>
    expect(await peer.getRun({ ...scope, runId: other.runId! })).toMatchObject({
      taskStatus: 'succeeded',
    }),
  );
  ui.send('selected dev only');
  await vi.waitFor(async () => expect(await peer.listRuns(scope)).toHaveLength(2));
  const [selected] = (await peer.listRuns(scope)).filter((r) => r.runId !== other.runId);
  expect(selected).toMatchObject({ performerId: f.task.devBotId });
  expect(
    await peer.getReceipt({ ...scope, requestId: selected!.requestId, taskId: 'task' }),
  ).toMatchObject({
    runId: selected!.runId,
  });
  ui.input.end();
  expect(await ui.session).toBe(0);
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[1]?.aborted).toBe(false);

  const reopened = await openProject(f.directory);
  await reopened.wait('selected dev only');
  reopened.input.write('\x1b');
  await reopened.wait('Cancellation requested');
  expect(signals[1]?.aborted).toBe(true);
  selectedRelease.open();
  reopened.send('/quit');
  expect(await reopened.session).toBe(0);
  expect(await peer.listRuns(scope)).toHaveLength(2);
}, 15000);

it('rechecks the selected task receipt immediately before a dev decision vote', async () => {
  const f = await projectFixture();
  let round = 0;
  const peer = await owner(f.directory, {
    id: 'fixture',
    models: ['fixture'],
    capabilities: { streaming: true, usage: true, reasoning: false, toolCalls: true },
    async *stream() {
      const call = [
        { id: 'read', name: 'read_file', arguments: '{"path":"math.cjs"}' },
        {
          id: 'write',
          name: 'write_file',
          arguments: '{"path":"math.cjs","content":"owner-preview"}',
        },
      ][round++];
      if (call) yield { type: 'tool_call', call };
      else yield { type: 'text_delta', text: 'finished fixture' };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      yield {
        type: 'completed',
        stopReason: call ? 'tool_calls' : 'stop',
        rawStopReason: call ? 'tool_calls' : 'stop',
      };
    },
  });
  const ui = await openProject(f.directory);
  ui.send('propose edit');
  const card = await vi.waitFor(
    async () => {
      const found = (await peer.listDecisions(f.scope)).find((row) => row.kind === 'write');
      if (!found) throw Error('waiting for a write decision');
      return found;
    },
    { timeout: 4000 },
  );
  const ref = { ...f.scope, runId: card.runId, decisionId: card.decisionId };
  ui.send('/decision ' + card.decisionId);
  await ui.wait('owner-preview');
  expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(initialMath);

  // A correctly scoped lookup becomes a miss at vote time. No resolve can cross that fence.
  let receiptChecks = 0;
  const write = Socket.prototype.write;
  const spy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
    this: Socket,
    ...args: Parameters<typeof write>
  ) {
    if (Buffer.isBuffer(args[0]) && args[0].at(0) === 123) {
      const frame = JSON.parse(args[0].toString());
      if (frame.method === 'receipts.get' && frame.params.taskId === 'task') {
        receiptChecks++;
        frame.params.taskId = 'different-task';
        args[0] = Buffer.from(JSON.stringify(frame) + '\n');
      }
    }
    return Reflect.apply(write, this, args) as boolean;
  });
  try {
    ui.input.write('n');
    await vi.waitFor(() => expect(receiptChecks).toBeGreaterThan(0));
    expect(await peer.getDecision(ref)).toMatchObject({ status: 'pending', version: 1 });
  } finally {
    spy.mockRestore();
  }
  // Closing the card and opening a new exact preview allows an explicit decision.
  ui.input.write('\x1b');
  const before = ui.screen().length;
  ui.send('/decision ' + card.decisionId);
  await vi.waitFor(() => expect(ui.screen().slice(before)).toContain('owner-preview'));
  ui.input.write('n');
  await vi.waitFor(async () =>
    expect(await peer.getDecision(ref)).toMatchObject({ status: 'denied', version: 2 }),
  );
  expect(readFileSync(join(f.worktree, 'math.cjs'), 'utf8')).toBe(initialMath);
  ui.input.end();
  expect(await ui.session).toBe(0);
}, 15000);
