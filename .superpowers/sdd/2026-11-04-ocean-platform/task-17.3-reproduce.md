# Reproduce the exact Task17.3 evidence inputs

Product source stays `ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a`, Node26.13.0, pnpm12.16.1. The correction commit contains only qualification drivers/docs. No product archive rebuild or native/core rerun is needed for this correction.

Use a new owned on-disk directory. Create a clean Git worktree at the exact product revision and run `pnpm install --frozen-lockfile --offline`; preserve the pinned lockfile. Existing product candidate is `Ocean-artifacts/task-17.3-ec1e5d5`, archive SHA256 `933d0b3a535685a4606e92c91ecd970507e0d403002d2e348cfb2b304302556d`. Prior report records all product build/install/native commands and their actual counters.

`task-17.3-stage-dependencies.py SOURCE NEW_TARGET ORIGINAL_STAGED_COMPARISON OUTPUT_JSON` copies physical `.pnpm` files, retains relative internal links, removes only escaping workspace links in its owned copy, and adds TypeScript/ESLint entry links. It refuses an existing target. The saved original provenance correctly names the superseded 8e78 source; the current ec1 reproduction proved all24756 physical file contents/modes and1093 link targets identical. Do not relabel that original provenance. `fix1/dependency-tree.json` is the exact staged file/link inventory, and `fix1/dependency-reproduction.json` records the comparison and recipe argv.

The exact original `run-private.py` bytes are committed as `task-17.3-run-private.py` and also copied into every freeze's `inputs/run-private.py`. Current source path, SHA256, baseline b5b32c2 driver identities, and snapshotted current driver identities are in `inputs/provenance.json`. Every original b5 driver is recoverable from its pinned Git commit and copied under `inputs/baseline`; current correction drivers are under `inputs/current`. The shared runner creates fresh isolated HOME/XDG/TMP, forwards exit, and deletes only its own short fixture.

Focused correction commands from Ocean-stable:

```sh
python3 PLAN/run-private.py python3 PLAN/task-17.3-owner-cleanup-test.py Q/fix1 --legacy
python3 PLAN/run-private.py python3 PLAN/task-17.3-owner-cleanup-test.py Q/fix1
python3 PLAN/task-17.3-stage-dependencies.py Q/source NEW_TARGET Q/sandbox-dependencies OUTPUT_JSON
```

Legacy is an intentional RED: one failed never-ready case, two nonlegacy cases skipped, outer supervisor bounds and reaps its fake group. GREEN runs all three cases; it never invokes product state. Actual corrected installed rebind is an optional positive integration check: use the report's command with `OCEAN_QA_REHEARSAL_NAME` set to a **new** basename and `OCEAN_QA_REBIND_PROOF` to a new proof path. It does not retry an existing unknown operation.

`task-17.3-freeze-run.py Q NEW_FREEZE_DIR` snapshots driver/runner inputs, invokes the snapshotted core under the copied private runner, captures raw stdout/stderr/argv/cwd/exit, then writes `seal.json`. Core inventory explicitly lists the actual TTY screen, decision/selection and CLI command ledgers, host commands, dependency provenance/recipe result, intended logs and correction proofs. Scratch Git reflogs are not selected. No output hashes itself: core inventory omits invocation/result/seal, and seal hashes the invocation/result/inventory only. The immutable raw seal and inventory SHA256 values are pinned in the committed qualification report/product record.

`task-17.3-evidence-validate.py Q FREEZE_DIR EXPECTED_SEAL_SHA256` checks that external anchor, all sidecars, exact required file set, all listed bytes, actual displayed decision/digest, runner identity, and dependency reproduction. `task-17.3-evidence-test.py Q FREEZE_DIR EXPECTED_SEAL_SHA256` copies only evidence files to a new owned test directory and proves TTY/runner tampering, command-ledger omission, and sidecar tampering invalidate the chain; candidate/runtime/profile data remain untouched.
