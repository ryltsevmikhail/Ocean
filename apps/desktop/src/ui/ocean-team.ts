/** Desktop shortcut that creates the standard dev/review group in one explicit step. */
import type { Bot } from '../protocol.js';
import { call } from './bridge.js';
import { requireProviderDefaultModel } from './provider-state.js';

export interface OceanTeamDeps {
  readonly readBots: () => Promise<Bot[]>;
  readonly setBots: (bots: Bot[]) => void;
  readonly currentBots: () => readonly Bot[];
  readonly refresh: (preferred?: string) => Promise<void>;
  readonly requestId: () => string;
}
export async function createOceanTeam(deps: OceanTeamDeps): Promise<void> {
  const model = requireProviderDefaultModel();
  for (const handle of ['dev', 'review']) {
    if (!deps.currentBots().some((bot) => bot.handle === handle)) {
      await call({
        op: 'bot',
        requestId: deps.requestId(),
        handle,
        name: handle,
        role: handle === 'dev' ? 'Разработчик' : 'Ревьюер',
        model,
      });
      deps.setBots(await deps.readBots());
    }
  }
  const group = await call({
    op: 'group',
    requestId: deps.requestId(),
    title: 'Ocean Team',
    bots: deps
      .currentBots()
      .filter((bot) => ['dev', 'review'].includes(bot.handle))
      .map((bot) => bot.id),
  });
  await deps.refresh(group.data.id);
}
