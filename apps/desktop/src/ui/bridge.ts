import { commands, envelope, outputs, type Command } from '../protocol.js';
import type { z } from 'zod';
declare global {
  interface Window { webkit?: {messageHandlers:{ocean:{postMessage(message:unknown):Promise<unknown>}}} }
}
async function post(message:unknown){
  if(!window.webkit) throw new Error('host_unavailable');
  return window.webkit.messageHandlers.ocean.postMessage(message);
}
export async function call<K extends Command['op']>(command:Command & {op:K}):Promise<z.infer<(typeof outputs)[K]>>{
  if(!commands.safeParse(command).success) throw new Error('invalid_request');
  const raw=await post(command);
  const reply=envelope.safeParse(raw);
  if(!reply.success) throw new Error('outcome_unknown');
  if(!reply.data.ok) throw new Error(reply.data.error.code);
  const data=outputs[command.op].safeParse(reply.data.data);
  if(!data.success) throw new Error('outcome_unknown');
  return data.data as z.infer<(typeof outputs)[K]>;
}
export async function cancel(requestId:string){
  await post({op:'cancel',requestId});
}
