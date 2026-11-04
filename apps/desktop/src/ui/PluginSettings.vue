<script setup lang="ts">
import { computed, ref } from 'vue';
import Glyph from './Glyph.vue';
import { explain } from './dom.js';
import type { Bot, Room } from '../protocol.js';
import {
  addPluginConnection,
  clearPluginInputs,
  consentPluginDiscovery,
  disablePlugin,
  discoverPluginConnection,
  disconnectPluginConnection,
  enablePlugin,
  grantPluginAccess,
  installPlugin,
  loadPlugins,
  pluginAccountLabel,
  pluginAck,
  pluginBotId,
  pluginBusy,
  pluginCanGrant,
  pluginCatalog,
  pluginConsent,
  pluginConnectionId,
  pluginConnections,
  pluginCredentialReference,
  pluginError,
  pluginGrants,
  pluginMessage,
  pluginName,
  pluginPreview,
  pluginRepository,
  pluginSelectedConnection,
  pluginTools,
  previewPluginConsent,
  previewPluginGrant,
  revokePluginGrant,
} from './plugin-state.js';

const props = defineProps<{ busy: boolean; room?: Room | undefined; bots: readonly Bot[] }>();
const panel = ref<HTMLDialogElement>();
const entry = computed(
  () => pluginCatalog.value.find((candidate) => candidate.pluginId === 'github') ?? null,
);
const selected = computed(() => pluginSelectedConnection());
const roomId = computed(() => props.room?.id ?? '');
const canGrant = computed(() => pluginCanGrant() && props.room !== undefined);
function open() {
  clearPluginInputs();
  panel.value?.showModal();
  void loadPlugins(props.room?.id);
}
function close() {
  clearPluginInputs();
  panel.value?.close();
}
</script>
<template>
  <button class="round" aria-label="Плагины" title="Плагины" :disabled="busy" @click="open">
    <Glyph name="plus" />
  </button>
  <Teleport to="body">
    <dialog ref="panel" class="provider-panel plugin-panel" aria-label="Плагины" @cancel="close">
      <header>
        <small>ПЛАГИНЫ</small
        ><button class="round" aria-label="Закрыть плагины" @click="close">
          <Glyph name="close" />
        </button>
      </header>
      <p v-if="!entry" role="status">Каталог недоступен.</p>
      <section v-else class="info-card" role="status" data-testid="plugin-card">
        <strong>{{ entry.title }} · {{ entry.version }}</strong>
        <p>{{ entry.endpoint }}</p>
        <p class="muted">
          {{
            entry.installed ? (entry.enabled ? 'Включён' : 'Установлен, выключен') : 'Не установлен'
          }}
          · {{ entry.publisher }} · только чтение · {{ entry.manifestDigest.slice(0, 12) }}…
        </p>
        <p class="muted">Инструменты: {{ entry.tools.join(', ') }}</p>
        <div class="form-actions">
          <button
            data-testid="plugin-install"
            :disabled="busy || pluginBusy || entry.installed"
            @click="installPlugin"
          >
            Установить</button
          ><button
            data-testid="plugin-enable"
            :disabled="busy || pluginBusy || !entry.installed || entry.enabled"
            @click="enablePlugin"
          >
            Включить</button
          ><button
            data-testid="plugin-disable"
            :disabled="busy || pluginBusy || !entry.enabled"
            @click="disablePlugin"
          >
            Выключить
          </button>
        </div>
      </section>
      <h2>Подключения</h2>
      <p class="muted">
        Credential — только имя переменной окружения. Значение Ocean не читает и не хранит.
      </p>
      <div class="form-actions">
        <label>Имя<input v-model="pluginName" data-testid="plugin-name" maxlength="64" /></label
        ><label
          >Переменная окружения<input
            v-model="pluginCredentialReference"
            data-testid="plugin-credential"
            placeholder="OCEAN_GITHUB_WORK_TOKEN"
            spellcheck="false"
            autocomplete="off"
            maxlength="128" /></label
        ><label
          >Метка аккаунта<input
            v-model="pluginAccountLabel"
            data-testid="plugin-account"
            maxlength="256" /></label
        ><button
          data-testid="plugin-connect"
          :disabled="busy || pluginBusy || pluginCredentialReference.trim() === ''"
          @click="addPluginConnection"
        >
          Добавить подключение
        </button>
      </div>
      <p v-if="pluginConnections.length === 0" class="muted">Подключений нет.</p>
      <ul v-else class="plugin-connections">
        <li
          v-for="connection in pluginConnections"
          :key="connection.id"
          :data-testid="'plugin-connection-' + connection.name"
        >
          <label>
            <input
              v-model="pluginConnectionId"
              type="radio"
              name="plugin-connection"
              :value="connection.id"
            />
            <strong>{{ connection.name }}</strong> · поколение {{ connection.generation }} ·
            {{ connection.state }} · личность {{ connection.identityLabel }} · схема
            {{ connection.schemaDigest === null ? 'не опубликована' : 'опубликована' }}
          </label>
          <small class="muted">credential: {{ connection.credentialReference }}</small>
        </li>
      </ul>
      <div v-if="selected" class="info-card" role="status" data-testid="plugin-consent">
        <p>{{ selected.endpoint }}</p>
        <p class="muted">
          {{ selected.consented ? 'Согласие на метаданные: да' : 'Согласие на метаданные: нет' }}
        </p>
        <p class="muted">
          {{
            selected.identity === null
              ? 'Личность аккаунта не подтверждена.'
              : 'Личность: ' + selected.identity + ' (' + selected.identityLabel + ')'
          }}
        </p>
        <div class="form-actions">
          <button
            data-testid="plugin-consent-preview"
            :disabled="busy || pluginBusy"
            @click="previewPluginConsent"
          >
            Показать адрес</button
          ><button
            data-testid="plugin-consent-confirm"
            :disabled="busy || pluginBusy"
            @click="consentPluginDiscovery(roomId)"
          >
            Разрешить метаданные</button
          ><button
            data-testid="plugin-discover"
            :disabled="busy || pluginBusy || !selected.consented"
            @click="discoverPluginConnection"
          >
            Обнаружить</button
          ><button
            data-testid="plugin-disconnect"
            :disabled="busy || pluginBusy"
            @click="disconnectPluginConnection"
          >
            Отключить
          </button>
        </div>
        <p v-if="pluginConsent" data-testid="plugin-consent-prompt">{{ pluginConsent.prompt }}</p>
      </div>
      <h2>Права в комнате</h2>
      <p v-if="!room" class="muted">Выберите комнату, чтобы увидеть и выдать права.</p>
      <template v-else>
        <div class="form-actions">
          <label
            >Бот<select v-model="pluginBotId" data-testid="plugin-bot">
              <option value="">—</option>
              <option v-for="bot in props.bots" :key="bot.id" :value="bot.id">
                {{ bot.handle }}
              </option>
            </select></label
          ><label
            >Репозиторий<input
              v-model="pluginRepository"
              data-testid="plugin-repository"
              placeholder="owner/name"
              maxlength="256" /></label
          ><label
            >Инструменты<input
              v-model="pluginTools"
              data-testid="plugin-tools"
              placeholder="list_issues,issue_read"
              maxlength="256"
          /></label>
        </div>
        <p class="muted">
          Ответ бота будут видеть участники этой комнаты. В групповом чате — все участники; для
          подтверждения отметьте поле ниже.
        </p>
        <label
          ><input v-model="pluginAck" type="checkbox" data-testid="plugin-ack" /> Видимость в
          групповом чате подтверждена
        </label>
        <div
          v-if="pluginPreview"
          class="info-card"
          :data-allowed="String(pluginPreview.allowed)"
          data-testid="plugin-preview"
          role="status"
        >
          <p>{{ pluginPreview.explanation }}</p>
          <p v-if="!pluginPreview.allowed" class="warning">Отказ: {{ pluginPreview.refusal }}</p>
        </div>
        <div class="form-actions">
          <button
            data-testid="plugin-preview-grant"
            :disabled="busy || pluginBusy || !canGrant"
            @click="previewPluginGrant(roomId)"
          >
            Показать объяснение</button
          ><button
            data-testid="plugin-grant"
            :disabled="busy || pluginBusy || !canGrant || pluginPreview === null"
            @click="grantPluginAccess(roomId)"
          >
            Выдать право
          </button>
        </div>
        <ul class="plugin-grants">
          <li
            v-for="grant in pluginGrants.filter((candidate) => candidate.roomId === roomId)"
            :key="grant.id"
            :data-testid="'plugin-grant-' + grant.id"
            :data-state="grant.state"
          >
            <span
              >{{ grant.botId }} · {{ grant.repository }} · {{ grant.tools.join(', ') }} ·
              {{ grant.state === 'active' ? 'действует' : 'отозвано' }}</span
            ><button
              data-testid="plugin-revoke"
              :disabled="busy || pluginBusy || grant.state === 'revoked'"
              @click="revokePluginGrant(grant.id, roomId)"
            >
              Отозвать
            </button>
          </li>
        </ul>
      </template>
      <p
        v-if="pluginMessage"
        :role="pluginError ? 'alert' : 'status'"
        :class="{ warning: pluginError }"
        data-testid="plugin-message"
      >
        {{ pluginError ? explain(pluginMessage) : pluginMessage }}
      </p>
    </dialog>
  </Teleport>
</template>
