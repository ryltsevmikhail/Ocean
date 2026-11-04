/**
 * Owner-visible grant explanation.
 *
 * The owner must see exactly who can read the bot's answer before confirming a
 * grant. In a group chat that means every participant (including every bot in
 * the room); a direct chat is owner-only. This text is pure and deterministic.
 */

export interface PluginGrantVisibilityFacts {
  readonly roomKind: 'direct' | 'group';
  readonly roomTitle: string | null;
  readonly participantCount: number;
  readonly botId: string;
  readonly connectionName: string;
  readonly accountLabel: string | null;
  readonly identityLabel: 'verified' | 'unverified';
  readonly repository: string;
  readonly tools: readonly string[];
}

export function pluginGrantExplanation(facts: PluginGrantVisibilityFacts): string {
  const audience =
    facts.roomKind === 'group'
      ? 'Everyone in the group chat "' +
        (facts.roomTitle ?? 'this room') +
        '" (' +
        String(facts.participantCount) +
        ' participant bots) including every bot in it will see this answer'
      : 'Only you see this answer in the direct chat';
  return (
    audience +
    '. The bot will read from repository ' +
    facts.repository +
    ' through connection "' +
    facts.connectionName +
    '" (account label ' +
    (facts.accountLabel ?? 'none') +
    ', identity ' +
    facts.identityLabel +
    '). The grant applies only to bot ' +
    facts.botId +
    ', only to ' +
    facts.tools.join(', ') +
    ', and only to repository ' +
    facts.repository +
    '.'
  );
}
