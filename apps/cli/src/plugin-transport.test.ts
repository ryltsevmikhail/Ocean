/**
 * The one composition that enables plugin execution must stay fail-closed.
 *
 * Covers the injected deterministic transport, the loopback-only endpoint
 * override guard, and the qualified source adapter opening without any tool
 * dispatch. No network request is made here.
 */
import { describe, expect, it } from 'vitest';
import type { ServicePluginTransportPort } from '@runnets/application';
import { hostPluginTransport, openExecutorPluginTransport } from './plugin-transport.js';

describe('plugin transport composition', () => {
  it('passes an injected deterministic transport through unchanged', async () => {
    const injected = {
      qualification: () => ({ qualified: false, reason: 'test', identities: {} }),
      discover: async () => {
        throw Error('no discovery in this test');
      },
      invoke: async () => {
        throw Error('no invocation in this test');
      },
    } as unknown as ServicePluginTransportPort;
    const resolved = await hostPluginTransport({
      transport: injected,
      env: {},
      connections: () => undefined,
    });
    expect(resolved).toBe(injected);
  });

  it('refuses a non-loopback endpoint override before any host is constructed', async () => {
    const transport = await openExecutorPluginTransport({
      env: {},
      connection: () => null,
      endpointOverride: 'https://api.githubcopilot.com/mcp/',
    });
    expect(transport.qualification()).toMatchObject({
      qualified: false,
      reason: 'plugin_endpoint_untrusted',
    });
  });

  it('refuses an unparsable endpoint override', async () => {
    const transport = await openExecutorPluginTransport({
      env: {},
      connection: () => null,
      endpointOverride: 'not a url',
    });
    expect(transport.qualification()).toMatchObject({
      qualified: false,
      reason: 'plugin_endpoint_untrusted',
    });
  });

  it('opens the qualified source adapter for a loopback override without dispatch', async () => {
    const transport = await openExecutorPluginTransport({
      env: {},
      connection: () => null,
      endpointOverride: 'http://127.0.0.1:9/mcp',
    });
    try {
      const qualification = transport.qualification();
      expect(qualification.qualified).toBe(true);
      expect(qualification.identities['@executor-js/sdk']).toBe('1.6.11');
    } finally {
      const close = (transport as unknown as { close?: () => Promise<void> }).close;
      if (typeof close === 'function') await close.call(transport);
    }
  });
});
