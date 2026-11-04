/**
 * Runtime-owned image content for provider-neutral messages.
 *
 * The untrusted Desktop marker is only a locator hint. The resolver port must
 * authenticate every byte against persisted authority and returns typed image
 * parts; this module never turns a marker, path or caption into model content.
 */

import {
  conversationFailure,
  decodeDesktopAttachments,
  desktopAttachmentText,
  hasDesktopAttachmentMarker,
  MAX_CROWDED_IMAGE_SIDE,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_RAW_IMAGE_BYTES,
  CROWDED_IMAGE_COUNT,
  isImageMediaType,
  ok,
  REQUEST_PRE_CHECK_BYTES,
  utf8ByteLength,
  type ConversationErrorCode,
  type ConversationResult,
} from '@runnets/domain';
import type { ChatContent, ChatMessage, ContentPart, ImagePart, ProviderPort } from './provider.js';

/** The runtime owns these limits; adapters share them through the public entry point. */
export {
  CROWDED_IMAGE_COUNT,
  IMAGE_MEDIA_TYPES,
  MAX_CROWDED_IMAGE_SIDE,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_SIDE,
  MAX_RAW_IMAGE_BYTES,
  REQUEST_HARD_LIMIT_BYTES,
  REQUEST_PRE_CHECK_BYTES,
  isImageMediaType,
  utf8ByteLength,
} from '@runnets/domain';
export type { ImageMediaType } from '@runnets/domain';

export type ImageResolutionFailure = 'image_unavailable' | 'image_too_large';
export type ImageContextPhase = 'persisted' | 'committing';

/** Expected marker claims; compared with durable authority, never trusted. */
export interface ImageResolveExpectation {
  readonly id: string;
  readonly sha256: string;
}

export interface ImageResolveRequest {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly messageId: string;
  /** The exact persisted/prepared body whose marker locates the request. */
  readonly body: string;
  readonly requestId: string;
  /**
   * The admitting submission's request id. Required for the fresh `committing`
   * phase: the marker's preparation identity must equal the identity the
   * admission will persist, otherwise the message can never be re-authenticated.
   */
  readonly admittedRequestId?: string | undefined;
  readonly expected: readonly ImageResolveExpectation[];
  /** `persisted` requires the durable message↔request binding. */
  readonly phase: ImageContextPhase;
}

export type ImageResolveResult =
  | { readonly ok: true; readonly images: readonly ImagePart[] }
  | { readonly ok: false; readonly code: ImageResolutionFailure };

/**
 * One runtime adapter authenticates Desktop assets. Synchronous by design: the
 * owning transaction reads durable rows and private files without suspension.
 */
export interface ImageAssetResolverPort {
  resolve(request: ImageResolveRequest): ImageResolveResult;
}

export interface MessageContentScope {
  readonly workspaceId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly body: string;
  /** Submission request id; required when the message is not persisted yet. */
  readonly admittedRequestId?: string | undefined;
  readonly phase: ImageContextPhase;
}

/**
 * Turn one persisted message body into model content. Legacy plain text stays a
 * string; text-only attachment messages become their marker-free text; image
 * messages become text plus runtime-verified image parts.
 */
export function resolveMessageContent(
  scope: MessageContentScope,
  resolver: ImageAssetResolverPort | undefined,
): ConversationResult<ChatContent> {
  const decoded = decodeDesktopAttachments(scope.body);
  if (decoded === null) {
    return hasDesktopAttachmentMarker(scope.body)
      ? conversationFailure('image_unavailable')
      : ok(scope.body);
  }
  // The fresh message is not yet bound by a receipt, so the marker's preparation
  // request id must be exactly the submitting request id. A mismatch would be
  // admitted once and then poison every later reconstruction of the room.
  if (
    scope.phase === 'committing' &&
    (scope.admittedRequestId === undefined || scope.admittedRequestId !== decoded.requestId)
  )
    return conversationFailure('image_unavailable');
  if (resolver === undefined) return conversationFailure('image_unavailable');
  const resolved = resolver.resolve({
    workspaceId: scope.workspaceId,
    roomId: scope.roomId,
    messageId: scope.messageId,
    body: scope.body,
    requestId: decoded.requestId,
    ...(scope.admittedRequestId === undefined
      ? {}
      : { admittedRequestId: scope.admittedRequestId }),
    expected: decoded.files.map((file) => ({ id: file.id, sha256: file.sha256 })),
    phase: scope.phase,
  });
  if (!resolved.ok) return conversationFailure(resolved.code);
  const text = desktopAttachmentText(scope.body);
  if (resolved.images.length === 0) return ok(text);
  const parts: ContentPart[] = text === '' ? [] : [{ type: 'text', text }];
  return ok([...parts, ...resolved.images] as const);
}

export function contentImages(content: ChatContent): readonly ImagePart[] {
  return typeof content === 'string'
    ? []
    : content.filter((part): part is ImagePart => part.type === 'image');
}
export function messageImageParts(message: ChatMessage): readonly ImagePart[] {
  return contentImages(message.content);
}
/** Text bytes only: image bytes have their own budget (research D12). */
export function contentTextBytes(content: ChatContent): number {
  return typeof content === 'string'
    ? utf8ByteLength(content)
    : content.reduce(
        (bytes, part) => bytes + (part.type === 'text' ? utf8ByteLength(part.text) : 0),
        0,
      );
}

export interface ImageAdmissionInput {
  readonly provider: ProviderPort;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
}

/**
 * Capability and budget admission before any turn/dispatch. A refusal here is
 * final for the selected model: RC2 never switches model or account.
 */
export function admitImageRequest(
  input: ImageAdmissionInput,
): ConversationResult<readonly ImagePart[]> {
  const images: ImagePart[] = [];
  for (const message of input.messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      if (part.type !== 'image') continue;
      if (message.role !== 'user') return conversationFailure('image_unavailable');
      images.push(part);
    }
  }
  if (images.length === 0) return ok([]);
  const info = input.provider.modelInfo?.find((model) => model.id === input.model);
  if (
    info === undefined ||
    !info.inputModalities.includes('image') ||
    input.provider.requestBytes === undefined
  )
    return conversationFailure('model_image_unsupported');
  let raw = 0;
  for (const image of images) {
    const valid =
      isImageMediaType(image.mediaType) &&
      Number.isSafeInteger(image.width) &&
      Number.isSafeInteger(image.height) &&
      image.width > 0 &&
      image.height > 0 &&
      /^[a-f0-9]{64}$/.test(image.sha256) &&
      image.bytes.length > 0;
    if (!valid) return conversationFailure('image_unavailable');
    if (image.width > MAX_IMAGE_SIDE || image.height > MAX_IMAGE_SIDE)
      return conversationFailure('image_too_large');
    if (image.bytes.length > MAX_IMAGE_FILE_BYTES) return conversationFailure('image_too_large');
    raw += image.bytes.length;
  }
  if (raw > MAX_RAW_IMAGE_BYTES) return conversationFailure('image_too_large');
  if (
    images.length >= CROWDED_IMAGE_COUNT &&
    images.some(
      (image) => image.width > MAX_CROWDED_IMAGE_SIDE || image.height > MAX_CROWDED_IMAGE_SIDE,
    )
  )
    return conversationFailure('image_too_large');
  const bytes = input.provider.requestBytes({
    model: input.model,
    messages: input.messages,
  });
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > REQUEST_PRE_CHECK_BYTES)
    return conversationFailure('request_too_large');
  return ok(images);
}
/** Projection shared by single-recipient admission and broadcast child guards. */
export function imageRefusalCode(
  provider: ProviderPort,
  model: string,
  messages: readonly ChatMessage[],
): ConversationErrorCode | null {
  const admitted = admitImageRequest({ provider, model, messages });
  return admitted.ok ? null : admitted.error.code;
}
