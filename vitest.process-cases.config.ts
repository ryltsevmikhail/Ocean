/** These qualifications launch the built normal entry point or a built-package child. */
export const processCases = [
  'apps/cli/src/local-runtime/*process*.test.ts',
  'apps/cli/src/local-runtime/restart-refusals.test.ts',
  'apps/cli/src/local-runtime/decision-{admission,persistence,review-conflicts,crash}.test.ts',
  'apps/cli/src/local-runtime/*native.test.ts',
  'apps/cli/src/ocean/remote-{command-process,send-signal,review-process,offline-boundary,shutdown-native,hello-refusal,coding-process}.test.ts',
  'apps/cli/src/ocean/coding-worktree-process-recovery.test.ts',
  'apps/cli/src/ocean/coding-capture-crash.test.ts',
  'apps/cli/src/ocean/coding-test-persist-crash.test.ts',
  'apps/cli/src/ocean/coding-test-spawn-crash.test.ts',
  'apps/cli/src/ocean/room-tui-{process,coding-native}.test.ts',
  'packages/tools-node/src/coding-asset{,-restore}-native.test.ts',
  'packages/tools-node/src/coding-dependency-native.test.ts',
  'packages/tools-node/src/desktop-assets-native.test.ts',
  'packages/tools-node/src/local-runtime-types.test.ts',
  'apps/cli/src/release/{bundle,mcp-bundle,package,installed}.test.ts',
];
