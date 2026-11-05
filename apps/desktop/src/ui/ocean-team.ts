/** Explicit team creation; each unknown acknowledgement retains its original keyless command. */
import { shallowRef } from 'vue';
import type { LocalBotModelBinding } from '../model-protocol.js';
import { modelSupport } from './model-support.js';
import type { Bot, Command } from '../protocol.js';
import { call } from './bridge.js';
import { requireProviderDefaultModel } from './provider-state.js';
import { unknownOutcome } from './model-settings-text.js';
type Choices = Readonly<Record<string, LocalBotModelBinding>>;
type TeamCommand = Extract<Command, { op: 'bot' | 'bot-bound-create' | 'group' }>;
export const teamPending = shallowRef<{
  readonly command: TeamCommand;
  readonly choices: Choices;
} | null>(null);
export interface OceanTeamDeps {
  readonly readBots: () => Promise<Bot[]>;
  readonly setBots: (bots: Bot[]) => void;
  readonly currentBots: () => readonly Bot[];
  readonly refresh: (preferred?: string) => Promise<void>;
  readonly requestId: () => string;
}
async function send(command: TeamCommand, choices: Choices) {
  try {
    const result = await call(command);
    teamPending.value = null;
    return 'kind' in result && result.kind === 'room' ? result.data.id : null;
  } catch (error) {
    if (unknownOutcome(error)) {
      teamPending.value = { command: structuredClone(command), choices: structuredClone(choices) };
      throw Error('team_outcome_unknown');
    }
    throw error;
  }
}
export async function createOceanTeam(deps: OceanTeamDeps, choices: Choices = {}): Promise<void> {
  if (modelSupport.value === null) throw Error('model_runtime_upgrade_required');
  choices = Object.fromEntries(
    Object.entries(choices).map(([handle, binding]) => [
      handle,
      { connectionId: binding.connectionId, modelId: binding.modelId },
    ]),
  );
  deps.setBots(await deps.readBots());
  const original = teamPending.value;
  if (original) {
    choices = original.choices;
    const room = await send(original.command, choices);
    if (room) {
      await deps.refresh(room);
      return;
    }
    deps.setBots(await deps.readBots());
  }
  const missing = ['dev', 'review'].filter(
    (handle) => !deps.currentBots().some((bot) => bot.handle === handle),
  );
  if (
    modelSupport.value &&
    missing.some((handle) => !choices[handle]?.connectionId || !choices[handle]?.modelId)
  )
    throw Error('explicit_bot_binding_required');
  const model = !modelSupport.value && missing.length ? requireProviderDefaultModel() : '';
  for (const handle of missing) {
    const details = {
      requestId: deps.requestId(),
      handle,
      name: handle,
      role: handle === 'dev' ? 'Разработчик' : 'Ревьюер',
    };
    if (modelSupport.value)
      await send(
        {
          op: 'bot-bound-create',
          input: { ...details, workspaceId: 'ws_ocean', binding: { ...choices[handle]! } },
        },
        choices,
      );
    else await send({ op: 'bot', ...details, model }, choices);
    deps.setBots(await deps.readBots());
  }
  const room = await send(
    {
      op: 'group',
      requestId: deps.requestId(),
      title: 'Ocean Team',
      bots: deps
        .currentBots()
        .filter((bot) => ['dev', 'review'].includes(bot.handle))
        .map((bot) => bot.id),
    },
    choices,
  );
  if (room) await deps.refresh(room);
}
