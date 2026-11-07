import { runModelScenario } from '../../test-fixtures/model-process-launch.js';
import { expect, it } from 'vitest';
it.each(['recovery', 'lost'])(
  'qualifies built model %s through independent Node owners and clients',
  async (scenario) => {
    const result = await runModelScenario(scenario);
    expect(result.timedOut).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ scenario });
    console.log(result.stdout.trim());
  },
  95000,
);
