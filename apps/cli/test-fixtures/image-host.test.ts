/* eslint-disable no-restricted-imports -- Test-only deterministic host fixture. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { vi } from 'vitest';
import { openOceanProfile } from '../src/ocean/profile.js';
import { startLocalRuntime, type LocalRuntimeHost } from '../src/local-runtime/host.js';
import { connectLocalRuntime, DesktopAttachmentClient } from '@runnets/tools-node';
import type { LocalRuntimeClient } from '@runnets/tools-node';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  ProviderModelInfo,
  ProviderPort,
} from '@runnets/application';
import { createDeepSeekProvider } from '@runnets/provider-deepseek';

export const WORKSPACE = 'ws_ocean';
export const MODEL_INFO: readonly ProviderModelInfo[] = [
  { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', inputModalities: ['text'] },
];
export interface ImageProfile {
  readonly root: string;
  readonly profile: string;
  readonly flashRoom: string;
  readonly proRoom: string;
  readonly groupRoom: string;
  readonly bots: Readonly<Record<'flash' | 'pro', string>>;
  dispose(): void;
}
/** Private synthetic HOME/XDG profile; never the owner's profile. */
export async function imageProfile(): Promise<ImageProfile> {
  const root = mkdtempSync(join(tmpdir(), 'ocean-images-'));
  for (const name of ['home', 'config', 'data', 'cache', 'state', 'run', 'tmp'])
    mkdirSync(join(root, name), { mode: 0o700 });
  const profile = join(root, 'profile');
  const runtime = openOceanProfile(profile, true);
  await runtime.ready;
  const execute = runtime.conversations.execute.bind(runtime.conversations);
  execute({ type: 'BindWorkspace', requestId: 'init', workspaceId: WORKSPACE, root });
  const createBot = (handle: string, model: string) => {
    const created = execute({
      type: 'CreateBot',
      requestId: 'bot-' + handle,
      workspaceId: WORKSPACE,
      handle,
      name: handle,
      role: handle,
      provider: 'deepseek',
      model,
    });
    if (!created.ok || created.value.kind !== 'bot') throw Error('fixture bot');
    return created.value.data.id;
  };
  const openRoom = (requestId: string, botId: string) => {
    const created = execute({ type: 'OpenDirectRoom', requestId, workspaceId: WORKSPACE, botId });
    if (!created.ok || created.value.kind !== 'room' || created.value.data.kind !== 'direct')
      throw Error('fixture room');
    return created.value.data.id;
  };
  const flash = createBot('flash', 'deepseek-flash');
  const pro = createBot('pro', 'deepseek-v4-pro');
  const flashRoom = openRoom('room-flash', flash);
  const proRoom = openRoom('room-pro', pro);
  const group = execute({
    type: 'CreateGroupRoom',
    requestId: 'room-team',
    workspaceId: WORKSPACE,
    title: 'Team',
    botIds: [flash, pro],
  });
  if (!group.ok || group.value.kind !== 'room' || group.value.data.kind !== 'group')
    throw Error('fixture group');
  runtime.close();
  return {
    root,
    profile,
    flashRoom,
    proRoom,
    groupRoom: group.value.data.id,
    bots: { flash, pro },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
/** The actual vendor adapter over a deterministic recording transport. */
export interface WireProvider {
  readonly provider: ProviderPort;
  readonly calls: HttpRequest[];
}
export function imageProvider(): WireProvider {
  const calls: HttpRequest[] = [];
  const httpClient: HttpClient = {
    async send(request: HttpRequest): Promise<HttpResponse> {
      calls.push(request);
      return {
        status: 200,
        ok: true,
        text: async () => '',
        stream: () =>
          (async function* () {
            yield 'data: {"choices":[{"delta":{"content":"Вижу изображение"},"finish_reason":null}]}\n\n';
            yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
            yield 'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":4,"total_tokens":25}}\n\n';
            yield 'data: [DONE]\n\n';
          })(),
      };
    },
  };
  return {
    provider: createDeepSeekProvider({ apiKey: 'sk-fixture-wire-only', httpClient }),
    calls,
  };
}
/** Decode the exact serialized request body one recording transport received. */
export function wireMessages(call: HttpRequest): readonly {
  readonly role: string;
  readonly content: unknown;
}[] {
  const body = call.body;
  if (typeof body !== 'string') throw Error('missing request body');
  const parsed = JSON.parse(body) as { messages: readonly { role: string; content: unknown }[] };
  return parsed.messages;
}
export interface ImageHost {
  readonly host: LocalRuntimeHost;
  readonly client: LocalRuntimeClient;
  readonly media: DesktopAttachmentClient;
  stop(): Promise<void>;
}
export async function startImageHost(
  fixture: ImageProfile,
  provider: ProviderPort,
): Promise<ImageHost> {
  const host = await startLocalRuntime({ profile: fixture.profile, provider });
  const client = await connectLocalRuntime({ profile: fixture.profile });
  const userData = join(fixture.root, 'userData');
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const media = new DesktopAttachmentClient(client);
  await media.enroll(userData);
  return {
    host,
    client,
    media,
    async stop() {
      client.close();
      await host.stop();
    },
  };
}
export async function attach(
  host: ImageHost,
  room: string,
  name: string,
  bytes: Buffer | Uint8Array,
) {
  return host.media.import(room, name, Buffer.from(bytes).toString('base64'));
}
export async function prepareText(
  host: ImageHost,
  room: string,
  requestId: string,
  text: string,
  ids: readonly string[],
  to: string | null = null,
) {
  return host.media.prepare(room, requestId, text, to, ids);
}
const NON_TERMINAL = new Set([
  'admitted_before_run',
  'not_created',
  'created',
  'queued',
  'admitted',
  'running',
  'waiting',
  'retrying',
  'checkpointing',
  'reconciling',
  'cancelling',
]);
export async function settled(
  read: () => Promise<{ readonly taskStatus?: string } | null>,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    const status = value?.taskStatus;
    if (status !== undefined && !NON_TERMINAL.has(status)) return status;
    if (Date.now() > deadline) throw Error('unsettled run');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Deterministic genuine PNG (8-bit grayscale) with optional padding chunk. */
export function pngBytes(width = 3, height = 2, padding = 0): Buffer {
  const raw = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  const chunk = (type: string, payload: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    ...(padding > 0 ? [chunk('tEXt', Buffer.alloc(padding, 0x78))] : []),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export const uuid = () => crypto.randomUUID();
export { vi };
