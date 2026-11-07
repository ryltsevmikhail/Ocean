import {
  ModelConnectionService,
  ModelConnectionMetadataService,
  BotModelBindingService,
  BotModelBindingReads,
  RoomModelPolicyService,
  RoomModelExecutionReads,
  type ModelConnectionServiceOptions,
  type ConversationStore,
  type TaskRunService,
} from '@runnets/application';
import { ModelSettings } from './model-settings.js';
/** Same canonical connection/store snapshots and factory as the admission resolver. */
export function modelSettingsHost(
  options: ModelConnectionServiceOptions,
  store: ConversationStore,
  tasks: TaskRunService,
) {
  return new ModelSettings(
    {
      connections: new ModelConnectionService(options),
      metadata: new ModelConnectionMetadataService({ ...options, conversations: store }),
      bindings: new BotModelBindingService({
        store,
        connections: options.store,
        factory: options.factory,
        nextId: options.nextId,
      }),
      bots: new BotModelBindingReads(store),
      policy: new RoomModelPolicyService({ store, connections: options.store }),
      execution: new RoomModelExecutionReads({ store, tasks }),
    },
    options.mutationsAllowed !== false,
  );
}
