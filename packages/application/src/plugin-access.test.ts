import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceFixture } from '../test-fixtures/plugin-service.js';

function seedGroup(fixture: ReturnType<typeof serviceFixture>, title = 'Team') {
  fixture.state.members.add('ws_ocean|room_1|bot_dev');
  fixture.state.members.add('ws_ocean|room_1|bot_review');
  fixture.state.rooms.set('room_1', {
    id: 'room_1',
    kind: 'group',
    title,
    participantCount: 4,
  });
}
function seedDirect(fixture: ReturnType<typeof serviceFixture>) {
  fixture.state.members.add('ws_ocean|room_1|bot_dev');
  fixture.state.rooms.set('room_1', {
    id: 'room_1',
    kind: 'direct',
    title: null,
    participantCount: 2,
  });
}
const request = (connectionId: string, overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'ws_ocean',
  roomId: 'room_1',
  botId: 'bot_dev',
  pluginId: 'github',
  connectionId,
  tools: ['list_issues'],
  repository: 'team/api',
  acknowledgeGroupVisibility: true,
  ...overrides,
});

describe('plugin grant preview and visibility', () => {
  it('explains who sees the answer in a group chat before any grant', async () => {
    const fixture = serviceFixture();
    seedGroup(fixture);
    const connection = await fixture.readyWorkingConnection();
    const preview = fixture.access.preview(request(connection.id) as never);
    expect(preview.allowed).toBe(true);
    expect(preview.groupVisibility).toBe(true);
    expect(preview.participants).toBe(4);
    expect(preview.explanation).toContain('Everyone in the group chat "Team"');
    expect(preview.explanation).toContain('4 participant bots');
    expect(preview.explanation).toContain('team/api');
    expect(preview.explanation).toContain('work');
    expect(preview.explanation).toContain('bot_dev');
    expect(fixture.state.grants.size).toBe(0);
  });

  it('binds the exact connection generation, schema digest, tools, repository and policy', async () => {
    const fixture = serviceFixture();
    seedGroup(fixture);
    const connection = await fixture.readyWorkingConnection();
    const grant = fixture.access.grant(request(connection.id) as never);
    expect(grant.connectionGeneration).toBe(connection.generation);
    expect(grant.schemaDigest).toBe(connection.schemaDigest);
    expect(grant.tools).toEqual(['list_issues']);
    expect(grant.repository).toBe('team/api');
    expect(grant.policyVersion).toBe(1);
    expect(grant.state).toBe('active');
    expect(grant.visibility).toContain('Everyone in the group chat');
    expect(fixture.access.list({ roomId: 'room_1' })).toHaveLength(1);
  });

  it('requires the owner to acknowledge group visibility on the grant', async () => {
    const fixture = serviceFixture();
    seedGroup(fixture);
    const connection = await fixture.readyWorkingConnection();
    expect(() =>
      fixture.access.grant(request(connection.id, { acknowledgeGroupVisibility: false }) as never),
    ).toThrow('group_visibility_unacknowledged');
    expect(fixture.state.grants.size).toBe(0);
    expect(
      fixture.access.grant(request(connection.id, { acknowledgeGroupVisibility: true }) as never)
        .state,
    ).toBe('active');
  });

  it('does not require a group acknowledgement in a direct chat', async () => {
    const fixture = serviceFixture();
    seedDirect(fixture);
    const connection = await fixture.readyWorkingConnection();
    const grant = fixture.access.grant(
      request(connection.id, { acknowledgeGroupVisibility: false }) as never,
    );
    expect(grant.state).toBe('active');
    expect(grant.visibility).toContain('Only you see this answer');
  });
});

describe('exact grant refusals', () => {
  it('refuses a bot that is not a current room member', async () => {
    const fixture = serviceFixture();
    fixture.state.rooms.set('room_1', {
      id: 'room_1',
      kind: 'group',
      title: 'Team',
      participantCount: 3,
    });
    const connection = await fixture.readyWorkingConnection();
    const preview = fixture.access.preview(request(connection.id) as never);
    expect(preview.allowed).toBe(false);
    expect(preview.refusal).toBe('member_required');
    expect(() => fixture.access.grant(request(connection.id) as never)).toThrow('member_required');
    expect(fixture.state.grants.size).toBe(0);
  });

  it('refuses undeclared tools, invalid repositories and missing schema snapshots', async () => {
    const fixture = serviceFixture();
    seedGroup(fixture);
    const connection = await fixture.readyWorkingConnection();
    const undiscovered = fixture.connect({ name: 'second' });
    expect(() => fixture.access.grant(request(undiscovered.id) as never)).toThrow(
      'schema_unavailable',
    );
    expect(() =>
      fixture.access.grant(request(connection.id, { tools: ['create_issue'] }) as never),
    ).toThrow('unknown_tool');
    expect(() =>
      fixture.access.grant(request(connection.id, { repository: 'team' }) as never),
    ).toThrow('invalid_repository');
    expect(fixture.state.grants.size).toBe(0);
  });

  it('revokes previous active grants for the same bot when access is re-issued', async () => {
    const fixture = serviceFixture();
    seedGroup(fixture);
    const connection = await fixture.readyWorkingConnection();
    const first = fixture.access.grant(request(connection.id) as never);
    const second = fixture.access.grant(
      request(connection.id, { tools: ['list_issues', 'issue_read'] }) as never,
    );
    expect(first.id).not.toBe(second.id);
    const active = fixture.access.list().filter((grant) => grant.state === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.id);
    expect(fixture.access.list().find((grant) => grant.id === first.id)?.state).toBe('revoked');
  });

  it('revokes immediately, idempotently and never re-grants', async () => {
    const fixture = serviceFixture();
    seedGroup(fixture);
    const connection = await fixture.readyWorkingConnection();
    const grant = fixture.access.grant(request(connection.id) as never);
    expect(fixture.access.revoke(grant.id).state).toBe('revoked');
    expect(fixture.access.revoke(grant.id).state).toBe('revoked');
    expect(() => fixture.access.revoke('missing')).toThrow('grant_unknown');
    expect(fixture.state.grants.get(grant.id)?.state).toBe('revoked');
  });

  it('refuses owner mutations on a restored host', async () => {
    const fixture = serviceFixture({ mutationsAllowed: false });
    seedGroup(fixture);
    const connection = await fixture.readyWorkingConnection().catch(() => null);
    expect(connection).toBeNull();
    expect(() => fixture.access.grant(request('any') as never)).toThrow('restore_restricted');
  });
});

describe('no model-facing grant path', () => {
  const application = join(import.meta.dirname);
  const modelFacing = ['tools.ts', 'direct-chat.ts', 'coding-turn-tools.ts', 'tool-round.ts'];
  it('keeps grant composition out of every model-facing application module', () => {
    for (const file of modelFacing) {
      const source = readFileSync(join(application, file), 'utf8');
      expect(source).not.toContain('plugin-access');
      expect(source).not.toContain('PluginAccessService');
      expect(source).not.toContain('.grant(');
    }
    const transport = readFileSync(join(application, 'service-plugin-transport.ts'), 'utf8');
    expect(transport).not.toContain('PluginAccessService');
    expect(transport).not.toContain('grant(');
    const access = readFileSync(join(application, 'plugin-access.ts'), 'utf8');
    expect(access).toContain('no model-facing grant');
  });
});
