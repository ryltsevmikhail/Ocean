import { z } from 'zod';
// Reuse the public closed validators, then detach validated values at both IPC boundaries.
export const dto = <T>(guard: (v: unknown) => v is T) =>
  z.custom<T>(guard).transform((value, ctx) => {
    // Validated JSON DTOs may originate in Vue proxies. Revalidate after detaching;
    // serialization never grants additional fields or substitutes primitive evidence.
    let copy: unknown;
    try {
      copy = JSON.parse(JSON.stringify(value));
    } catch {
      copy = undefined;
    }
    if (!guard(copy)) {
      ctx.addIssue({ code: 'custom', message: 'invalid DTO' });
      return z.NEVER;
    }
    return copy;
  });
