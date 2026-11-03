import { resolve } from 'node:path';
import type { CodingPartialGitCapture } from './coding-git-partial.js';
import { gitDigest } from './coding-git-observer.js';
const origins = new WeakMap<
  CodingPartialGitCapture,
  { hash: string; verify: () => void; forbidden: readonly string[] }
>();
export function partialGitFingerprint(capture: CodingPartialGitCapture): string {
  const { index, pack, ...metadata } = capture;
  return gitDigest(
    JSON.stringify([metadata, index === null ? null : gitDigest(index), gitDigest(pack)]),
  );
}
export function registerPartialGit(
  capture: CodingPartialGitCapture,
  verify: () => void,
  forbidden: readonly string[],
): void {
  origins.set(capture, { hash: partialGitFingerprint(capture), verify, forbidden: [...forbidden] });
}
export function assertPartialGitOrigin(
  capture: CodingPartialGitCapture,
  destination?: string,
): void {
  const origin = origins.get(capture);
  if (!origin || partialGitFingerprint(capture) !== origin.hash)
    throw Error('stale_coding_git_storage');
  if (
    destination !== undefined &&
    (resolve(destination) !== destination ||
      origin.forbidden.some((root) => destination === root || destination.startsWith(root + '/')))
  )
    throw Error('invalid_coding_asset_destination');
  origin.verify();
}
