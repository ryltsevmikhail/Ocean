import { rolldown } from 'rolldown';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { serviceOwnerPeer } from './service-owner-peer.js';
import type { RoomTaskStart } from '@runnets/contracts';
import type { ServiceConnection, OwnerPermission } from '@runnets/domain';
export interface ManagedSetup {
  profile: string;
  root: string;
  input: RoomTaskStart;
  bRoom: string;
}
export async function managedNativeFixture() {
  const proof = mkdtempSync('/home/ryltsevmg/Projects/Ocean-artifacts/task-19.3/native-');
  const artifact = join(proof, 'server.mjs');
  const bundle = await rolldown({
    input: fileURLToPath(
      new URL(
        '../../../packages/integrations-mcp/test-fixtures/managed-workspace-server.ts',
        import.meta.url,
      ),
    ),
    platform: 'node',
  });
  try {
    await bundle.write({ file: artifact, format: 'esm', codeSplitting: false });
  } finally {
    await bundle.close();
  }
  const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  writeFileSync(
    join(proof, 'fixture-manifest.json'),
    JSON.stringify(
      {
        artifact,
        digest,
        utc: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
      },
      null,
      2,
    ),
  );
  const workspace = (name: string, mode = 'normal') => {
    const root = join(proof, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'fixture.json'), JSON.stringify({ mode }));
    return root;
  };
  return { proof, artifact, digest, workspace };
}
export function nativeJournal(profile: string) {
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
  try {
    return db
      .prepare('SELECT * FROM tool_invocations_v2 ORDER BY rowid')
      .all()
      .map((r) => ({
        id: String(r['id']),
        task_run_id: String(r['task_run_id']),
        attempt_id: String(r['attempt_id']),
        tool: String(r['tool']),
        fingerprint: String(r['fingerprint']),
        outcome: String(r['outcome']),
        admission: r['admission']
          ? (JSON.parse(String(r['admission'])) as Record<string, unknown>)
          : null,
      }));
  } finally {
    db.close();
  }
}
export const counter = (root: string, name: string) =>
  existsSync(join(root, name))
    ? readFileSync(join(root, name), 'utf8').trim().split('\n').length
    : 0;
export async function enrollManaged(
  setup: ManagedSetup,
  fixture: Awaited<ReturnType<typeof managedNativeFixture>>,
  id: string,
  root: string,
) {
  const peer = await serviceOwnerPeer(setup.profile);
  try {
    const saved = (await peer.request('service.connection-set', {
      requestId: 'set-' + id,
      connectionId: id,
      expectedVersions: null,
      name: id,
      configuration: {
        kind: 'stdio',
        executable: fixture.artifact,
        sha256: fixture.digest,
        args: [],
        workspaceRoot: root,
      },
      metadataPermission: 'allow',
    })) as { result: ServiceConnection };
    return await peer.request('service.connection-refresh', {
      requestId: 'refresh-' + id,
      connectionId: id,
      expectedVersions: {
        configRevision: saved.result.configRevision,
        trustRevision: saved.result.trustRevision,
        credentialRevision: saved.result.credentialRevision,
      },
    });
  } finally {
    peer.close();
  }
}
export async function grantManaged(
  setup: ManagedSetup,
  id: string,
  roomId = setup.input.roomId,
): Promise<RoomTaskStart> {
  const peer = await serviceOwnerPeer(setup.profile);
  try {
    const connections = (await peer.request('service.connections', {})) as ServiceConnection[];
    const c = connections.find((r) => r.id === id)!;
    const permissions: OwnerPermission[] = [
      {
        kind: 'service',
        connectionId: id,
        trustRevision: c.trustRevision,
        baselineCatalogId: c.currentCatalogId!,
        tools: { kind: 'exact', names: ['write'] },
        resources: [{ kind: 'connection', connectionId: id }],
      },
    ];
    await peer.request('service.grant-set', {
      requestId: 'grant-' + id,
      expectedRevision: null,
      intent: {
        id: 'grant-' + id,
        mode: 'autonomous',
        subject: {
          workspaceId: 'ws_ocean',
          roomId,
          botId: setup.input.initialBotIds[0],
          projectId: null,
          taskId: null,
        },
        permissions,
        limits: { maxCalls: 16, maxEffectBytes: 65536, expiresAt: null },
      },
    });
    return {
      ...setup.input,
      roomId,
      requestId: 'start-' + id,
      participants: setup.input.participants.map((p) => ({
        ...p,
        grantReferences:
          p.botId === setup.input.initialBotIds[0] ? [{ grantId: 'grant-' + id, revision: 1 }] : [],
      })),
      mandate: { ...setup.input.mandate, permissions },
    };
  } finally {
    peer.close();
  }
}
export async function observeManaged(profile: string, proof: string, label: string, id: string) {
  const { inspect } =
    await import('../../../packages/integrations-mcp/test-fixtures/native-observation.ts');
  const row = nativeJournal(profile).find(
    (r) =>
      r['outcome'] === 'started' &&
      r['task_run_id'] === '\0managed-stdio/v1' &&
      (r.admission?.['binding'] as Record<string, unknown> | undefined)?.['connectionId'] === id,
  );
  if (!row) throw Error('started native lifetime missing');
  const life = (row.admission!['binding'] as Record<string, unknown>)['managedLifetime'] as {
    unit: string;
    cgroup: string;
  };
  const observed = { row, unit: life.unit, ...inspect(life.cgroup) };
  writeFileSync(join(proof, label + '-observed.json'), JSON.stringify(observed, null, 2));
  return observed;
}
export async function managedRetired(
  observed: Awaited<ReturnType<typeof observeManaged>>,
  proof: string,
  label: string,
) {
  const { retiredGroup } = await import('../../../packages/tools-node/src/sandbox-cgroup.ts');
  const { recordedPidRetired } = await import('./mcp-native-observation.ts');
  const empty = await retiredGroup(observed.cg);
  const pidsGone = observed.pids.every(
    ({ pid, start }) => !!start && recordedPidRetired(pid, start),
  );
  writeFileSync(
    join(proof, label + '-retired.json'),
    JSON.stringify({ unit: observed.unit, cgroup: observed.cg, empty, pidsGone }),
  );
  return empty && pidsGone;
}
export async function recordManagedCleanup(profile: string, proof: string) {
  const { retiredGroup } = await import('../../../packages/tools-node/src/sandbox-cgroup.ts');
  const rows = nativeJournal(profile);
  const groups = rows.flatMap((row) => {
    const life = (row.admission?.['binding'] as Record<string, unknown> | undefined)?.[
      'managedLifetime'
    ] as { unit: string; cgroup: string } | undefined;
    return life ? [life] : [];
  });
  const evidence = [];
  for (const life of groups)
    evidence.push({
      unit: life.unit,
      cgroup: life.cgroup,
      retired: await retiredGroup(life.cgroup),
    });
  writeFileSync(
    join(proof, 'cleanup.json'),
    JSON.stringify(
      {
        profileRemovedAfterEvidence: profile,
        groups: evidence,
        allRetired: evidence.every((v) => v.retired),
      },
      null,
      2,
    ),
  );
  writeFileSync(join(proof, 'closed-journal.json'), JSON.stringify(rows, null, 2));
  if (!evidence.every((v) => v.retired)) throw Error('exact managed unit retirement unconfirmed');
}
