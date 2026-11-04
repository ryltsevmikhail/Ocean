import { describe, expect, it } from 'vitest';
import { SHIPPED_PLUGIN_CATALOG } from '@runnets/domain';
import { serviceFixture } from '../test-fixtures/plugin-service.js';

const entry = SHIPPED_PLUGIN_CATALOG.entries[0]!;

describe('plugin catalog repair', () => {
  it('repairs a corrupt installed copy and re-verifies it disabled', () => {
    const fixture = serviceFixture();
    fixture.catalog.install({ pluginId: 'github' });
    fixture.state.corruptInstalled('github', entry.version);
    expect(() => fixture.catalog.enable({ pluginId: 'github' })).toThrow('install_corrupt');
    expect(fixture.catalog.inspect('github').installState).toBe('corrupt');
    const repaired = fixture.catalog.repair({ pluginId: 'github' });
    expect(repaired.state).toBe('installed');
    expect(repaired.verified).toBe(true);
    expect(repaired.enabled).toBe(false);
    expect(fixture.catalog.inspect('github').fileVerified).toBe(true);
    expect(fixture.catalog.enable({ pluginId: 'github' }).installed.enabled).toBe(true);
  });

  it('retries an interrupted install through repair and refuses repair of a verified version', () => {
    const fixture = serviceFixture();
    fixture.catalog.install({ pluginId: 'github' });
    fixture.state.catalog.setState('github', entry.version, 'interrupted');
    const repaired = fixture.catalog.repair({ pluginId: 'github' });
    expect(repaired.state).toBe('installed');
    expect(repaired.verified).toBe(true);
    expect(() => fixture.catalog.repair({ pluginId: 'github' })).toThrow('already_installed');
    expect(() => fixture.catalog.repair({ pluginId: 'missing' })).toThrow('unknown_plugin');
  });
});
