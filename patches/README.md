# Pinned Executor SDK patch

`@executor-js__sdk@1.6.11.patch` removes a reactive OAuth refresh + replay from
the published `@executor-js/sdk@1.6.11` bundle. It is applied by pnpm through
`patchedDependencies` in `pnpm-workspace.yaml`; the lockfile records
`patch_hash=e1c1bfa9a41049321f45747f3ae8907d89604fca06872ec0a4871483db1b9fad`.

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

Removed block, `dist/chunk-Q3W5ARXY.js` lines 10019–10042 (hunk header
`@@ -10019,24 +10019,8 @@`, block starts at byte offset 403564, 961 bytes /
18 lines):

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

## Re-derive on a version bump

The patch was produced with `diff -u` labels and no timestamps; regenerate it
rather than hand-editing:

```sh
# 1. Install the candidate version in a scratch dir and confirm the defect is
#    still present with the qualification probes (one invocation after an
#    upstream 401 must not cause two business requests).
# 2. Rewrite the bundle in place:
SDK=node_modules/@executor-js/sdk
REL=dist/chunk-Q3W5ARXY.js        # verify: grep -rl "refresh.retried" "$SDK/dist"
start='        const first = yield* invokeWith(values);'
end='        });'
python3 - "$SDK/$REL" "$start" "$end" <<'PY'
import sys
path, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
orig = open(path, encoding="utf-8").read()
assert orig.count(start) == 1, "anchor not unique"
i = orig.index(start)
j = orig.index(end, i)
replacement = "        const result = yield* invokeWith(values);\n        const usedValues = values;"
patched = orig[:i] + replacement + orig[j + len(end):]
open(path + ".patched", "w", encoding="utf-8").write(patched)
PY
diff -u --label "a/$REL" --label "b/$REL" \
  "$SDK/$REL" "$SDK/$REL.patched" > patches/@executor-js__sdk@<version>.patch
sha256sum patches/@executor-js__sdk@<version>.patch   # becomes the new patch_hash
```

Then update the pinned hashes in `packages/integrations-executor/src/pinned-identity.ts`,
the package versions, and this README.

## License

Upstream is MIT. The 1.6.11 tarballs ship no `LICENSE` file; the upstream
license text and copyright line are reproduced in the repository `NOTICE` and
in `packages/integrations-executor/LICENSE`. The patched bundle is NOT pristine
upstream bytes and is not presented as such.
