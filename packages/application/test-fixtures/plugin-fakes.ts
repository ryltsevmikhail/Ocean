/**
 * One shared in-memory plugin state plus a deterministic transport fake.
 *
 * The state object is intentionally mutable test scaffolding: it exposes the
 * exact maps and counters a test needs to prove zero-request denials, grant
 * revocation and restart recovery without a real network or SQLite.
 */
import { versionKey, clone, pluginFakeMaps } from './plugin-fake-state.js';
import { fakeCatalogStore, fakeConnectionStore, fakeInstallFiles } from './plugin-store-fakes.js';
import { fakeAccessStore, fakeAdmissionStore, fakeCredentials } from './plugin-authority-fakes.js';

export { pluginFixtureState } from './plugin-fixture-state.js';
export { fakePluginTransport, tools } from './plugin-transport-fakes.js';
export type { FakeTransport } from './plugin-transport-fakes.js';
export type { PluginFixtureState } from './plugin-fixture-state.js';
export {
  clone,
  versionKey,
  pluginFakeMaps,
  fakeCatalogStore,
  fakeConnectionStore,
  fakeInstallFiles,
  fakeAccessStore,
  fakeAdmissionStore,
  fakeCredentials,
};
export type { PluginFakeMaps, MockGrantConfirmation } from './plugin-fake-state.js';
