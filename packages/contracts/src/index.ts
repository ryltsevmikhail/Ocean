/**
 * @runnets/contracts — versioned wire contracts for out-of-process clients.
 *
 * Nothing in this package may depend on the runtime internals: it is the
 * boundary an external desktop client compiles against.
 */

export * from './jsonrpc.js';
export * from './acp.js';
export * from './local-runtime.js';
export * from './local-runtime-turns.js';
export * from './local-runtime-queries.js';
export * from './local-runtime-decisions.js';
export * from './local-coding-panel.js';
export * from './local-profile.js';
export * from './local-coding-views.js';
export * from './local-desktop-assets.js';
export * from './local-restore.js';
export * from './local-finalization.js';
export * from './local-provider.js';
export * from './local-broadcast.js';
export * from './local-plugins.js';
export * from './local-plugins-validate.js';
export * from './local-plugins-validate-grants.js';
export * from './local-model-connections.js';
export {
  isLocalModelConnectionsQuery,
  isLocalModelConnectionQuery,
  isLocalModelConnectionSetRequest,
  isLocalModelConnectionRevisionRequest,
  isLocalModelCheckMetadata,
  isLocalModelConnectionStatus,
  isLocalModelConnectionCheckResponse,
} from './local-model-connections-validate.js';
export * from './local-model-metadata-validate.js';
export * from './local-model-bindings-validate.js';
export * from './local-model-execution.js';
export * from './local-model-execution-validate.js';

export * from './local-services.js';
export * from './local-service-views.js';

export * from './local-runtime-room-tasks.js';
export * from './local-runtime-projects.js';

export * from './local-project-reserve.js';
export * from './local-project-prepare.js';
