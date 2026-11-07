import { expect, it } from 'vitest';
import { runModelScenario } from '../../test-fixtures/model-process-launch.js';
it.each(['mixed', 'mixed-restart', 'mixed-projection', 'mixed-restore'])(
  'qualifies built independent owner/client %s with synthetic origin counters and durable witnesses',
  async (scenario) => {
    const result = await runModelScenario(scenario);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ scenario });
    console.log(result.stdout.trim());
  },
  95000,
);
