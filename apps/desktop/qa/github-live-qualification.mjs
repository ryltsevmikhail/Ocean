// Explicitly authorized live GitHub read-only qualification. No implicit credentials.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setTimeout as sleep } from 'node:timers/promises';
import { deterministicProvider } from './github-fixture.mjs';
import { liveCli, observeGithubRequests, scanPrivateTree } from './github-live-support.mjs';
import { startLocalRuntime } from '../../cli/dist/local-runtime/host.js';

const reference = process.env.OCEAN_GITHUB_TEST_TOKEN_REF ?? '';
const repository = process.env.OCEAN_GITHUB_TEST_REPOSITORY ?? '';
const credential = process.env[reference];
const issueNumber = Number(process.env.OCEAN_GITHUB_TEST_ISSUE ?? 0);
const marker = process.env.OCEAN_GITHUB_TEST_MARKER ?? '';
if (
  !/^[A-Z_][A-Z0-9_]{0,127}$/.test(reference) ||
  !credential?.trim() ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
  !Number.isSafeInteger(issueNumber) ||
  issueNumber < 1 ||
  marker.length === 0
) {
  console.log(
    'LIVE GITHUB GATE NOT QUALIFIED: explicit credential reference, repository, existing issue and marker required.',
  );
  process.exit(3);
}
const cli = resolve(process.env.OCEAN_QA_CLI ?? 'apps/cli/dist/main.js');
const root = mkdtempSync(join(tmpdir(), 'ogl-'));
const evidenceRoot = process.env.OCEAN_GITHUB_EVIDENCE_DIR ?? root;
const profile = join(root, 'profile');
const workspace = join(root, 'workspace');
for (const directory of [root, profile, workspace, evidenceRoot])
  mkdirSync(directory, { recursive: true, mode: 0o700 });
const env = { PATH: process.env.PATH, [reference]: credential };
for (const [key, suffix] of Object.entries({
  HOME: 'home',
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state',
  XDG_RUNTIME_DIR: 'run',
  TMPDIR: 'tmp',
})) {
  env[key] = join(root, suffix);
  mkdirSync(env[key], { mode: 0o700 });
  process.env[key] = env[key];
}
const run = liveCli(cli, profile, { ...env, [reference]: undefined });
const evidence = {
  reference,
  repository,
  issueNumber,
  root,
  provider: 'deterministic; zero external model calls',
  cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
  steps: [],
};
const observer = observeGithubRequests(repository);
const plan = { repository, issueNumber, tool: 'list_issues' };
const provider = deterministicProvider(plan);
let host;
const reply = (value) =>
  value !== null && typeof value === 'object' && 'data' in value ? value.data : value;
let connection;
const discover = async () => {
  const current = (await run('plugin', 'connections', 'list')).find(
    (item) => item.id === connection.id,
  );
  // Each metadata pass has a distinct explicit owner acknowledgement, never a retry.
  await run(
    'plugin',
    'connections',
    'consent',
    '--connection',
    current.id,
    '--generation',
    String(current.generation),
    '--acknowledge-endpoint',
  );
  const discovered = await run(
    'plugin',
    'connections',
    'discover',
    '--connection',
    current.id,
    '--generation',
    String(current.generation),
  );
  assert.deepEqual(discovered.connection.tools, ['issue_read', 'list_issues']);
  assert.equal(discovered.connection.readiness, 'ready');
  evidence.steps.push({
    step: 'consented-discovery',
    generation: discovered.connection.generation,
    schemaDigest: discovered.connection.schemaDigest,
    identity: discovered.connection.identityLabel,
  });
};
const chat = async (room, bot, label, expectedCalls, expectedText) => {
  const before = observer.business();
  const previous = await run('history', room, '--limit', '100');
  const ids = new Set(previous.map((message) => message.id));
  await run('send', room, '--text', label, '--to', bot);
  let answer;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const history = await run('history', room, '--limit', '100');
    answer = history.find((message) => message.author === 'bot' && !ids.has(message.id));
    if (answer !== undefined) break;
    await sleep(100);
  }
  assert.ok(answer, 'chat answer not published');
  assert.equal(observer.business() - before, expectedCalls, label + ' business count');
  if (expectedText !== undefined)
    assert.ok(answer.body.includes(expectedText), label + ' actual result');
  evidence.steps.push({
    step: label,
    businessRequests: observer.business() - before,
    answerSha256: createHash('sha256').update(answer.body).digest('hex'),
    actualMarkerObserved: answer.body.includes(marker),
  });
};
try {
  await run('init', '--workspace', workspace);
  const dev = reply(
    await run('bot', 'add', '--handle', 'dev', '--name', 'Dev', '--role', 'reviewer'),
  );
  const review = reply(
    await run('bot', 'add', '--handle', 'review', '--name', 'Review', '--role', 'reviewer'),
  );
  const room = reply(
    await run('room', 'group', '--name', 'Live GitHub', '--bot', 'dev', '--bot', 'review'),
  );
  const otherRoom = reply(await run('room', 'direct', '--bot', 'dev'));
  host = await startLocalRuntime({ profile, provider, pluginEnv: env });
  assert.ok(host.identity.capabilities.includes('plugin.session-authority-v1'));
  assert.equal(observer.requests.length, 0, 'startup must be network-free');
  evidence.steps.push({ step: 'normal-host-start', identity: host.identity });
  await run('plugin', 'catalog', 'install', '--plugin', 'github');
  await run('plugin', 'catalog', 'enable', '--plugin', 'github');
  connection = await run(
    'plugin',
    'connections',
    'add',
    '--name',
    'qualification',
    '--plugin',
    'github',
    '--credential-env',
    reference,
  );
  await discover();
  const grant = async (tools) =>
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
      ...tools.flatMap((tool) => ['--tool', tool]),
      '--acknowledge-group-visibility',
    );
  await grant(['list_issues']);
  await chat(room.id, dev.id, 'List issues in ' + repository, 1, marker);
  plan.tool = 'issue_read';
  await chat(room.id, dev.id, 'Denied ungranted issue_read', 0, 'tool_ungranted');
  await grant(['list_issues', 'issue_read']);
  await chat(room.id, dev.id, 'Read existing issue ' + String(issueNumber), 1, marker);
  plan.repository = 'outside/denied';
  await chat(room.id, dev.id, 'Denied repository', 0, 'repository');
  plan.repository = repository;
  await chat(room.id, review.id, 'Denied bot', 0);
  await chat(otherRoom.id, dev.id, 'Denied room', 0);
  const beforeRestart = observer.requests.length;
  assert.equal((await host.stop()).state, 'stopped');
  await host.closed;
  host = await startLocalRuntime({ profile, provider, pluginEnv: env });
  assert.equal(observer.requests.length, beforeRestart, 'restart must not discover/replay');
  const restarted = (await run('plugin', 'connections', 'list'))[0];
  assert.equal(restarted.readiness, 'discovery_required');
  assert.equal(restarted.schemaDigest, null);
  const grants = await run('plugin', 'access', 'list');
  assert.ok(grants.every((entry) => entry.state === 'revoked'));
  await chat(room.id, dev.id, 'Denied after restart before owner recovery', 0);
  evidence.steps.push({
    step: 'restart-inert',
    connection: restarted,
    grantsRevoked: grants.length,
  });
  await run('plugin', 'catalog', 'enable', '--plugin', 'github');
  await discover();
  await grant(['list_issues', 'issue_read']);
  await chat(room.id, dev.id, 'Read after explicit owner recovery', 1, marker);
  const operations = await run('plugin', 'operations', 'list', '--room', room.id);
  assert.equal(operations.length, 3);
  assert.ok(
    operations.every(
      (operation) => operation.state === 'observed' && operation.outcomeCode === 'ok',
    ),
  );
  evidence.operations = operations;
  evidence.modelRequests = provider.requestCount();
  assert.equal(observer.business(), 3);
  assert.ok(observer.requests.every((entry) => entry.fixedTools && entry.readonly));
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.failure = String(error?.message ?? 'unknown')
    .replaceAll(credential, '[redacted]')
    .slice(0, 300);
  process.exitCode = 1;
} finally {
  if (host !== undefined) {
    evidence.stop = await host.stop();
    if (evidence.stop.state === 'stopped') await host.closed;
  }
  observer.close();
  evidence.requests = observer.requests;
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
  evidence.durable = {
    operations: db
      .prepare(
        'SELECT tool, state, outcome_code, connection_generation FROM ocean_plugin_operations',
      )
      .all(),
    consents: db.prepare('SELECT generation, used_at FROM ocean_plugin_consents').all(),
    quickCheck: db.prepare('PRAGMA quick_check').all(),
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
  };
  db.close();
  evidence.secretScan = { files: scanPrivateTree(root, credential), exactSecretFound: false };
  writeFileSync(join(evidenceRoot, 'live-report.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  scanPrivateTree(evidenceRoot, credential);
  console.log(
    'LIVE GITHUB GATE',
    evidence.status,
    JSON.stringify({
      repository,
      businessRequests: observer.business(),
      failure: evidence.failure ?? null,
      report: join(evidenceRoot, 'live-report.json'),
    }),
  );
}
