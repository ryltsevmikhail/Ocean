/** Compile-time consumers of the exported framing constructor, including discarded return values. */
import { LocalRuntimeFrames } from '@runnets/tools-node';
const received: unknown[] = [];
new LocalRuntimeFrames((value) => received.push(value));
new LocalRuntimeFrames((value): void => {
  received.push(value);
});
new LocalRuntimeFrames((): false => false);
