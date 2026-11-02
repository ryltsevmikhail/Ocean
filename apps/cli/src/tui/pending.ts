/** Join terminal-initiated work on exit. Background observation has its own detach signal. */
export class TuiPending {
  readonly #tasks = new Set<Promise<void>>();
  track(task: Promise<void>, fail: (error: unknown) => void) {
    const guarded = task.catch(fail);
    this.#tasks.add(guarded);
    void guarded.finally(() => this.#tasks.delete(guarded));
  }
  async idle() {
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks]);
  }
}
