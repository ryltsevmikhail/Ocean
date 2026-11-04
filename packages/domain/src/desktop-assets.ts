/** Portable Desktop evidence, never execution or path-selection authority. */
export interface DesktopAttachment {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly kind: 'image' | 'file';
  readonly mime: string;
}
export interface DesktopPreparation {
  readonly digest: string;
  readonly ids: readonly string[];
  readonly body: string;
  readonly to: string | null;
  readonly prepared: string;
}
export interface DesktopBinding {
  readonly profileId: string;
  readonly root: string;
  readonly identity: string;
  readonly originalRoot: string;
}
export interface DesktopMessageReference {
  readonly id: string;
  readonly roomId: string;
  readonly requestId: string;
  readonly body: string;
  readonly requestBinding: string;
  readonly requestReply: string;
}
export interface DesktopOperation {
  readonly id: string;
  readonly binding: string;
  readonly state: 'started' | 'completed';
  readonly result: string | null;
}
export interface DesktopUploadEvidence {
  readonly id: string;
  readonly room: string;
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Durable partial staging bytes, inert on restore. */
  readonly data: string;
}
export interface DesktopAssetInventory {
  readonly format: 1;
  readonly binding: DesktopBinding | null;
  readonly rooms: readonly string[];
  readonly messages: readonly DesktopMessageReference[];
  readonly operations: readonly DesktopOperation[];
  readonly uploads: readonly DesktopUploadEvidence[];
}
export const DESKTOP_FILE_BYTES = 10 * 1024 * 1024;
export const DESKTOP_CHUNK_BYTES = 256 * 1024;
export const desktopUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s);
export const desktopRoom = (s: unknown): s is string =>
  typeof s === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(s);
export function validDesktopAttachment(a: unknown): a is DesktopAttachment {
  if (!a || typeof a !== 'object') return false;
  const v = a as DesktopAttachment;
  return (
    desktopUuid(v.id) &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    v.name.length <= 180 &&
    !Array.from(v.name).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\',
    ) &&
    Number.isSafeInteger(v.bytes) &&
    v.bytes >= 0 &&
    v.bytes <= DESKTOP_FILE_BYTES &&
    typeof v.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(v.sha256) &&
    ['image', 'file'].includes(v.kind) &&
    typeof v.mime === 'string' &&
    v.mime.length <= 100
  );
}
/**
 * Display-only marker appended by the Desktop preparation.
 *
 * Never model authority and never model text: the runtime strips it and resolves
 * image bytes from the durable preparation operation instead.
 */
export const DESKTOP_ATTACHMENT_MARKER = '\n\n[Ocean Desktop attachments v1]\n';
export const hasDesktopAttachmentMarker = (body: string): boolean =>
  body.includes(DESKTOP_ATTACHMENT_MARKER);
/**
 * Model-visible text: everything before the first marker. Anything at or after a
 * marker is display-only evidence, so pasted marker text cannot reach a model.
 */
export function desktopAttachmentText(body: string): string {
  const index = body.indexOf(DESKTOP_ATTACHMENT_MARKER);
  return index < 0 ? body : body.slice(0, index);
}
export function decodeDesktopAttachments(
  body: string,
): { body: string; requestId: string; files: DesktopAttachment[] } | null {
  const index = body.lastIndexOf(DESKTOP_ATTACHMENT_MARKER);
  if (index < 0) return null;
  try {
    const value = JSON.parse(body.slice(index + DESKTOP_ATTACHMENT_MARKER.length)) as Record<
      string,
      unknown
    >;
    if (
      value['version'] !== 1 ||
      !desktopUuid(value['requestId']) ||
      !Array.isArray(value['files']) ||
      value['files'].length < 1 ||
      value['files'].length > 4 ||
      !value['files'].every(validDesktopAttachment) ||
      Object.keys(value).sort().join() !== 'files,requestId,version'
    )
      return null;
    return { body: body.slice(0, index), requestId: value['requestId'], files: value['files'] };
  } catch {
    return null;
  }
}
export function encodeDesktopAttachments(
  body: string,
  requestId: string,
  files: readonly DesktopAttachment[],
): string {
  return body + DESKTOP_ATTACHMENT_MARKER + JSON.stringify({ version: 1, requestId, files });
}
