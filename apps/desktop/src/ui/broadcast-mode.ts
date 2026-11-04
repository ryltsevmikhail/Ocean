/** Explicit owner action chosen in the group composer; distinct from any bot handle. */
export const BROADCAST_RECIPIENT = '*';
export const isBroadcastRecipient = (value: string): boolean => value === BROADCAST_RECIPIENT;
