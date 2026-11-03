import { expect, it } from 'vitest';
import { ChatReviewService } from '@runnets/application';
import { createRuntime } from '../runtime.js';
import { RuntimeDecisions } from './decisions.js';
it('joins a suspended scoped review before releasing the database', async () => {
  const r = createRuntime({ mode: 'ephemeral' });
  let release!: () => void;
  class HeldReview extends ChatReviewService {
    override async review(...q: Parameters<ChatReviewService['review']>) {
      await new Promise<void>((r) => {
        release = r;
      });
      return super.review(...q);
    }
  }
  Object.setPrototypeOf(r.reviews, HeldReview.prototype);
  const d = new RuntimeDecisions(r.ownerDecisions, r.reviews),
    params = { workspaceId: 'ws_ocean', roomId: 'r', runId: 'tr_fixture', offset: 0 };
  const read = d.dispatch('reviews.get', params);
  let drained = false;
  const draining = d.drain().then(() => {
    drained = true;
  });
  try {
    await new Promise<void>((r) => setImmediate(r));
    expect(drained).toBe(false);
    expect(await d.dispatch('reviews.get', params)).toEqual({
      error: { code: 'runtime_draining' },
    });
  } finally {
    release();
    await read;
    await draining;
    r.close();
  }
});
