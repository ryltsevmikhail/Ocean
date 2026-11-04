// Task 6 CLI + TUI demonstration on a private synthetic fixture.
//
// The owner runtime is a QA host that composes the real qualified Executor
// transport against a loopback GitHub-like MCP server and a deterministic
// provider (one `issue_read` tool call). Everything else is the shipped CLI/TUI
// path: install, enable, named connection, consent, discovery, grant, chat,
// durable operation views.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import console from 'node:console';

const cli = resolve(process.env.OCEAN_QA_CLI ?? 'apps/cli/dist/main.js');
const root = mkdtempSync(join(process.env.OCEAN_QA_ROOT ?? tmpdir(), 'ocean-task6-cli-'));
const profile = join(root, 'profile');
const workspace = join(root, 'workspace');
const home = join(root, 'home');
mkdirSync(profile, { recursive: true, mode: 0o700 });
mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(home, { recursive: true, mode: 0o700 });
const canary = 'CANARY_GITHUB_PAT_TASK6_CLI_9d2c';
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  TMPDIR: join(root, 'tmp'),
  OCEAN_GITHUB_WORK_TOKEN: canary,
  OCEAN_QA_PLUGIN_LOG: join(root, 'plugin-log.jsonl'),
};
for (const key of [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
])
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
const evidence = { root, steps: [], counters: null };
function run(...words) {
  const output = execFileSync(process.execPath, [cli, ...words, '--profile', profile, '--json'], {
    env,
    encoding: 'utf8',
  });
  evidence.steps.push({ words, code: 0, output });
  return JSON.parse(output).data;
}
function record(step, value) {
  evidence.steps.push({ step, value });
}
const log = () => {
  const path = env.OCEAN_QA_PLUGIN_LOG;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
let host;
try {
  run('init', '--workspace', workspace);
  const reply = (value) =>
    value !== null && typeof value === 'object' && 'data' in value ? value.data : value;
  const dev = reply(run('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'reviewer'));
  const review = reply(
    run('bot', 'add', '--handle', 'review', '--name', 'Review', '--role', 'reviewer'),
  );
  const room = reply(run('room', 'group', '--name', 'Team', '--bot', 'dev', '--bot', 'review'));
  record('seeded', { dev: dev.id, review: review.id, room: room.id });
  host = spawn(
    process.execPath,
    [resolve('apps/desktop/qa/github-runtime-host.mjs'), '--profile', profile],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let hostOut = '';
  host.stdout.on('data', (b) => (hostOut += b.toString()));
  host.stderr.on('data', (b) => (hostOut += b.toString()));
  const deadline = Date.now() + 30_000;
  while (!hostOut.includes('"state":"ready"') && Date.now() < deadline) await sleep(50);
  assert.ok(hostOut.includes('"state":"ready"'), 'runtime owner did not start: ' + hostOut);
  record('host-ready', JSON.parse(hostOut.trim().split('\n').at(-1)));

  run('plugin', 'catalog', 'install', '--plugin', 'github');
  run('plugin', 'catalog', 'enable', '--plugin', 'github');
  const connection = run(
    'plugin',
    'connections',
    'add',
    '--name',
    'work',
    '--plugin',
    'github',
    '--credential-env',
    'OCEAN_GITHUB_WORK_TOKEN',
  );
  run(
    'plugin',
    'connections',
    'consent',
    '--connection',
    connection.id,
    '--generation',
    '1',
    '--acknowledge-endpoint',
  );
  const discovered = run(
    'plugin',
    'connections',
    'discover',
    '--connection',
    connection.id,
    '--generation',
    '1',
  );
  assert.equal(discovered.connection.schemaDigest.length, 64);
  const grant = run(
    'plugin',
    'access',
    'grant',
    '--room',
    room.id,
    '--bot',
    dev.id,
    '--plugin',
    'github',
    '--connection',
    connection.id,
    '--repository',
    'team/api',
    '--tool',
    'list_issues',
    '--tool',
    'issue_read',
    '--acknowledge-group-visibility',
  );
  assert.equal(grant.state, 'active');
  record('grant', {
    id: grant.id,
    repository: grant.repository,
    generation: grant.connectionGeneration,
  });

  const sent = run('send', room.id, '--text', 'Прочитай issue #7 в team/api', '--to', dev.id);
  record('send-receipt', sent);
  let answered = null;
  const answerDeadline = Date.now() + 30_000;
  while (Date.now() < answerDeadline) {
    const history = run('history', room.id, '--limit', '20');
    answered = history.find((message) => message.body.includes('Composer loses focus'));
    if (answered !== undefined) break;
    await sleep(100);
  }
  assert.ok(answered !== undefined, 'the model answer was not published');
  const operations = run('plugin', 'operations', 'list', '--room', room.id);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].state, 'observed');
  assert.equal(operations[0].tool, 'issue_read');
  const shown = run('plugin', 'operations', 'show', '--operation', operations[0].id);
  assert.equal(shown.repository, 'team/api');
  record('operation', {
    id: shown.id,
    state: shown.state,
    tool: shown.tool,
    repository: shown.repository,
    generation: shown.connectionGeneration,
    endpoint: shown.endpoint,
    resultBytes: shown.resultBytes,
    truncated: shown.truncated,
  });
  // A human (non-JSON) view proves the shipped rendering.
  const human = execFileSync(
    process.execPath,
    [cli, 'plugin', 'operations', 'list', '--profile', profile, '--room', room.id],
    { env, encoding: 'utf8' },
  );
  record('operations-human', human.trim().split('\n'));
  assert.ok(human.includes('observed'));

  // TUI: the same allowed path from the terminal client against the same owner.
  // A real 220x40 PTY keeps the run/status line (and the journal notice) visible.
  const reportPath = join(root, 'tui-report.json');
  const tui = spawn(
    'python3',
    [
      resolve('apps/desktop/qa/github-tui-driver.py'),
      process.execPath,
      profile,
      room.id,
      reportPath,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let tuiOut = '';
  tui.stdout.on('data', (chunk) => (tuiOut += chunk.toString()));
  tui.stderr.on('data', (chunk) => (tuiOut += chunk.toString()));
  const [tuiCode] = await Promise.race([once(tui, 'exit'), sleep(90_000).then(() => [1])]);
  const tuiReport = JSON.parse(readFileSync(reportPath, 'utf8'));
  record('tui-report', { code: tuiCode, sampled: tuiReport.observed });
  record('tui-screen-tail', tuiReport.screenTail);
  assert.equal(tuiReport.observed, true, 'the TUI did not render the operation journal: ' + tuiOut);
  evidence.counters =
    log()
      .filter((entry) => entry.kind === 'final')
      .at(-1) ?? null;
} finally {
  if (host !== undefined) {
    host.kill('SIGTERM');
    await Promise.race([new Promise((done) => host.on('exit', done)), sleep(10_000)]);
  }
  const final =
    log()
      .filter((entry) => entry.kind === 'final')
      .at(-1) ?? null;
  const mcpReady = log().find((entry) => entry.kind === 'mcp-ready');
  evidence.counters = {
    mcp: final?.mcpCounts ?? mcpReady?.counts ?? null,
    providerRequests: final?.requests ?? null,
  };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  // The fixture is private; preserve it only when asked, like other QA harnesses.
  if (process.env.OCEAN_QA_PRESERVE !== '1') rmSync(root, { recursive: true, force: true });
  else console.log('FIXTURE', root);
}
console.log('TASK6 CLI/TUI QUALIFIED');
console.log(JSON.stringify(evidence.counters));
