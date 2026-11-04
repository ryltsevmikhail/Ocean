// OPTIONAL live GitHub qualification for the RC2 read-issues pilot.
//
// Runs ONLY when the owner explicitly provides an environment reference and the
// exact repository:
//   OCEAN_GITHUB_TEST_TOKEN_REF=OCEAN_GITHUB_TEST_TOKEN
//   OCEAN_GITHUB_TEST_REPOSITORY=owner/name
// The credential VALUE is read from the named variable into the owner process
// only; it is never printed, logged or written to the profile. Without both
// variables this driver reports the external prerequisite as missing and exits
// 3 — it never substitutes a local fixture for live acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import console from 'node:console';
import { openExecutorPluginTransport } from '../../cli/dist/plugin-transport.js';
import { deterministicProvider } from './github-fixture.mjs';
import { startLocalRuntime } from '../../cli/dist/local-runtime/host.js';

const reference = process.env.OCEAN_GITHUB_TEST_TOKEN_REF ?? '';
const repository = process.env.OCEAN_GITHUB_TEST_REPOSITORY ?? '';
if (reference === '' || repository === '') {
  console.log(
    'LIVE GITHUB GATE NOT QUALIFIED: external prerequisite missing ' +
      '(set OCEAN_GITHUB_TEST_TOKEN_REF to an environment variable NAME and ' +
      'OCEAN_GITHUB_TEST_REPOSITORY to owner/name).',
  );
  process.exit(3);
}
const credential = process.env[reference];
if (credential === undefined || credential.trim() === '') {
  console.log('LIVE GITHUB GATE NOT QUALIFIED: named credential reference is empty.');
  process.exit(3);
}
const [owner, name] = repository.split('/');
assert.ok(
  owner !== undefined && name !== undefined,
  'OCEAN_GITHUB_TEST_REPOSITORY must be owner/name',
);
const cli = resolve(process.env.OCEAN_QA_CLI ?? 'apps/cli/dist/main.js');
const root = mkdtempSync(join(tmpdir(), 'ocean-task6-live-'));
const profile = join(root, 'profile');
const workspace = join(root, 'workspace');
for (const directory of [root, profile, workspace])
  mkdirSync(directory, { recursive: true, mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'),
  TMPDIR: join(root, 'tmp'),
  [reference]: credential,
};
for (const key of [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
])
  mkdirSync(env[key], { recursive: true, mode: 0o700 });
const run = (...words) => {
  const output = execFileSync(process.execPath, [cli, ...words, '--profile', profile, '--json'], {
    env,
    encoding: 'utf8',
  });
  return JSON.parse(output).data;
};
const evidence = { reference, repository, steps: [] };
let host;
try {
  run('init', '--workspace', workspace);
  const reply = (value) =>
    value !== null && typeof value === 'object' && 'data' in value ? value.data : value;
  const dev = reply(run('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'reviewer'));
  reply(run('bot', 'add', '--handle', 'review', '--name', 'Review', '--role', 'reviewer'));
  const room = reply(
    run('room', 'group', '--name', 'Live GitHub', '--bot', 'dev', '--bot', 'review'),
  );
  // The owner process opens the real qualified transport against the shipped
  // GitHub endpoint (no local override) and keeps the reference only in memory.
  const transport = await openExecutorPluginTransport({
    env,
    connection: () => ({
      pluginId: 'github',
      endpoint: 'https://api.githubcopilot.com/mcp/',
      credentialReference: reference,
    }),
  });
  const qualification = transport.qualification();
  assert.equal(qualification.qualified, true, 'the pinned transport must qualify');
  host = await startLocalRuntime({
    profile,
    provider: deterministicProvider(),
    pluginTransport: transport,
    pluginEnv: env,
  });
  evidence.steps.push({ step: 'transport-qualified', identities: qualification.identities });
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
    reference,
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
  evidence.steps.push({
    step: 'discovered',
    tools: discovered.connection.tools,
    identity: discovered.connection.identityLabel,
  });
  run(
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
    repository,
    '--tool',
    'list_issues',
    '--tool',
    'issue_read',
    '--acknowledge-group-visibility',
  );
  run('send', room.id, '--text', 'Прочитай первый открытый issue в ' + repository, '--to', dev.id);
  let answered;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const history = run('history', room.id, '--limit', '20');
    answered = history.find((message) => message.author === 'bot');
    if (answered !== undefined) break;
    await sleep(250);
  }
  assert.ok(answered !== undefined, 'the live model turn did not publish an answer');
  const operations = run('plugin', 'operations', 'list', '--room', room.id);
  assert.equal(operations.length, 1, 'exactly one plugin operation is expected');
  assert.equal(operations[0].state, 'observed');
  evidence.steps.push({ step: 'operation', operation: operations[0] });
  evidence.steps.push({ step: 'answer', text: answered.body });
  writeFileSync(join(root, 'live-qualification-evidence.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(
    'LIVE GITHUB GATE QUALIFIED',
    JSON.stringify({ repository, tools: discovered.connection.tools }),
  );
  console.log('evidence', join(root, 'live-qualification-evidence.json'));
} catch (error) {
  console.error('LIVE GITHUB GATE FAILED', error);
  try {
    writeFileSync(join(root, 'live-qualification-failure.log'), String(error?.stack ?? error));
  } catch {
    /* preserve whatever exists */
  }
  process.exitCode = 1;
} finally {
  if (host !== undefined) await host.stop().catch(() => {});
}
