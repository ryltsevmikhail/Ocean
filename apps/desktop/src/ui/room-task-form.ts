import type { LocalOwnerScopeGrant, RoomTaskStart } from '@runnets/contracts';
export function eligibleTaskGrant(
  g: LocalOwnerScopeGrant,
  room: string,
  bot: string,
  now = Date.now(),
) {
  return (
    g.state === 'active' &&
    g.subject.workspaceId === 'ws_ocean' &&
    g.subject.roomId === room &&
    g.subject.botId === bot &&
    g.subject.projectId === null &&
    g.subject.taskId === null &&
    g.permissions.every((p) => p.kind === 'service') &&
    (g.limits.expiresAt === null || Date.parse(g.limits.expiresAt) > now)
  );
}
export function taskDraft(
  room: string,
  members: readonly string[],
  text: string,
  participants: readonly string[],
  initial: readonly string[],
  grants: readonly LocalOwnerScopeGrant[],
  selected: readonly string[],
  now = Date.now(),
): Omit<RoomTaskStart, 'workspaceId' | 'roomId' | 'requestId'> | null {
  if (
    !text.trim() ||
    new TextEncoder().encode(text).length > 16384 ||
    !initial.length ||
    !participants.length ||
    participants.length > 32 ||
    new Set(participants).size !== participants.length ||
    new Set(initial).size !== initial.length ||
    initial.some((id) => !participants.includes(id)) ||
    participants.some((id) => !members.includes(id))
  )
    return null;
  const picked = selected.map((key) => grants.find((g) => `${g.id}@${g.revision}` === key));
  if (
    new Set(selected).size !== selected.length ||
    picked.some(
      (g) =>
        !g ||
        !participants.includes(g.subject.botId) ||
        !eligibleTaskGrant(g, room, g.subject.botId, now),
    )
  )
    return null;
  const chosen = picked.filter((g): g is LocalOwnerScopeGrant => !!g);
  if (participants.some((id) => chosen.filter((g) => g.subject.botId === id).length > 32))
    return null;
  const permissions = chosen
    .flatMap((g) => [...g.permissions])
    .filter(
      (p, i, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(p)) === i,
    );
  if (permissions.length > 256) return null;
  return {
    text,
    initialBotIds: [...initial],
    participants: participants.map((botId) => ({
      botId,
      grantReferences: chosen
        .filter((g) => g.subject.botId === botId)
        .map((g) => ({ grantId: g.id, revision: g.revision })),
    })),
    mandate: { projectId: null, codingTaskId: null, permissions },
  };
}
