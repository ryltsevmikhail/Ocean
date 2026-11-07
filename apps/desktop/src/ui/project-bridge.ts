import { z } from 'zod';
import { envelope } from '../protocol.js';
import {
  projectBinding,
  projectCommand,
  type ProjectBinding,
  type ProjectInput,
  type ProjectReplies,
} from '../project-protocol.js';

export type ProjectRequest = <K extends Exclude<keyof ProjectReplies, 'support'>>(
  op: K,
  input: ProjectInput<K>,
) => Promise<ProjectReplies[K]>;

async function post(raw: unknown): Promise<unknown> {
  const parsed = envelope.safeParse(await window.ocean.request(projectCommand(raw)));
  if (!parsed.success) throw Error('outcome_unknown');
  if (!parsed.data.ok) throw Error(parsed.data.error.code);
  return parsed.data.data;
}

export async function projectSupport(): Promise<ProjectReplies['support']> {
  const support = projectBinding
    .extend({ supported: z.boolean() })
    .safeParse(await post({ op: 'support' }));
  if (!support.success) throw Error('outcome_unknown');
  return support.data;
}
export function projectRequest(binding: ProjectBinding): ProjectRequest {
  return async <K extends Exclude<keyof ProjectReplies, 'support'>>(
    op: K,
    input: ProjectInput<K>,
  ) => (await post({ op, input, binding })) as ProjectReplies[K];
}
