import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type * as cp from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:fs', async (original) => {
  const a = await original<typeof fs>();
  return {
    ...a,
    fstatSync: vi.fn(a.fstatSync),
    lstatSync: vi.fn(a.lstatSync),
    statSync: vi.fn(a.statSync),
    statfsSync: vi.fn(a.statfsSync),
    readFileSync: vi.fn(a.readFileSync),
  };
});
vi.mock('node:child_process', async (original) => {
  const a = await original<typeof cp>();
  return { ...a, spawnSync: vi.fn(a.spawnSync) };
});
import { desktopBootSimulation } from '../../../../packages/tools-node/test-fixtures/desktop-boot.test.js';

import { readDesktopBackupInventory, openSqliteStore } from '@runnets/store-sqlite';
import { desktopRootIdentity, type LocalRuntimeClient } from '@runnets/tools-node';
import { DesktopAttachmentClient, connectLocalRuntime } from '@runnets/tools-node';
import { startLocalRuntime, type LocalRuntimeHost } from './host.js';
import { backupProfile, restoreProfile } from '../ocean/snapshots.js';
import {
  attachmentId,
  codingDesktopFixture,
  decoyBytes,
  desktopBytes,
  hash,
  prepareRequest,
  startedRequest,
} from '../ocean/desktop-workflow-fixture.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function stop(host: LocalRuntimeHost | undefined) {
  if (!host) return;
  const stopped = await host.stop();
  if (stopped.outcome === 'complete') await host.closed;
}
it('rebinds source-deleted Desktop storage to the verified new profile without reviving the old operation', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'desktop-rebind-')),
    home = join(root, 'home'),
    run = join(root, 'run');
  for (const dir of [home, run]) fs.mkdirSync(dir, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_RUNTIME_DIR', run);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await codingDesktopFixture();
  const boot = await desktopBootSimulation();
  cleanups.push(() => f.close());
  const selected = join(root, 'selected');
  execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', f.project, selected], {
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  let host: LocalRuntimeHost | undefined;
  const clients: LocalRuntimeClient[] = [];
  cleanups.push(async () => {
    for (const c of clients) c.close();
    await stop(host);
  });
  const archive = join(root, 'archive');
  const first = await backupProfile(f.directory, archive, {
    managedDirectory: join(f.directory, 'worktrees'),
  });
  expect(first.format).toBe(2);
  const archived = readDesktopBackupInventory(join(f.directory, 'runtime.sqlite'));
  expect(archived.binding).toEqual(f.binding);
  expect(archived.operations.filter((o) => o.state === 'started')).toEqual([
    expect.objectContaining({ id: 'prepare:' + f.room + ':' + startedRequest }),
  ]);
  // Source deletion: profile, worktrees, Desktop binding root and the original userData path all vanish.
  fs.rmSync(f.directory, { recursive: true, force: true });
  const profile = join(root, 'profile');
  restoreProfile(archive, profile);
  fs.rmSync(archive, { recursive: true });
  const oldOriginalRoot = f.binding['originalRoot']!;
  // A decoy at the old absolute provenance path proves it is never consulted as storage authority.
  fs.mkdirSync(join(f.desktop, f.room, attachmentId), { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(f.desktop, f.room, attachmentId, 'blob'), decoyBytes, { mode: 0o600 });
  host = await startLocalRuntime({ profile, restore: true, provider: null });
  const a = await connectLocalRuntime({ profile }),
    b = await connectLocalRuntime({ profile });
  clients.push(a, b);
  const inspection = await a.inspectRestore({
    requestId: 'desktop-rebind',
    workspaceId: 'ws_ocean',
    roomId: f.room,
    taskId: f.task.id,
    projectRoot: selected,
    policy: f.task.policy,
  });
  expect(inspection.holds).toEqual(
    expect.arrayContaining([
      {
        id: 'prepare:' + f.room + ':' + startedRequest,
        kind: 'desktop',
        outcome: 'started',
        scope: 'operation',
      },
    ]),
  );
  const card = await a.previewRestore(inspection.selection);
  const preview = JSON.parse(
    await b.decisionPreview({
      workspaceId: card.workspaceId,
      roomId: card.roomId,
      runId: card.runId,
      decisionId: card.decisionId,
    }),
  ) as {
    epochId: string;
    origin: { profileId: string };
    plan: {
      desktop: {
        profileId: string;
        epochId: string;
        root: string;
        archiveHash: string;
        identity: string | null;
      } | null;
    };
  };
  const planned = preview.plan.desktop!;
  expect(planned).toMatchObject({
    profileId: preview.origin.profileId,
    epochId: preview.epochId,
    root: join(profile, 'desktop-' + preview.epochId, 'tree'),
    identity: null,
  });
  expect(planned.archiveHash).toMatch(/^[a-f0-9]{64}$/);
  expect(planned.root).not.toBe(f.desktop);
  expect(fs.existsSync(planned.root)).toBe(false);
  const serialized = JSON.stringify(preview);
  expect(serialized.includes(f.desktop)).toBe(false);
  expect(serialized.includes(oldOriginalRoot)).toBe(false);
  await b.resolveDecision({
    workspaceId: card.workspaceId,
    roomId: card.roomId,
    runId: card.runId,
    decisionId: card.decisionId,
    bindingDigest: card.bindingDigest,
    choice: 'allow-once',
    expectedVersion: card.version,
  });
  let result = await a.restoreResult(inspection.selection);
  const deadline = Date.now() + 30000;
  while (!['ready', 'held', 'refused'].includes(result.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await a.restoreResult(inspection.selection);
  }
  expect(result.state, result.reason ?? '').toBe('ready');
  await stop(host);
  host = undefined;
  boot.reboot();
  host = await startLocalRuntime({ profile, provider: null });
  const c = await connectLocalRuntime({ profile });
  clients.push(c);
  const media = new DesktopAttachmentClient(c);
  const read = await media.read(f.room, attachmentId);
  expect(read.data.equals(desktopBytes)).toBe(true);
  expect(read.data.equals(decoyBytes)).toBe(false);
  await expect(
    media.prepare(f.room, startedRequest, 'unknown outcome caption', null, [attachmentId]),
  ).rejects.toThrow('desktop_outcome_unknown');
  await expect(
    c.submit({
      workspaceId: 'ws_ocean',
      roomId: f.room,
      requestId: startedRequest,
      text: 'attempted replay',
    }),
  ).rejects.toThrow('desktop_outcome_unknown');
  await stop(host);
  host = undefined;
  const saved = readDesktopBackupInventory(join(profile, 'runtime.sqlite'));
  expect(saved.binding).toMatchObject({
    profileId: hash(profile),
    root: planned.root,
    originalRoot: oldOriginalRoot,
  });
  expect(saved.binding!.identity).not.toBe(desktopRootIdentity(planned.root));
  expect(saved.binding!.identity).toMatch(/^linux-btrfs-v1:/);
  expect(saved.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'prepare:' + f.room + ':' + startedRequest,
        state: 'started',
        result: null,
      }),
      expect.objectContaining({
        id: 'prepare:' + f.room + ':' + prepareRequest,
        state: 'completed',
      }),
      expect.objectContaining({ id: 'enrollment', state: 'completed' }),
    ]),
  );
  expect(saved.operations.filter((o) => o.state === 'started')).toHaveLength(1);
  // The decoy provenance path stays untouched and no archived absolute path became authority.
  expect(fs.readFileSync(join(f.desktop, f.room, attachmentId, 'blob')).equals(decoyBytes)).toBe(
    true,
  );
  expect(fs.existsSync(join(profile, 'restore-guard.json'))).toBe(true);
  const firstStore = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
  const readyRecord = structuredClone(firstStore.rebind.active()!);
  firstStore.close();
  const selected2 = join(root, 'selected-2');
  execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', selected, selected2], {
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  const successorArchive = join(root, 'successor-archive');
  await backupProfile(profile, successorArchive);
  fs.rmSync(profile, { recursive: true });
  const successor = join(root, 'successor');
  restoreProfile(successorArchive, successor);
  fs.rmSync(successorArchive, { recursive: true });
  host = await startLocalRuntime({ profile: successor, restore: true, provider: null });
  const d = await connectLocalRuntime({ profile: successor });
  clients.push(d);
  const nextInspection = await d.inspectRestore({
    requestId: 'successor-rebind',
    workspaceId: 'ws_ocean',
    roomId: f.room,
    taskId: f.task.id,
    projectRoot: selected2,
    policy: f.task.policy,
  });
  const nextCard = await d.previewRestore(nextInspection.selection);
  await d.resolveDecision({
    workspaceId: nextCard.workspaceId,
    roomId: nextCard.roomId,
    runId: nextCard.runId,
    decisionId: nextCard.decisionId,
    bindingDigest: nextCard.bindingDigest,
    choice: 'allow-once',
    expectedVersion: nextCard.version,
  });
  let next = await d.restoreResult(nextInspection.selection);
  const until = Date.now() + 30000;
  while (!['ready', 'held', 'refused'].includes(next.state) && Date.now() < until) {
    await new Promise((done) => setTimeout(done, 20));
    next = await d.restoreResult(nextInspection.selection);
  }
  expect(next.state, next.reason ?? '').toBe('ready');
  await stop(host);
  host = undefined;
  boot.reboot();
  host = await startLocalRuntime({ profile: successor, provider: null });
  const e = await connectLocalRuntime({ profile: successor });
  clients.push(e);
  expect((await new DesktopAttachmentClient(e).read(f.room, attachmentId)).data).toEqual(
    desktopBytes,
  );
  await stop(host);
  host = undefined;
  const successorStore = openSqliteStore({ path: join(successor, 'runtime.sqlite') });
  expect(successorStore.rebind.atomic((tx) => tx.record(readyRecord.requestId))).toEqual(
    readyRecord,
  );
  successorStore.close();
  await backupProfile(successor, join(root, 'third-archive'));
}, 240000);
