import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';
import { ConversationService } from '@runnets/application';
import { openSqliteStore, type SqliteStore } from '@runnets/store-sqlite';

export const roots: string[] = [];
export const stores: SqliteStore[] = [];
export function cleanupFixture(): void {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
export const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const PINNED = {
  adapter: 'runnets-executor',
  protocolVersion: 1,
  sdkVersion: '1.6.11',
  manifestSchemaVersion: 1,
} as const;
export const canary = 'CANARY_GITHUB_PAT_9f4d2c';
export const credentialReference = 'OCEAN_GITHUB_WORK_TOKEN';
export const env: Record<string, string | undefined> = { [credentialReference]: canary };

export function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ocean-plugin-backup-'));
  roots.push(directory);
  return directory;
}
export function profileAt(directory: string, name = 'profile'): string {
  const profile = join(directory, name);
  mkdirSync(profile, { mode: 0o700 });
  return profile;
}
export function open(profile: string): SqliteStore {
  const store = openSqliteStore({ path: join(profile, 'runtime.sqlite') });
  stores.push(store);
  return store;
}
export function close(store: SqliteStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}
export function initializeProfile(profile: string): void {
  close(open(profile));
  chmodSync(join(profile, 'runtime.sqlite'), 0o600);
}
export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function tools() {
  return [
    { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } },
    { name: 'issue_read', description: 'Read issue', inputSchema: { type: 'object' } },
  ];
}
export function seedConversation(store: SqliteStore): { roomId: string; botId: string } {
  let ids = 0;
  const service = new ConversationService({
    store: store.conversations,
    clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    nextId: () => 'seed' + String(++ids),
  });
  const bound = service.execute({
    requestId: 'workspace-1',
    workspaceId: 'ws_ocean',
    type: 'BindWorkspace',
    root: '/project',
  });
  if (!bound.ok) throw Error('workspace_seed_failed');
  const dev = service.execute({
    requestId: 'bot-dev',
    workspaceId: 'ws_ocean',
    type: 'CreateBot',
    handle: 'dev',
    name: 'Dev',
    role: 'reviewer',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  const review = service.execute({
    requestId: 'bot-review',
    workspaceId: 'ws_ocean',
    type: 'CreateBot',
    handle: 'review',
    name: 'Review',
    role: 'reviewer',
    provider: 'deepseek',
    model: 'deepseek-flash',
  });
  if (!dev.ok || dev.value.kind !== 'bot' || !review.ok || review.value.kind !== 'bot')
    throw Error('bot_seed_failed');
  const room = service.execute({
    requestId: 'room-team',
    workspaceId: 'ws_ocean',
    type: 'CreateGroupRoom',
    title: 'Team',
    botIds: [dev.value.data.id, review.value.data.id],
  });
  if (!room.ok || room.value.kind !== 'room') throw Error('room_seed_failed');
  return { roomId: room.value.data.id, botId: dev.value.data.id };
}
