import { beforeEach, describe, expect, it } from 'vitest';
import type { Bot } from '../protocol.js';
import { providerStatus } from './provider-state.js';
import { attachmentHint, modelImageInput } from './image-hints.js';

const BROADCAST = '\u0000broadcast';
function bot(handle: string, model: string): Bot {
  return {
    id: 'bot_' + handle,
    workspaceId: 'ws_ocean',
    handle,
    name: handle,
    role: 'fixture',
    provider: 'deepseek',
    model,
    profileVersion: 1,
  } as Bot;
}
const flash = bot('flash', 'deepseek-flash');
const pro = bot('pro', 'deepseek-v4-pro');
const image = { kind: 'image', name: 'diagram.png' };
const file = { kind: 'file', name: 'notes.md' };
const status = (modelCapabilities: readonly { model: string; imageInput: boolean }[]) =>
  ({ modelCapabilities }) as never;

describe('Desktop image capability hints', () => {
  beforeEach(() => {
    providerStatus.value = status([
      { model: 'deepseek-flash', imageInput: true },
      { model: 'deepseek-v4-pro', imageInput: false },
    ]);
  });

  it('reads per-model image input from the runtime-owned provider status', () => {
    expect(modelImageInput('deepseek-flash')).toBe(true);
    expect(modelImageInput('deepseek-v4-pro')).toBe(false);
    expect(modelImageInput('retired-model')).toBe(false);
    providerStatus.value = null;
    expect(modelImageInput('deepseek-flash')).toBe(false);
  });

  it('keeps the legacy text-attachment explanation free of marker internals', () => {
    const hint = attachmentHint({
      files: [file],
      members: [flash],
      group: false,
      recipient: '',
      broadcast: BROADCAST,
    });
    expect(hint).toContain('недоступно');
    expect(hint).not.toContain('Ocean Desktop attachments');
  });

  it('announces working image delivery for a capable direct-room bot', () => {
    const hint = attachmentHint({
      files: [image],
      members: [flash],
      group: false,
      recipient: '',
      broadcast: BROADCAST,
    });
    expect(hint).toContain('Изображения передаются модели');
    expect(hint).toContain('deepseek-flash');
    expect(hint).not.toContain('отклонена');
  });

  it('warns visibly that a text-only direct-room model will refuse the image', () => {
    const hint = attachmentHint({
      files: [image],
      members: [pro],
      group: false,
      recipient: '',
      broadcast: BROADCAST,
    });
    expect(hint).toContain('deepseek-v4-pro');
    expect(hint).toContain('не принимает изображения');
    expect(hint).toContain('отклонена');
  });

  it('shows mixed-capability broadcast targets honestly before sending', () => {
    const hint = attachmentHint({
      files: [image],
      members: [flash, pro],
      group: true,
      recipient: BROADCAST,
      broadcast: BROADCAST,
    });
    expect(hint).toContain('Изображения получат');
    expect(hint).toContain('@flash');
    expect(hint).toContain('не получат');
    expect(hint).toContain('@pro');
    expect(hint).toContain('deepseek-v4-pro');
  });

  it('targets only the selected recipient in a group room', () => {
    const hint = attachmentHint({
      files: [image],
      members: [flash, pro],
      group: true,
      recipient: 'pro',
      broadcast: BROADCAST,
    });
    expect(hint).toContain('@pro');
    expect(hint).not.toContain('@flash');
  });

  it('states that notes never send images to a model', () => {
    const hint = attachmentHint({
      files: [image],
      members: [flash, pro],
      group: true,
      recipient: '',
      broadcast: BROADCAST,
    });
    expect(hint).toContain('Заметка');
    expect(hint).toContain('не отправляются модели');
  });

  it('stays conservative when the provider status failed to load', () => {
    providerStatus.value = null;
    const hint = attachmentHint({
      files: [image],
      members: [flash],
      group: false,
      recipient: '',
      broadcast: BROADCAST,
    });
    expect(hint).toContain('не принимает изображения');
  });
});

it('does not diagnose a negotiated local binding using the legacy model list', async () => {
  const { modelSupport } = await import('./model-support.js');
  modelSupport.value = true;
  try {
    const line = attachmentHint({
      files: [{ kind: 'image', name: 'image' }],
      members: [
        {
          id: 'local',
          handle: 'local',
          name: 'Local',
          role: 'role',
          provider: 'ollama',
          model: 'qwen3:1.7b',
        },
      ],
      group: false,
      recipient: '',
      broadcast: 'all',
    });
    expect(line).toContain('не подтверждена');
    expect(line).not.toContain('не принимает');
  } finally {
    modelSupport.value = null;
  }
});
