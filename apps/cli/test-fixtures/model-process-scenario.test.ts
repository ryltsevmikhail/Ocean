import { recovery } from './model-process-recovery.test.ts';
import { lostReply } from './model-process-lost.test.ts';
import { compatibility } from './model-process-compatibility.test.ts';
import { oldHosts } from './model-process-old.test.ts';
import { metadata } from './model-process-metadata.test.ts';
import { execution } from './model-process-execution.test.ts';
import { categories } from './model-process-categories.test.ts';
import { cli } from './model-process-cli.test.ts';
import { policy } from './model-process-policy.test.ts';
import { timeout } from './model-process-timeout.test.ts';
const scenarios: Record<string, () => Promise<unknown>> = {
  recovery,
  lost: lostReply,
  compatibility,
  old: oldHosts,
  metadata,
  execution,
  categories,
  cli,
  policy,
  timeout,
};
import { closeFixtures } from './model-process-lifecycle.ts';
process.once('SIGTERM', () => {
  void closeFixtures().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
const scenario = process.argv[2]!;
try {
  const result = await scenarios[scenario]!();
  console.log(JSON.stringify({ scenario, result }));
} finally {
  await closeFixtures();
}
