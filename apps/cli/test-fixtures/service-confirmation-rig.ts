import { vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { ProviderPort } from '@runnets/application';
import type { ServiceConnection } from '@runnets/domain';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import { serviceOwnerPeer } from './service-owner-peer.js';
import type { PrivateRoot } from './local-provider-host.test.js';

export function confirmedProvider(onRequest: () => void = () => {}) {
  const facts = { requests: 0, results: [] as string[], answers: 0 };
  const provider: ProviderPort = {
    id: 'deepseek',
    models: ['deepseek-flash'],
    capabilities: { streaming: true, reasoning: false, usage: false, toolCalls: true },
    async *stream(request) {
      facts.requests++;
      onRequest();
      const tool = request.messages.at(-1);
      if (tool?.role === 'tool') {
        const text = String(tool.content);
        facts.results.push(text);
        const value = JSON.parse(text) as { structuredContent?: { version?: string } };
        if (value.structuredContent?.version !== 'alpha') throw Error('actual result missing');
        facts.answers++;
        yield { type: 'text_delta', text: 'verified alpha' };
        yield { type: 'completed', stopReason: 'stop', rawStopReason: 'scripted' };
      } else {
        if (!request.tools?.[0]) throw Error('service tool missing');
        yield {
          type: 'tool_call',
          call: {
            id: 'same-model-id',
            name: request.tools[0].name,
            arguments: JSON.stringify({ value: 'alpha', echo: '\u202e' + 'x'.repeat(40000) }),
          },
        };
        yield { type: 'completed', stopReason: 'tool_calls', rawStopReason: 'scripted' };
      }
    },
  };
  return { provider, facts };
}
export async function configureService(
  f: Pick<PrivateRoot, 'profile' | 'roomId' | 'botId'>,
  url: string,
  mode: 'autonomous' | 'confirm',
) {
  const peer = await serviceOwnerPeer(f.profile);
  try {
    const saved = (await peer.request('service.connection-set', {
      requestId: 'set',
      connectionId: 'test',
      expectedVersions: null,
      name: 'Synthetic',
      configuration: { kind: 'http', url },
      metadataPermission: 'allow',
    })) as { result: ServiceConnection };
    const fresh = (await peer.request('service.connection-refresh', {
      requestId: 'refresh',
      connectionId: 'test',
      expectedVersions: {
        configRevision: saved.result.configRevision,
        trustRevision: saved.result.trustRevision,
        credentialRevision: saved.result.credentialRevision,
      },
    })) as { result: ServiceConnection };
    await peer.request('service.grant-set', {
      requestId: 'grant',
      expectedRevision: null,
      intent: {
        id: 'grant',
        mode,
        subject: {
          workspaceId: 'ws_ocean',
          roomId: f.roomId,
          botId: f.botId,
          projectId: null,
          taskId: null,
        },
        permissions: [
          {
            kind: 'service',
            connectionId: 'test',
            trustRevision: fresh.result.trustRevision,
            tools: { kind: 'exact', names: ['write'] },
            resources: [{ kind: 'connection', connectionId: 'test' }],
          },
        ],
        limits: { maxCalls: 3, maxEffectBytes: 65536, expiresAt: null },
      },
    });
    return fresh.result;
  } finally {
    peer.close();
  }
}
export async function pendingService(client: LocalRuntimeClient, f: PrivateRoot) {
  return vi.waitFor(
    async () => {
      const card = (await client.listDecisions({ workspaceId: 'ws_ocean', roomId: f.roomId }))[0];
      if (!card || card.status !== 'pending') throw Error('waiting for service confirmation');
      return card;
    },
    { timeout: 1500, interval: 10 },
  );
}
export function journal(profile: string) {
  const db = new DatabaseSync(join(profile, 'runtime.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM tool_invocations_v2').all();
  } finally {
    db.close();
  }
}
