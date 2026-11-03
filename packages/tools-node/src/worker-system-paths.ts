/** These host trees are mounted unchanged into every production coding worker. */
export const WORKER_SYSTEM_TREES = ['/usr'] as const;
export function workerVisibleSystemPath(path: string): boolean {
  return WORKER_SYSTEM_TREES.some((root) => path === root || path.startsWith(root + '/'));
}
