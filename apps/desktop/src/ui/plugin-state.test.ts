import { describe, expect, it } from 'vitest';
import { invalidatePluginPreview, pluginPreview } from './plugin-state.js';

describe('desktop plugin grant preview freshness', () => {
  it('invalidates a stored preview when grant inputs change', () => {
    pluginPreview.value = {
      allowed: true,
      refusal: null,
      explanation: 'stale explanation',
      groupVisibility: false,
      participants: 0,
      scope: null,
    };
    invalidatePluginPreview();
    expect(pluginPreview.value).toBeNull();
  });
});
