/** Explicit cursors, including byte-short pages. Never infer completeness from row count. */
export async function modelPages<T>(
  fetch: (after?: string) => Promise<{ items: readonly T[]; nextAfter: string | null }>,
  id: (item: T) => string,
): Promise<T[]> {
  const result: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after);
    let previous = after ?? '';
    for (const item of page.items) {
      const current = id(item);
      if (current <= previous) throw Error('invalid_frame');
      previous = current;
      result.push(item);
    }
    if (page.nextAfter === null) return result;
    if (!page.items.length || page.nextAfter !== previous || page.nextAfter === after)
      throw Error('invalid_frame');
    after = page.nextAfter;
  }
}
