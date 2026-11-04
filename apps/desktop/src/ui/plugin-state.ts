import { ref } from 'vue';
import { call } from './bridge.js';
import { explain } from './dom.js';
import type {
  PluginCatalogView,
  PluginConnectionView,
  PluginConsentPreview,
  PluginGrantPreview,
  PluginGrantView,
} from '../plugin-protocol.js';

/** Shared plugin settings state; one runtime owns the catalog, references and grants. */
export const pluginCatalog = ref<PluginCatalogView[]>([]);
export const pluginConnections = ref<PluginConnectionView[]>([]);
export const pluginGrants = ref<PluginGrantView[]>([]);
export const pluginConsent = ref<PluginConsentPreview | null>(null);
export const pluginPreview = ref<PluginGrantPreview | null>(null);
export const pluginBusy = ref(false);
export const pluginMessage = ref('');
export const pluginError = ref(false);
export const pluginName = ref('work');
export const pluginCredentialReference = ref('');
export const pluginAccountLabel = ref('');
export const pluginConnectionId = ref('');
export const pluginRepository = ref('');
export const pluginTools = ref('list_issues');
export const pluginBotId = ref('');
export const pluginAck = ref(false);

function failure(error: unknown): void {
  pluginMessage.value = explain(error);
  pluginError.value = true;
}
async function run(action: () => Promise<string>): Promise<void> {
  if (pluginBusy.value) return;
  pluginBusy.value = true;
  pluginMessage.value = '';
  pluginError.value = false;
  try {
    pluginMessage.value = await action();
  } catch (error) {
    failure(error);
  } finally {
    pluginBusy.value = false;
  }
}
const github = () => pluginCatalog.value.find((entry) => entry.pluginId === 'github') ?? null;
export function pluginInstalled(): boolean {
  return github()?.installed === true;
}
export function pluginEnabled(): boolean {
  return github()?.enabled === true;
}
export function pluginSelectedConnection(): PluginConnectionView | null {
  return (
    pluginConnections.value.find((connection) => connection.id === pluginConnectionId.value) ?? null
  );
}
export function pluginCanGrant(): boolean {
  return (
    pluginSelectedConnection()?.schemaDigest !== null &&
    pluginSelectedConnection()?.schemaDigest !== undefined &&
    pluginRepository.value.trim() !== '' &&
    pluginTools.value.trim() !== '' &&
    pluginBotId.value !== ''
  );
}
/** Forget typed values that are not persisted as a reference name. */
export function clearPluginInputs(): void {
  pluginCredentialReference.value = '';
  pluginAccountLabel.value = '';
  pluginConsent.value = null;
  pluginPreview.value = null;
  pluginMessage.value = '';
  pluginError.value = false;
}
export async function loadPlugins(roomId?: string): Promise<void> {
  try {
    const [catalog, connections, grants] = await Promise.all([
      call({ op: 'plugin-catalog' }),
      call({ op: 'plugin-connections' }),
      call({ op: 'plugin-access-list', ...(roomId === undefined ? {} : { room: roomId }) }),
    ]);
    pluginCatalog.value = catalog;
    pluginConnections.value = connections;
    pluginGrants.value = grants;
    if (pluginConnectionId.value === '' && connections[0] !== undefined)
      pluginConnectionId.value = connections[0].id;
  } catch (error) {
    failure(error);
  }
}
export async function installPlugin(): Promise<void> {
  await run(async () => {
    const installed = await call({ op: 'plugin-install', pluginId: 'github' });
    await loadPlugins();
    return `Установлен github@${installed.version} (выключен).`;
  });
}
export async function enablePlugin(): Promise<void> {
  await run(async () => {
    const result = await call({ op: 'plugin-enable', pluginId: 'github' });
    await loadPlugins();
    return `Включён github@${result.installed.version}. Отозвано прав: ${String(result.revokedGrants)}.`;
  });
}
export async function disablePlugin(): Promise<void> {
  await run(async () => {
    const disabled = await call({ op: 'plugin-disable', pluginId: 'github' });
    await loadPlugins();
    return `Выключен github@${disabled.version}.`;
  });
}
export async function addPluginConnection(): Promise<void> {
  await run(async () => {
    const connection = await call({
      op: 'plugin-connection-add',
      name: pluginName.value.trim(),
      pluginId: 'github',
      credentialReference: pluginCredentialReference.value.trim(),
      ...(pluginAccountLabel.value.trim() === ''
        ? {}
        : { accountLabel: pluginAccountLabel.value.trim() }),
    });
    pluginCredentialReference.value = '';
    pluginAccountLabel.value = '';
    await loadPlugins();
    return `Подключение «${connection.name}» создано, поколение ${String(connection.generation)}.`;
  });
}
export async function previewPluginConsent(): Promise<void> {
  const connection = pluginSelectedConnection();
  if (connection === null) return;
  await run(async () => {
    pluginConsent.value = await call({
      op: 'plugin-connection-preview',
      connectionId: connection.id,
    });
    return 'Проверьте адрес и подтвердите запрос метаданных.';
  });
}
export async function consentPluginDiscovery(roomId?: string): Promise<void> {
  const connection = pluginSelectedConnection();
  if (connection === null) return;
  await run(async () => {
    const preview = await call({
      op: 'plugin-connection-consent',
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    pluginConsent.value = preview;
    // Refresh the connection row so the discovery action becomes available.
    await loadPlugins(roomId);
    return 'Согласие сохранено для этого поколения подключения.';
  });
}
export async function discoverPluginConnection(): Promise<void> {
  const connection = pluginSelectedConnection();
  if (connection === null) return;
  await run(async () => {
    const result = await call({
      op: 'plugin-connection-discover',
      connectionId: connection.id,
      expectedGeneration: connection.generation,
    });
    await loadPlugins();
    return (
      `Обнаружено инструментов: ${String(result.connection.tools.length)}. ` +
      `Схема опубликована, личность: ${result.connection.identityLabel}.`
    );
  });
}
export async function disconnectPluginConnection(): Promise<void> {
  const connection = pluginSelectedConnection();
  if (connection === null) return;
  await run(async () => {
    const result = await call({
      op: 'plugin-connection-disconnect',
      connectionId: connection.id,
    });
    pluginConsent.value = null;
    await loadPlugins();
    return `Подключение «${result.connection.name}» отключено, права отозваны.`;
  });
}
export async function previewPluginGrant(roomId: string): Promise<void> {
  if (!pluginCanGrant()) return;
  await run(async () => {
    pluginPreview.value = await call({
      op: 'plugin-access-preview',
      room: roomId,
      connectionId: pluginConnectionId.value,
      botId: pluginBotId.value,
      repository: pluginRepository.value.trim(),
      tools: pluginTools.value
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean),
      acknowledgeGroupVisibility: pluginAck.value,
    });
    return 'Проверьте, кто увидит ответ, и подтвердите выдачу.';
  });
}
export async function grantPluginAccess(roomId: string): Promise<void> {
  if (!pluginCanGrant()) return;
  await run(async () => {
    const grant = await call({
      op: 'plugin-access-grant',
      room: roomId,
      connectionId: pluginConnectionId.value,
      botId: pluginBotId.value,
      repository: pluginRepository.value.trim(),
      tools: pluginTools.value
        .split(',')
        .map((tool) => tool.trim())
        .filter(Boolean),
      acknowledgeGroupVisibility: pluginAck.value,
    });
    pluginPreview.value = null;
    await loadPlugins(roomId);
    return `Право выдано: бот ${grant.botId}, репозиторий ${grant.repository}.`;
  });
}
export async function revokePluginGrant(grantId: string, roomId: string): Promise<void> {
  await run(async () => {
    await call({ op: 'plugin-access-revoke', grantId });
    await loadPlugins(roomId);
    return 'Право отозвано немедленно.';
  });
}
