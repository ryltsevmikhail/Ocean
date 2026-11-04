/**
 * Transport guards and pinned-identity assertions.
 *
 * These are the fail-closed properties that make one-dispatch semantics
 * meaningful: the origin allowlist, redirect rejection, byte caps and the
 * installed-chunk assertion.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SERVICE_PLUGIN_CALL_DEADLINE_MS,
  SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS,
  SERVICE_PLUGIN_MAX_DISCOVERY_BYTES,
  SERVICE_PLUGIN_MAX_REQUEST_BYTES,
  SERVICE_PLUGIN_MAX_TOOLS,
} from '@runnets/application';

import { GuardedFetchError } from './guarded-fetch.js';
import { createGuardedHttp } from './guarded-fetch.js';
import {
  PINNED_IDENTITIES,
  PINNED_PATCH_FILE,
  PINNED_PATCH_SHA256,
  PINNED_SDK_CHUNK_SHA256,
  verifyInstalledSdkChunk,
} from './pinned-identity.js';
import { assessQualification } from './status.js';
import { closeServer, listen, writeJson } from '../test-fixtures/loopback.js';

const catchGuarded = async (work: Promise<unknown>): Promise<GuardedFetchError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof GuardedFetchError) return error;
    throw error;
  }
  throw new Error('expected a GuardedFetchError');
};

describe('guarded HTTP layer', () => {
  it('rejects an origin outside the fixed allowlist', async () => {
    const server = await listen((_req, res) => writeJson(res, 200, { ok: true }));
    const guarded = createGuardedHttp({ allowedOrigins: ['http://127.0.0.1:1'] });
    const error = await catchGuarded(
      Promise.resolve().then(() => guarded.fetch(`${server.base}/x`)),
    );
    expect(error.code).toBe('origin_not_allowed');
    await closeServer(server.server);
  });

  it('rejects credentials in the request URL', async () => {
    const server = await listen((_req, res) => writeJson(res, 200, { ok: true }));
    const guarded = createGuardedHttp({ allowedOrigins: [server.base] });
    const withCredentials = server.base.replace('http://', 'http://user:pass@');
    const error = await catchGuarded(
      Promise.resolve().then(() => guarded.fetch(`${withCredentials}/x`)),
    );
    expect(error.code).toBe('credentials_in_url');
    await closeServer(server.server);
  });

  it('rejects a redirect with zero requests reaching the redirect target', async () => {
    let attackerRequests = 0;
    const attacker = await listen((_req, res) => {
      attackerRequests += 1;
      writeJson(res, 200, { stolen: true });
    });
    const business = await listen((_req, res) => {
      res.writeHead(302, { location: `${attacker.base}/steal` });
      res.end();
    });
    const guarded = createGuardedHttp({ allowedOrigins: [business.base, attacker.base] });
    const error = await catchGuarded(
      Promise.resolve().then(() => guarded.fetch(`${business.base}/x`)),
    );
    expect(error.code).toBe('redirect_rejected');
    expect(attackerRequests).toBe(0);
    await Promise.all([closeServer(attacker.server), closeServer(business.server)]);
  });

  it('caps the outbound request body before dispatch', async () => {
    const server = await listen((_req, res) => writeJson(res, 200, { ok: true }));
    const guarded = createGuardedHttp({ allowedOrigins: [server.base], requestLimitBytes: 8 });
    const error = await catchGuarded(
      Promise.resolve().then(() =>
        guarded.fetch(`${server.base}/x`, { method: 'POST', body: '0123456789' }),
      ),
    );
    expect(error.code).toBe('request_too_large');
    await closeServer(server.server);
  });

  it('caps the response body while streaming it and aborts the request fast', async () => {
    const server = await listen((_req, res) => writeJson(res, 200, { blob: 'x'.repeat(1_024) }));
    const guarded = createGuardedHttp({
      allowedOrigins: [server.base],
      responseLimitBytes: 16,
      deadlineMs: 10_000,
    });
    const startedAt = Date.now();
    const response = await guarded.fetch(`${server.base}/x`);
    const error = await catchGuarded(response.text());
    // The cap aborts the in-flight request instead of leaving the client to
    // burn the whole per-call deadline.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(error.code).toBe('response_too_large');
    await closeServer(server.server);
  });

  it('enforces the per-request deadline', async () => {
    const server = await listen((_req, res) => {
      setTimeout(() => writeJson(res, 200, { ok: true }), 500);
    });
    const guarded = createGuardedHttp({ allowedOrigins: [server.base], deadlineMs: 50 });
    const startedAt = Date.now();
    let failed = false;
    try {
      const response = await guarded.fetch(`${server.base}/x`);
      await response.text();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await closeServer(server.server);
  });
});

describe('pinned identity', () => {
  it('installed chunk matches the pinned patched digest', async () => {
    const identity = await verifyInstalledSdkChunk();
    expect(identity.ok).toBe(true);
    expect(identity.actualSha256).toBe(PINNED_SDK_CHUNK_SHA256);
    expect(identity.chunkPath).not.toBeNull();
  });

  it('fails closed for a wrong expected hash', async () => {
    const identity = await verifyInstalledSdkChunk({ expectedSha256: '0'.repeat(64) });
    expect(identity.ok).toBe(false);
    expect(identity.actualSha256).toBe(PINNED_SDK_CHUNK_SHA256);
  });

  it('fails closed when the chunk cannot be read', async () => {
    const identity = await verifyInstalledSdkChunk({ chunkPath: '/nonexistent/sdk-chunk.js' });
    expect(identity.ok).toBe(false);
    expect(identity.actualSha256).toBeNull();
  });

  it('repository patch file hashes to the pinned patch identity', async () => {
    const { createHash } = await import('node:crypto');
    const patchPath = fileURLToPath(new URL(`../../../${PINNED_PATCH_FILE}`, import.meta.url));
    const bytes = await readFile(patchPath);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(PINNED_PATCH_SHA256);
    expect(PINNED_IDENTITIES[`patch#${PINNED_PATCH_FILE}`]).toBe(`sha256:${PINNED_PATCH_SHA256}`);
  });

  it('qualification reports the exact pinned identities and refuses by default', async () => {
    const installed = await verifyInstalledSdkChunk();
    const disabled = assessQualification({ requested: false, identity: installed });
    expect(disabled.qualified).toBe(false);
    expect(disabled.reason).toBe('execution_not_enabled');
    expect(disabled.identities['@executor-js/sdk']).toBe('1.6.11');
    expect(disabled.identities.effect).toBe('4.0.0-beta.59');

    const mismatch = assessQualification({
      requested: true,
      identity: { ...installed, ok: false, actualSha256: 'f'.repeat(64) },
    });
    expect(mismatch.qualified).toBe(false);
    expect(mismatch.reason).toBe('pinned_chunk_mismatch');

    const unreadable = assessQualification({
      requested: true,
      identity: { ...installed, ok: false, actualSha256: null },
    });
    expect(unreadable.reason).toBe('pinned_chunk_unreadable');

    const qualified = assessQualification({ requested: true, identity: installed });
    expect(qualified.qualified).toBe(true);
    expect(qualified.reason).toBeNull();
  });

  it('application limits are the approved values', () => {
    expect(SERVICE_PLUGIN_MAX_TOOLS).toBe(256);
    expect(SERVICE_PLUGIN_MAX_REQUEST_BYTES).toBe(1024 * 1024);
    expect(SERVICE_PLUGIN_MAX_DISCOVERY_BYTES).toBe(4 * 1024 * 1024);
    expect(SERVICE_PLUGIN_CALL_DEADLINE_MS).toBe(30_000);
    expect(SERVICE_PLUGIN_DISCOVERY_DEADLINE_MS).toBe(15_000);
  });
});
