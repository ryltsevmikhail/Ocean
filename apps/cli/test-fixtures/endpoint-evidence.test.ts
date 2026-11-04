/**
 * Exact endpoint-evidence snapshot used to prove a refusal preserves every byte,
 * mode, inode, owner and timestamp in the private endpoint directory.
 *
 * Split out of `restart-refusals.test.ts` to keep that file inside the 300-line cap.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export function endpointEvidence(directory: string): unknown {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const st = lstatSync(path, { bigint: true });
      return [
        name,
        String(st.ino),
        String(st.mode),
        String(st.uid),
        String(st.mtimeNs),
        String(st.ctimeNs),
        st.isFile()
          ? createHash('sha256').update(readFileSync(path)).digest('hex')
          : st.isSymbolicLink()
            ? readlinkSync(path)
            : null,
      ];
    });
}
