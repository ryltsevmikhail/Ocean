/**
 * Runtime image resolver for authenticated Desktop assets.
 *
 * Authority chain (pre-existing schema): persisted user message → completed
 * `prepare:<room>:<requestId>` operation whose `prepared` body is the exact
 * message body → durable message↔request binding (receipt or enrollment
 * adoption) → `desktopRead` (private modes, single link, owner/mount, sha256) →
 * bounded header parse. The untrusted marker only locates the request; its file
 * list is compared with the durable operation ids and never trusted itself.
 */

import { createHash } from 'node:crypto';
import {
  desktopUuid,
  validDesktopAttachment,
  type DesktopAttachment,
  type DesktopBinding,
  type DesktopPreparation,
} from '@runnets/domain';
import {
  MAX_IMAGE_SIDE,
  type ImageAssetResolverPort,
  type ImagePart,
  type ImageResolveRequest,
  type ImageResolutionFailure,
  type ImageResolveResult,
} from '@runnets/application';
import { desktopMetadata, desktopRead } from './desktop-file-store.js';
import { desktopRootIdentity } from './desktop-assets.js';
import { parseImageHeader } from './image-header.js';

/** Narrow durable read surface; implemented by the SQLite Desktop asset store. */
export interface DesktopImageAuthorityStore {
  binding(): DesktopBinding | null;
  message(room: string, messageId: string): { readonly body: string } | null;
  prepared(room: string, requestId: string): DesktopPreparation | null;
  associated(room: string, requestId: string, messageId: string, prepared: string): boolean;
  adopted(room: string, requestId: string, messageId: string, body: string): boolean;
}
const MAX_PREPARED_BYTES = 16384;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
type Attempt<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly code: ImageResolutionFailure };
const refused = (): ImageResolveResult => ({ ok: false, code: 'image_unavailable' });
/** No durable preparation or message↔request binding: the marker was never authoritative. */
const unbound = (): ImageResolveResult => ({ ok: false, code: 'image_unavailable', unbound: true });

export function desktopImageResolver(
  store: DesktopImageAuthorityStore,
  profile: string,
  profileId: string,
): ImageAssetResolverPort {
  return {
    resolve(request: ImageResolveRequest): ImageResolveResult {
      try {
        return resolveRequest(store, profile, profileId, request);
      } catch {
        // Any unreadable authority, private file or binding is an explicit failure.
        return refused();
      }
    },
  };
}
function resolveRequest(
  store: DesktopImageAuthorityStore,
  profile: string,
  profileId: string,
  request: ImageResolveRequest,
): ImageResolveResult {
  // Locate the durable authority first. A marker that names no completed
  // preparation (or is not bound to its message by a receipt/adoption) was never
  // an image message: report it as unbound so history reconstruction can keep the
  // marker-free display text instead of poisoning every later turn. Everything
  // after a proven locator fails closed, including corrupt/missing bytes.
  const preparation = store.prepared(request.roomId, request.requestId);
  if (preparation === null || !preparationValid(preparation, request.body)) return unbound();
  if (
    request.phase === 'committing' &&
    (request.admittedRequestId === undefined || request.admittedRequestId !== request.requestId)
  )
    return refused();
  if (request.phase === 'persisted') {
    const message = store.message(request.roomId, request.messageId);
    if (message === null || message.body !== request.body) return refused();
    if (!messageBound(store, request, preparation)) return unbound();
  }
  const binding = store.binding();
  if (binding === null || !bindingValid(binding, profile, profileId)) return refused();
  // The marker's claimed ids must be exactly the durable operation ids, in order.
  if (
    request.expected.length !== preparation.ids.length ||
    preparation.ids.some((id, index) => request.expected[index]?.id !== id)
  )
    return refused();
  const images: ImagePart[] = [];
  for (const [index, id] of preparation.ids.entries()) {
    // Metadata binds every attachment; only actual images require the blob re-hash.
    // Text snippets are baked into the persisted body at preparation time, so a
    // later missing/replaced text or binary blob must not break the turn.
    const metadata = desktopMetadata(binding, request.roomId, id);
    if (metadata.sha256 !== request.expected[index]!.sha256) return refused();
    if (metadata.kind !== 'image') continue;
    const attachment = desktopRead(binding, request.roomId, id);
    if (!validDesktopAttachment(attachment.info) || attachment.info.id !== id) return refused();
    if (attachment.info.sha256 !== request.expected[index]!.sha256) return refused();
    const part = imagePart(attachment.info, attachment.data, request.roomId);
    if (part.kind === 'refused') return { ok: false, code: part.code };
    if (part.kind === 'ok' && part.value !== null) images.push(part.value);
  }
  return { ok: true, images };
}
function bindingValid(binding: DesktopBinding, profile: string, profileId: string): boolean {
  if (binding.profileId !== profileId || !binding.root.startsWith(profile + '/')) return false;
  if (!/^desktop-[a-f0-9-]{36}\/tree$/.test(binding.root.slice(profile.length + 1))) return false;
  return desktopRootIdentity(binding.root) === binding.identity;
}
function preparationValid(preparation: DesktopPreparation, body: string): boolean {
  if (preparation.prepared !== body || sha256(body) !== preparation.digest) return false;
  if (typeof preparation.body !== 'string' || preparation.body.length > MAX_PREPARED_BYTES)
    return false;
  if (preparation.to !== null && typeof preparation.to !== 'string') return false;
  if (preparation.ids.length < 1 || preparation.ids.length > 4) return false;
  if (new Set(preparation.ids).size !== preparation.ids.length) return false;
  return preparation.ids.every((id) => desktopUuid(id));
}
function messageBound(
  store: DesktopImageAuthorityStore,
  request: ImageResolveRequest,
  preparation: DesktopPreparation,
): boolean {
  return (
    store.associated(request.roomId, request.requestId, request.messageId, preparation.prepared) ||
    store.adopted(request.roomId, request.requestId, request.messageId, request.body)
  );
}
/** A text/binary attachment keeps its text-only behavior and yields no image part. */
function imagePart(
  info: DesktopAttachment,
  data: Buffer,
  roomId: string,
): Attempt<ImagePart | null> {
  if (info.kind !== 'image') return { kind: 'ok', value: null };
  const header = parseImageHeader(data);
  if (header === null || header.mediaType !== info.mime)
    return { kind: 'refused', code: 'image_unavailable' };
  if (header.width > MAX_IMAGE_SIDE || header.height > MAX_IMAGE_SIDE)
    return { kind: 'refused', code: 'image_too_large' };
  return {
    kind: 'ok',
    value: {
      type: 'image',
      mediaType: header.mediaType,
      bytes: new Uint8Array(data),
      attachmentId: info.id,
      roomId,
      sha256: info.sha256,
      width: header.width,
      height: header.height,
    },
  };
}
