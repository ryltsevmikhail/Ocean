import { commands, envelope, outputs, type Command, type SendStage } from '../protocol.js';
import type { z } from 'zod';
declare global {
  interface Window {
    ocean: { request(message: unknown): Promise<unknown> };
  }
}
type SendFailureStage = 'validation' | SendStage;
export class SendFailure extends Error {
  readonly stage: SendFailureStage;
  constructor(code: string, stage: SendFailureStage) {
    super(code);
    this.stage = stage;
  }
}
async function post(message: unknown) {
  return window.ocean.request(message);
}
export async function call<K extends Command['op']>(
  command: Command & { op: K },
): Promise<z.infer<(typeof outputs)[K]>> {
  if (!commands.safeParse(command).success) {
    if (command.op === 'send') throw new SendFailure('invalid_request', 'validation');
    throw new Error('invalid_request');
  }
  const raw = await post(command);
  const reply = envelope.safeParse(raw);
  if (!reply.success) throw new Error('outcome_unknown');
  if (!reply.data.ok) {
    const { code, sendStage } = reply.data.error;
    if (command.op === 'send' && sendStage) throw new SendFailure(code, sendStage);
    throw new Error(code);
  }
  const data = outputs[command.op].safeParse(reply.data.data);
  if (!data.success) throw new Error('outcome_unknown');
  return data.data as z.infer<(typeof outputs)[K]>;
}

// A receipt lookup proves identity only. Every automatic success must pass binding-checked
// admission. AttachmentHost persists the exact prepared body before its first submission.
export async function submitDraft(command: Extract<Command, { op: 'send' }>) {
  return call(command);
}
