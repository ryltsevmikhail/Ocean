import { randomUUID } from 'node:crypto';
import {
  CodingTaskService,
  CodingApprovalService,
  CodingChangesetService,
  ConversationService,
  DirectChatService,
  ChatReviewService,
} from '@runnets/application';
import {
  InMemoryCommandDedup,
  InMemoryCodingStore,
  InMemoryCodingApprovalStore,
  InMemoryProjectLeases,
  InMemoryConversationStore,
  InMemoryToolJournal,
  InMemoryEventLog,
  systemClock,
} from '@runnets/store';
import { GitCodingProject, GitCodingWorktrees, GitCodingSnapshots } from '@runnets/tools-node';
import { runtimeServiceOver as serviceOver } from './runtime-service.js';
import type { Runtime, RuntimeOptions } from './runtime.js';
/** Ephemeral host: no durable authority and coding remains disabled. */
export function createEphemeralRuntime(options: RuntimeOptions): Runtime {
  const service = serviceOver(
    new InMemoryEventLog(),
    new InMemoryCommandDedup(),
    false,
    options.clock,
  );
  const journal = new InMemoryToolJournal();
  const deps = {
    store: new InMemoryConversationStore(),
    clock: options.clock ?? systemClock,
    nextId: () => randomUUID().replaceAll('-', ''),
  };
  const codingDeps = {
    store: new InMemoryCodingStore(deps.store),
    leases: new InMemoryProjectLeases(),
    projects: new GitCodingProject(),
    journal,
    ownerId: 'ephemeral-' + randomUUID(),
    enabled: false,
    clock: deps.clock,
  };
  return {
    ownerDecisions: deps.store.ownerDecisions,
    service,
    coding: new CodingTaskService(codingDeps),
    codingApprovals: new CodingApprovalService({
      store: new InMemoryCodingApprovalStore(),
      now: () => deps.clock.now().getTime(),
      admit: () => false,
      restored: false,
    }),
    codingChanges: new CodingChangesetService({
      ...codingDeps,
      worktrees: new GitCodingWorktrees(options.codingWorktreeDirectory),
      snapshots: new GitCodingSnapshots(),
    }),
    conversations: new ConversationService(deps),
    chat: new DirectChatService({ ...deps, tasks: service }),
    reviews: new ChatReviewService({ ...deps, tasks: service, journal }),
    durable: false,
    toolJournal: journal,
    ready: Promise.resolve({ tasks: [], effects: [] }),
    close: () => {},
  };
}
