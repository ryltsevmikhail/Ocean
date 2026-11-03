/** Bound every host drain so an unknown effect is reported, not hidden by a hang. */
export async function drainBeforeDeadline(
  drain: () => Promise<'settled' | 'uncertain'>,
  deadlineMs: number,
): Promise<'settled' | 'uncertain'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      drain(),
      new Promise<'uncertain'>((resolve) => {
        timer = setTimeout(() => resolve('uncertain'), deadlineMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
