import { recovery } from './model-process-recovery.test.ts';
import { lostReply } from './model-process-lost.test.ts';
import { compatibility } from './model-process-compatibility.test.ts';
import { oldHosts } from './model-process-old.test.ts';
import { metadata } from './model-process-metadata.test.ts';
import { execution } from './model-process-execution.test.ts';
import { categories } from './model-process-categories.test.ts';
import { cli } from './model-process-cli.test.ts';
const scenarios: Record<string, () => Promise<unknown>> = {
  recovery,
  lost: lostReply,
  compatibility,
  old: oldHosts,
  metadata,
  execution,
  categories,
  cli,
};
const scenario = process.argv[2]!;
const result = await scenarios[scenario]!();
console.log(JSON.stringify({ scenario, result }));
