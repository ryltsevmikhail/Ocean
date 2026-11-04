# Pinned Executor SDK patch

`@executor-js__sdk@1.6.11.patch` removes a reactive OAuth refresh + replay from
the published `@executor-js/sdk@1.6.11` bundle. It is applied by pnpm through
`patchedDependencies` in `pnpm-workspace.yaml`; the lockfile records
`patch_hash=e1c1bfa9a41049321f45747f3ae8907d89604fca06872ec0a4871483db1b9fad`.

Date: **2026-11-04** (qualification date; patch authored the same day).

## Why

`executor.execute(address, args)` re-invoked the plugin after an upstream HTTP
401 when the connection was refreshable OAuth: it called
`forceRefreshConnectionValues` and then dispatched a **second business
request** with the refreshed token, bypassing policy, approval, annotation and
argument validation. One allowed invocation therefore caused two upstream
writes, and the caller saw only the second result. `1.6.11` (2026-10-22) is the
newest published release of all three `@executor-js` packages and contains no
fix; the only newer line (2.1.0-beta.0) is a hosted-platform client and 2.0.0 is
an older divergent branch. The patch is the minimum-blast-radius qualified
option for RC2 (see the qualification report).

The patch keeps the proactive (pre-dispatch) refresh on expiry; it removes only
the reactive refresh-and-replay after a failure.

## Hunk

Removed block: pristine `dist/chunk-Q3W5ARXY.js` lines **10022–10039** (18
lines removed; the anchor line `        const first = yield* invokeWith(values);`
is line 10022 and the closing `        });` is line 10039). The replaced span
starts at character offset 403564 (the chunk is ASCII, so the byte offset is
identical); the hunk header is `@@ -10019,24 +10019,8 @@`
(three context lines before, three after). It is the only runtime copy:
`grep -rl "refresh.retried" node_modules/@executor-js/sdk/dist` matches only
`dist/chunk-Q3W5ARXY.js` (and its map).

```diff
-        const first = yield* invokeWith(values);
-        const { result, usedValues } = yield* Effect12.gen(function* () {
-          if (!isUnauthorizedToolFailure(first)) return { result: first, usedValues: values };
-          const refreshed = yield* forceRefreshConnectionValues(connectionRow).pipe(
-            ...
-            Effect12.catchTag("CredentialResolutionError", () => Effect12.succeed(null))
-          );
-          if (!refreshed) return { result: first, usedValues: values };
-          yield* Effect12.annotateCurrentSpan({
-            "executor.oauth.refresh.retried": true
-          });
-          return {
-            result: yield* invokeWith(refreshed),
-            usedValues: refreshed
-          };
-        });
+        const result = yield* invokeWith(values);
+        const usedValues = values;
```

## Identity

| Item                 | Value                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Package              | `@executor-js/sdk@1.6.11`                                                                         |
| Tarball integrity    | `sha512-CKdvjdf3zgUiId+gpIxtAFmr6L8lPoIyrp7MoR35MnQhiTI00b+syOxTw8iLXRkMsRM755629dXp/AwPkjv7Jg==` |
| Tarball shasum       | `f232d29b473b340d2e4b1a3aacdf653f3ace3867`                                                        |
| Patched file         | `dist/chunk-Q3W5ARXY.js`                                                                          |
| Original file sha256 | `4fd9504fb58aa5aaf509f1007892550f16a65cc3408948a92c7ad5064685cd82`                                |
| Patched file sha256  | `6d3d22c97454dde48daacce07d901b174a642a480efee0b8c73fe31aa6d3a0b9`                                |
| Patch file sha256    | `e1c1bfa9a41049321f45747f3ae8907d89604fca06872ec0a4871483db1b9fad` (`sha256sum`)                  |
| Applied by           | `pnpm` 12.16.1, `patchedDependencies`                                                             |

The adapter runtime asserts the installed chunk hash at startup and fails
closed on any mismatch; a regression test also proves the assertion refuses a
wrong hash. When the pin moves, re-derive the patch instead of editing it.

## Re-deriving the patch on a version bump (verified procedure)

This procedure was re-run from a freshly downloaded `@executor-js/sdk@1.6.11`
tarball and regenerates the committed patch **byte-for-byte** (patch sha256
`e1c1bfa9…`, patched chunk sha256 `6d3d22c9…`). It is line-anchored: the end
marker must be a line matching the regex `^        \}\);$` (the exact
`        });` line at pristine line 10039), because a substring match would
truncate the block inside the 10-space-indented `          });` that closes
`annotateCurrentSpan` and produce a syntactically broken chunk (reviewer
measurement of that broken attempt: chunk sha256 `d51f6845…`, patch `2e1799b3…`).

```sh
# 0. Fresh pristine bundle (npm registry only; no repository bytes needed).
mkdir -p /tmp/rederive/tar && cd /tmp/rederive/tar
npm pack @executor-js/sdk@<version> --silent
tar -xzf executor-js-sdk-<version>.tgz
sha256sum package/dist/chunk-Q3W5ARXY.js
# 1.6.11 pristine chunk must be 4fd9504fb58aa5aaf509f1007892550f16a65cc3408948a92c7ad5064685cd82

# 1. Build the a/ and b/ trees (git-format patch prefixes).
mkdir -p /tmp/rederive/work/a/dist /tmp/rederive/work/b/dist
cp package/dist/chunk-Q3W5ARXY.js /tmp/rederive/work/a/dist/chunk-Q3W5ARXY.js
cp package/dist/chunk-Q3W5ARXY.js /tmp/rederive/work/b/dist/chunk-Q3W5ARXY.js

# 2. Replace the block in place; anchors are EXACT lines (the closing line has
#    eight leading spaces, not ten).
python3 - <<'PY'
path = '/tmp/rederive/work/b/dist/chunk-Q3W5ARXY.js'
lines = open(path, encoding='utf-8').read().split('\n')
start = '        const first = yield* invokeWith(values);'
end = '        });'
starts = [i for i, line in enumerate(lines) if line == start]
assert len(starts) == 1, starts
i = starts[0]
j = next(j for j, line in enumerate(lines) if j > i and line == end)
print(f'removed pristine lines {i + 1}-{j + 1} ({j - i + 1} lines)')
replacement = [
    '        const result = yield* invokeWith(values);',
    '        const usedValues = values;',
]
open(path, 'w', encoding='utf-8').write('\n'.join(lines[:i] + replacement + lines[j + 1:]))
PY
sha256sum /tmp/rederive/work/b/dist/chunk-Q3W5ARXY.js
# must be 6d3d22c97454dde48daacce07d901b174a642a480efee0b8c73fe31aa6d3a0b9

# 3. Generate the git-format patch with a/ b/ prefixes (NOT `diff -u`: the
#    committed patch has git headers and an index line).
cd /tmp/rederive/work
mkdir -p patches
git diff --no-index --no-prefix a/dist/chunk-Q3W5ARXY.js b/dist/chunk-Q3W5ARXY.js \
  > patches/@executor-js__sdk@<version>.patch
sha256sum patches/@executor-js__sdk@<version>.patch
# for 1.6.11 must be e1c1bfa9a41049321f45747f3ae8907d89604fca06872ec0a4871483db1b9fad

# 4. Verify the patch applies to a pristine extract and yields the pinned chunk.
#    (`npm pack` tarballs extract under package/, so patch from inside it.)
mkdir -p /tmp/rederive/apply && cd /tmp/rederive/apply
tar -xzf /tmp/rederive/tar/executor-js-sdk-<version>.tgz
cd package
patch -p1 < /tmp/rederive/work/patches/@executor-js__sdk@<version>.patch
sha256sum dist/chunk-Q3W5ARXY.js   # 1.6.11: 6d3d22c9…
```

Then update the pinned hashes in
`packages/integrations-executor/src/pinned-identity.ts` (chunk sha256, patch
sha256, versions), the package versions, the lockfile (`pnpm install`) and this
README. The runtime assertion and the `imports.test.ts`/`guards.test.ts`
regressions will refuse to qualify if any hash is stale.

## Behaviour after the patch (request counters)

Measured with real loopback HTTP servers; a business request is counted inside
the server request handler:

| Scenario                                   | Pristine 1.6.11                      | Patched                              |
| ------------------------------------------ | ------------------------------------ | ------------------------------------ |
| Refreshable OAuth connection, business 401 | business **2**, refresh grants **1** | business **1**, refresh grants **0** |
| Static credential 401                      | business 1                           | business 1                           |
| Double 401                                 | business 2                           | business 1                           |
| Dropped response after a server-side write | business 1                           | business 1 (classified uncertain)    |
| Success                                    | business 1                           | business 1                           |

## License

Upstream is MIT. The 1.6.11 tarballs ship no `LICENSE` file; the upstream
license text and copyright line are reproduced in the repository `NOTICE` and
in `packages/integrations-executor/THIRD_PARTY_LICENSES/executor-MIT.txt`. The
patched bundle is NOT pristine upstream bytes and is not presented as such.
