import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openModelNativeSession, saveProof } from './model-native-session.mjs';
import { inspectExports } from './model-handoff-assets.mjs';
const button = (page, name) => page.getByRole('button', { name, exact: true });
export async function restartHandoff(inputs, root, fixture, evidence, priorInstanceId) {
  let resumed, original;
  try {
    resumed = await openModelNativeSession({
      ...inputs,
      root: root + '-restart',
      resumeProfile: fixture.profile,
    });
    await resumed.runCase(async (step) => {
      const { page, peer: current } = resumed;
      const history = await step(() => current.history(evidence.scope));
      assert.deepEqual(history, evidence.history);
      const status = await step(() => current.status());
      assert.notEqual(status.instanceId, priorInstanceId);
      await step(() => button(page, '@bot001').click());
      for (const text of [
        'Synthetic handoff: held-gui',
        'Synthetic handoff: held-tui',
        'Synthetic handoff: lost-chat-reply',
      ])
        await step(() => page.locator('#history').getByText(text, { exact: true }).waitFor());
      await step(() => button(page, 'Handoff files').click());
      await step(() =>
        page.locator('#history').getByText('attachment note', { exact: true }).waitFor(),
      );
      await inspectExports(resumed, step, { history: true, label: 'restarted-originals' });
      await step(() => page.screenshot({ path: join(root + '-restart', 'restarted-history.png') }));
      const replay = await step(() =>
        current.submit({
          ...evidence.scope,
          requestId: evidence.lost.requestId,
          text: 'lost-chat-reply',
        }),
      );
      assert.deepEqual(replay, evidence.lost);
      const execution = await step(() =>
        current.getRunModelExecution({ ...evidence.scope, runId: replay.runId }),
      );
      assert.equal(execution.execution.startedRequests, 1);
      assert.equal(existsSync(join(root + '-restart', 'provider.jsonl')), false);
      saveProof(root + '-restart', 'restart.json', {
        status,
        history,
        replay,
        execution,
        originalProfile: fixture.profile,
        providerDispatchesAfterRestart: 0,
        preservedWorkspaceId: evidence.scope.workspaceId,
        originalWorkspacePath: join(fixture.root, 'workspace'),
      });
    });
  } catch (error) {
    original = error;
    throw error;
  } finally {
    await resumed?.dispose(original);
  }
}
