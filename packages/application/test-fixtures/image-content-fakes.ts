/* eslint-disable no-restricted-imports -- Test-only fakes for the same application package's ports. */
import { createHash } from 'node:crypto';
import type {
  ChatContent,
  ChatMessage,
  ImagePart,
  ModelRequest,
  ProviderEvent,
  ProviderModelInfo,
  ProviderPort,
  TextPart,
} from '../src/provider.js';
import type {
  ImageAssetResolverPort,
  ImageResolveRequest,
  ImageResolveResult,
} from '../src/image-content.js';

/** Genuine 3x2 ImageMagick encodings; decoded bytes are asserted end-to-end. */
export const TINY_IMAGES = {
  'image/png':
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACAQMAAACnuvRZAAAAA1BMVEXAOSuU7d9gAAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC',
  'image/gif': 'R0lGODlhAwACAPAAACeuYAAAACH5BAAAAAAALAAAAAADAAIAAAIChF8AOw==',
  'image/jpeg':
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ABRzT+//2Q==',
  'image/webp':
    'UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoDAAIAAgA0JaACdLoB+AADsAD+8Skv/d5v2837eb/ho/+B/WK0qAAA',
} as const;
export type TinyMediaType = keyof typeof TINY_IMAGES;

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
export function tinyImage(
  mediaType: TinyMediaType = 'image/png',
  overrides: Partial<ImagePart> = {},
): ImagePart {
  const bytes = Buffer.from(TINY_IMAGES[mediaType], 'base64');
  return {
    type: 'image',
    mediaType,
    bytes: new Uint8Array(bytes),
    attachmentId: '12345678-1234-4123-8123-123456789abc',
    roomId: 'room-1',
    sha256: sha256(bytes),
    width: 3,
    height: 2,
    ...overrides,
  };
}
export function imageContent(
  text: string,
  ...images: readonly ImagePart[]
): readonly (TextPart | ImagePart)[] {
  return [{ type: 'text', text }, ...images];
}
export function imageUserMessage(...images: readonly ImagePart[]): ChatMessage {
  return { role: 'user', content: imageContent('вопрос', ...images) };
}
export function messageText(content: ChatContent): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}
export const DEEPSEEK_MODEL_INFO: readonly ProviderModelInfo[] = [
  { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
  { id: 'deepseek-v4-pro', inputModalities: ['text'] },
];
export function requestBytesFallback(request: ModelRequest): number {
  // One neutral "serializer": UTF-8 bytes of the whole normalized request.
  return Buffer.byteLength(JSON.stringify(request), 'utf8');
}
export interface RecordingProvider extends ProviderPort {
  readonly requests: ModelRequest[];
  readonly refusals: ProviderEvent[];
}
export interface RecordingProviderOptions {
  readonly id?: string;
  readonly models?: readonly string[];
  readonly modelInfo?: readonly ProviderModelInfo[] | undefined;
  readonly requestBytes?: ((request: ModelRequest) => number) | undefined;
  readonly text?: string;
}
export function recordingProvider(options: RecordingProviderOptions = {}): RecordingProvider {
  const requests: ModelRequest[] = [];
  const refusals: ProviderEvent[] = [];
  const text = options.text ?? 'Понял изображение';
  return {
    id: options.id ?? 'deepseek',
    models: options.models ?? ['deepseek-flash', 'deepseek-v4-pro'],
    ...(options.modelInfo === undefined ? {} : { modelInfo: options.modelInfo }),
    ...(options.requestBytes === undefined ? {} : { requestBytes: options.requestBytes }),
    capabilities: { streaming: true, reasoning: true, usage: true, toolCalls: true },
    requests,
    refusals,
    async *stream(request) {
      requests.push(request);
      yield { type: 'reasoning_delta', text: 'private reasoning' };
      yield { type: 'text_delta', text };
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } };
      yield { type: 'completed', stopReason: 'stop', rawStopReason: 'stop' };
    },
  };
}
export interface ResolverStub extends ImageAssetResolverPort {
  readonly requests: ImageResolveRequest[];
}
export function resolverStub(
  result: ImageResolveResult | ((request: ImageResolveRequest) => ImageResolveResult),
): ResolverStub {
  const requests: ImageResolveRequest[] = [];
  return {
    requests,
    resolve(request) {
      requests.push(request);
      return typeof result === 'function' ? result(request) : result;
    },
  };
}
export function resolveOk(...images: readonly ImagePart[]): ImageResolveResult {
  return { ok: true, images };
}
export function resolveFail(code: 'image_unavailable' | 'image_too_large'): ImageResolveResult {
  return { ok: false, code };
}
/** A marker that names no durable preparation/message binding. */
export function resolveUnbound(): ImageResolveResult {
  return { ok: false, code: 'image_unavailable', unbound: true };
}
