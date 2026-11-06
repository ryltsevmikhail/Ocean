import type { DatabaseSync } from 'node:sqlite';
/** Distinct room holds include stopped roots whose marked slices still require cleanup. */
export function roomTaskHeldRooms(db: DatabaseSync, version: number): number {
  if (version < 27)
    return Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM ocean_chat_turns WHERE status IN ('accepted','dispatching','prepared','uncertain') AND review_id IS NULL",
        )
        .get()?.['n'],
    );
  return Number(
    db
      .prepare(
        `SELECT count(*) AS n FROM (
    SELECT room_id FROM ocean_chat_turns
      WHERE status IN ('accepted','dispatching','prepared','uncertain')
      AND (review_id IS NULL OR json_extract(payload,'$.roomDelivery') IS NOT NULL)
    UNION SELECT room_id FROM ocean_room_tasks WHERE id=root_id AND status IN ('ready','waiting','paused')
  )`,
      )
      .get()?.['n'],
  );
}
