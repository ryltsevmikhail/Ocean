import type { DatabaseSync } from 'node:sqlite';
/** Any finalizing/uncertain finalization still holds this project root. */
export function projectFinalizationHeld(db: DatabaseSync, projectRoot: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM ocean_coding_finalizations f JOIN ocean_coding_tasks t ON t.id=f.task_id
      WHERE t.project_root=? AND f.state IN ('finalizing','uncertain') LIMIT 1`,
      )
      .get(projectRoot) !== undefined
  );
}
