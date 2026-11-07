import type { LocalModelConnectionMetadata } from '@runnets/contracts';
export const metadata = (connectionId = 'a'): LocalModelConnectionMetadata => ({
  connectionId,
  providerId: 'ollama',
  kind: 'local',
  endpoint: 'http://127.0.0.1:11434',
  auth: 'none',
  defaultModelId: 'qwen3:1.7b',
  revision: 1,
  configuration: {
    intent: 'active',
    savedKeyReferencePresent: false,
    configuredAfterRestore: true,
  },
  models: [],
  lastCheck: null,
  localQualification: null,
  recovery: null,
  writable: true,
  restriction: null,
});
export const page = (items: readonly LocalModelConnectionMetadata[]) => ({
  version: 1,
  workspaceId: 'ws_ocean',
  items,
  nextAfter: null,
});
export const pendingRemove = (id: string, requestId: string): LocalModelConnectionMetadata => ({
  ...metadata(id),
  revision: 2,
  configuration: {
    intent: 'pending',
    savedKeyReferencePresent: true,
    configuredAfterRestore: true,
  },
  recovery: {
    kind: 'retry_available',
    pendingRevision: 2,
    request: {
      version: 1,
      operation: {
        method: 'modelConnections.removeSavedKey',
        input: { connectionId: id, requestId, expectedRevision: 1 },
      },
    },
    requiresKeyResupply: false,
  },
});
