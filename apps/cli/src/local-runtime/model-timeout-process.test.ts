import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runModelScenario, processExists } from '../../test-fixtures/model-process-launch.js';
it('reaps the active CLI listener and SDK child and removes the parent-owned root on a controlled timeout', async () => {
  const result = await runModelScenario('timeout', { timeoutMs: 100, afterReady: true });
  expect(result.timedOut).toBe(true);
  expect(result.liveAtReady).toBe(true);
  expect(result.ready?.pids).toHaveLength(2);
  expect(result.ready!.pids.every((pid) => !processExists(pid))).toBe(true);
  expect(processExists(result.pid)).toBe(false);
  expect(result.groupGone).toBe(true);
  expect(existsSync(result.ready!.endpoint)).toBe(false);
  expect(existsSync(result.root)).toBe(false);
  console.log(
    JSON.stringify({
      scenario: 'timeout',
      activeListenerBeforeTimeout: result.liveAtReady,
      descendantsReaped: result.ready!.pids.length,
      groupGone: result.groupGone,
      rootRemoved: !existsSync(result.root),
    }),
  );
}, 15000);
