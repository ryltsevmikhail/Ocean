import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { stageWorkspace } from './artifact-workspace.mjs';

test('standalone Desktop can load the settings dispatch and offer public model presets', async () => {
  const stage = mkdtempSync(join(tmpdir(), 'ocean-desktop-stage-'));
  try {
    stageWorkspace(stage);
    writeFileSync(join(stage, 'package.json'), '{"type":"module"}');
    cpSync('apps/desktop/dist/types/host/model-settings-client.js', join(stage, 'settings.js'));
    const { dispatchModelSettings } = await import(pathToFileURL(join(stage, 'settings.js')));
    const presets = dispatchModelSettings(
      { identity: { capabilities: ['model.connections-v1'] } },
      { op: 'model-presets' },
    );
    assert.deepEqual(
      presets.map((x) => x.providerId),
      ['deepseek', 'openai', 'anthropic', 'ollama'],
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
