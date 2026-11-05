import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createProviderSecretStore } from '@runnets/tools-node';
import type { ProviderSecretStorePort } from '@runnets/application';
import type { HttpClient } from '@runnets/provider-core';
import { localMetadata } from './model-process-local-metadata.ts';
import { pendingWitness, type ReceiptOwner } from './model-process-witness.ts';
export function ports(profile: string, credentialDir: string) {
  const counters = {
    read: 0,
    attempt: 0,
    published: 0,
    write: 0,
    replace: 0,
    remove: 0,
    probe: 0,
    dispatch: 0,
    external: 0,
  };
  const phases: string[] = [];
  const record = (phase: string) => {
    phases.push(phase);
    appendFileSync(profile + '/phases', phase + '\n', { flush: true });
  };
  let fault: {
    requestId: string;
    owner: ReceiptOwner;
    timing: 'before' | 'after';
    expected?: { envelope: unknown; revision: number; action: string };
  } | null = null;
  let release: (() => void) | undefined;
  let gate: Promise<void> = Promise.resolve();
  const actual = createProviderSecretStore(credentialDir);
  function publication<T>(kind: 'write' | 'replace' | 'remove', delegate: () => T): T {
    counters.attempt++;
    counters[kind]++;
    const planned = fault;
    if (planned) {
      const w = pendingWitness(profile, planned.requestId, planned.owner);
      if (planned.expected) {
        assert.equal(
          JSON.stringify(w.row!['pendingRequest']) === JSON.stringify(planned.expected.envelope),
          true,
          'publication envelope mismatch',
        );
        assert.equal(w.row!['revision'], planned.expected.revision);
        assert.equal(
          (w.row!['pendingSecretChange'] as { action: string }).action,
          planned.expected.action,
        );
      }
      record('pending-committed-before-publication');
      fault = null;
      if (planned.timing === 'before') throw Error('provider_write_failed');
    }
    const result = delegate();
    counters.published++;
    if (planned) {
      record('published-before-activation');
      throw Error('provider_write_failed');
    }
    return result;
  }
  const secrets: ProviderSecretStorePort = {
    read(ref) {
      counters.read++;
      return actual.read(ref);
    },
    write(ref, key) {
      return publication('write', () => actual.write(ref, key));
    },
    replace(oldRef, nextRef, key) {
      return publication('replace', () => actual.replace(oldRef, nextRef, key));
    },
    remove(ref) {
      return publication('remove', () => actual.remove(ref));
    },
  };
  const http: HttpClient = {
    async send(request) {
      if (new URL(request.url).origin === 'http://127.0.0.1:11434') {
        counters.probe++;
        return localMetadata(new URL(request.url));
      }
      assert.equal(new URL(request.url).origin, 'https://api.deepseek.com');
      if (request.method === 'GET') {
        counters.probe++;
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] }),
          stream: async function* () {
            yield JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
          },
        };
      }
      counters.dispatch++;
      record('http-dispatch');
      return {
        status: 200,
        ok: true,
        text: async () => '',
        stream: async function* () {
          await gate;
          yield 'data: ' +
            JSON.stringify({ choices: [{ delta: { content: 'synthetic answer' } }] }) +
            '\n\n';
          yield 'data: ' +
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
            '\n\n';
          yield 'data: ' +
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }) +
            '\n\n';
          yield 'data: [DONE]\n\n';
        },
      };
    },
  };
  return {
    secrets,
    http,
    record,
    snapshot: () => ({ counters: { ...counters }, phases: [...phases] }),
    fault: (input: NonNullable<typeof fault>) => {
      fault = input;
    },
    hold: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      release?.();
    },
  };
}
export type PortSnapshot = ReturnType<ReturnType<typeof ports>['snapshot']>;
