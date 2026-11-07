import { z } from 'zod';
import { operationKey, projectDigest } from '../project-protocol.js';

const workMemory = z.strictObject({
  prepare: operationKey.optional(),
  review: operationKey.optional(),
  apply: operationKey.optional(),
  turn: z
    .strictObject({
      requestId: z.string().uuid(),
      textDigest: projectDigest,
      cancelId: z.string().uuid().optional(),
    })
    .optional(),
  capture: z
    .strictObject({
      requestId: z.string().uuid(),
      policyVersion: z.int().positive(),
      hash: projectDigest.optional(),
    })
    .optional(),
});
export type WorkMemory = z.infer<typeof workMemory>;
export const selectionMemory = z.strictObject({ projectId: z.string(), taskId: z.string() });
export const reserveMemory = operationKey;
export function projectMemory<T>(storage: Storage, key: string, schema: z.ZodType<T>) {
  const name = 'ocean.projects.' + key;
  return {
    read(): T | undefined {
      try {
        const value = schema.safeParse(JSON.parse(storage.getItem(name) ?? 'null'));
        return value.success ? value.data : undefined;
      } catch {
        return undefined;
      }
    },
    write(value: T) {
      storage.setItem(name, JSON.stringify(value));
    },
  };
}
export function taskMemory(storage: Storage, profileId: string, projectId: string, taskId: string) {
  return projectMemory(storage, JSON.stringify([profileId, projectId, taskId]), workMemory);
}

export async function textDigest(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
