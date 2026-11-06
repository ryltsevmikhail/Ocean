# C18.5.3.1 — shared owner client and recoverable settings projections

Status: **DONE_WITH_CONCERNS**. Implementation and final frozen verification are complete; only protected catalog3/format2 remain. Independent controller review of BASE..HEAD is required before C18.5.3.2; no Desktop work was started.

## Scope and interfaces

BASE `2029106c76b704740ffdcf46ac5df338da23fe5d`; branch `codex/ocean11-stable`; checkout `/home/ryltsevmg/Projects/Ocean-stable` only. No agents/helpers/reviewers, push, merge, real credentials/profiles, live model/service traffic, installation or launcher/user-unit changes were used.

The existing `LocalRuntimeClient` now exposes the eight accepted settings operations plus history:

- `serviceConnections()` → connection metadata with tools/readiness.
- `serviceGrants()` → validated owner grant records.
- `serviceReceipt({requestId})` → the existing receipt shape or null.
- `setServiceConnection(request)`, `disconnectServiceConnection(request)`, `refreshServiceConnection(request)`.
- `setOwnerScopeGrant(request)`, `revokeOwnerScopeGrant(request)`.
- `listServiceOwnerOperations({after?,limit?,state?})` → `{items,next}`.

Hello now advertises `service.authority-v2` in the existing authenticated connection. The thin service wrapper uses public contracts, `validatedParams` and copied inputs before awaiting replies; checks marker/method support locally; validates outputs, request IDs/methods/targets, page state/order/cursor; and grants metadata refresh 20000ms framing slack around the owner's existing 15000ms discovery deadline. Missing history support returns `service_operations_upgrade_required`; missing accepted-method support returns `service_runtime_upgrade_required`. Profile/instance correlation remains in the existing descriptor/hello path; no alternate socket or policy engine exists. Request-ID ordering uses UTF-8 bytes to match SQLite BINARY order, including supplementary Unicode. No credential bytes are cached or logged by the wrapper.

Public output DTOs/validators are in contracts `local-service-views.ts`; domain `service-owner-operations.ts` holds only pure keyless intent/query types and guards. Application imports domain and ports, never contracts. Existing record guards validate connections, grants and snapshots. Connection replies lacking readiness normalize to `unknown`, never `ready`. Existing old-client feature negotiation, ACP and `decisions.service-v1` paths remain separate and unchanged.

## Persistence, bounds and recovery

The existing receipt JSON gains only optional `operation`. Set intent is exactly `{method:'service.connection-set',input:Omit<ServiceConnectionSetRequest,'key'>,requiresKey:boolean}`; refresh is `{method:'service.connection-refresh',input:ServiceConnectionRequest,requiresKey:false}`. Original request IDs, expected versions and keyless input are cloned before private/external effects. Storage validates optional metadata and preserves it through completion. Historical rows without it remain valid. No schema version/table, credential mutation rule, provider behavior, tool/model permission or SDK dependency changed.

`service.receipt` still returns only requestId/method/state/result/recovery, with its original keyless result snapshot. History items carry requestId/method/state/recovery/targetId/operation; optional private storage `secretReference` and binding never enter them. Legacy prepared target/operation are null; validated completed results supply historical target IDs. The old prepared fact never becomes completed merely because a later explicit recovery succeeds.

History queries accept exactly after/limit/state; default 50, range 1..100, absent/prepared/completed state. SQL filters owner/state and request ID before LIMIT and receipt parsing. At most limit+1 receipts (maximum101) are expanded for lookahead inside the existing immediate transaction. Application stops at limit or the 400000 canonical-character budget, reserves 300 characters for envelope/cursor and returns the last actually emitted ID only when more matching rows may exist. It never advances past the first omitted item. The existing 2MiB frame and131072-byte stored receipt bounds remain.

C5.1M1 is resolved in this touched path: optional metadata queries perform owner filtering and LIMIT (1..100) in SQL before validating/expanding connection/grant rows. No-argument core enumeration is unchanged. Connection views read catalogs only until the character bound is reached, then break before any later catalog reads (one candidate is needed to determine that the next item exceeds the bound). Tests count those reads and poison rows outside owner/limit to prove actual SQL bounds rather than final array length.

Readiness is ready/disconnected/metadata_required/unavailable/unknown. Normal composition supplies the existing read-only `transport.ready` restricted by restored/draining lifecycle. No catalog → metadata_required; disconnected → disconnected; a current catalog without a supplied readiness port → unknown; supplied false → unavailable. A retired current session with durable active/catalog rows is unavailable. This grants no discovery, claim or tool permission; actual C3 remains authoritative.

The actual authenticated-runtime test creates a new connection with no live connection row after a real private-store publication failure. After closing both client and owner, a second shared client rediscovers the original UUID, target and exact keyless intent; exact replay stays prepared and changed payload is refused. Reads leave private bytes unchanged, no catalog/business invocation rows appear, grants stay empty and provider is disabled. An explicit new request with resupplied material succeeds while the original receipt stays prepared. Existing SQLite/private-store interruption tests additionally count one publication across replay, cover post-private-effect final SQLite failure and preserve unrelated provider material. Refresh tests capture intent before discovery, retain prepared state across a new facade and never invoke discovery again on replay.

## RED → GREEN chronology and commands

Early RED/GREEN commands and the first root attempt used this custom prefix:

```sh
TMPDIR=/home/ryltsevmg/Projects/Ocean-artifacts/c18531-owner-client-20261106 python .superpowers/sdd/2026-11-04-ocean-platform/run-private.py COMMAND
```

Final diagnosis/gates instead use the supplied runner unchanged with its default short `/tmp` roots, without the custom TMPDIR assignment:

```sh
python .superpowers/sdd/2026-11-04-ocean-platform/run-private.py COMMAND
```

The log/proof directory is a fresh direct child of `/home/ryltsevmg/Projects/Ocean-artifacts`. The supplied runner creates a fresh private HOME, all XDG roots and TMP with minimal environment for each invocation; no environment/key output was captured. Below, log/exit names are relative to that proof directory.

| Command | Exit / actual result | Evidence |
| --- | --- | --- |
| `pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/local-runtime/service-owner-client.test.ts` | 1;2 expected failures: actual authenticated shared client lacks setServiceConnection property; no missing import/compiler error | red.log/red.exit |
| Above consumer test plus `packages/store-sqlite/src/service-owner-settings.test.ts` | 0;7 passed/2 files | green-first.log/green-first.exit |
| `pnpm typecheck` first pass | 2;self-review found union result target selection used the wrong discriminant for catalogs; corrected connectionId-vs-id branch | typecheck-first.log/typecheck-first.exit |
| `pnpm exec vitest run --config vitest.source.config.ts packages/tools-node/src/local-service-client.test.ts packages/store-sqlite/src/service-owner-views.test.ts` | 0;9 passed/2 files | projections-client.log/projections-client.exit |
| `pnpm typecheck:tests:node` | 0 | tests-strict-first.log/tests-strict-first.exit |
| `pnpm exec vitest run --config vitest.source.config.ts packages/contracts/src/local-service-views.test.ts` | 1;1 failed/2 passed: sparse array incorrectly normalized to [undefined]; fixed dense validation | contracts-red.log/contracts-red.exit |
| Five new owning source files, before final typed-grant/Unicode coverage | 0;16 passed/5 files | green-recovery.log/green-recovery.exit |
| `pnpm exec vitest run --config vitest.source.config.ts packages/tools-node/src/local-service-client.test.ts` | 1;1 failed/5 passed: JS UTF-16 ordering refused a valid SQLite-ordered Unicode page; fixed UTF-8 comparison | cursor-red.log/cursor-red.exit |
| Scoped ESLint on new/touched production paths and example | 1;only2 no-undef failures for missing process import in new example; corrected before frozen gates | lint-first.log/lint-first.exit |
| Five final owning source files | 0;18 passed/5 files | green-complete.log/green-complete.exit |
| `pnpm typecheck` after all source corrections | 0 | strict.log/strict.exit |

The five owning files are `apps/cli/src/local-runtime/service-owner-client.test.ts`, `apps/cli/src/runtime-service-views.test.ts`, `packages/contracts/src/local-service-views.test.ts`, `packages/store-sqlite/src/service-owner-views.test.ts`, and `packages/tools-node/src/local-service-client.test.ts`. Tests exercise the real authenticated host/SQLite/private store, owner projections, pure guards and wrapper validation boundaries; no network beyond synthetic loopback fixtures is permitted by the existing source setup.

Formatting was limited to explicitly owned paths (`pnpm exec prettier --write` with the27-path list in owned-paths.txt), plus the example after its process import correction; both exit0. The initial27-path source was frozen in frozen-pins.txt before the first root gates; the final29-path source (only two required compatibility test expectation corrections added) was frozen in frozen-pins-final.txt before the final gates. No protected foreign file was formatted or staged.

## Root diagnosis and final frozen gates

The first custom-prefix `pnpm check` (root-check.log/root-check.exit) exited1: production and both test typechecks plus ESLint passed, source ended3729 passing/32 failing/44 configured skips;560 passing/6 failing/17 skipped files, one unhandled error;176.39s. This was a real failed run, preserved unabridged and not claimed as accepted debt. Its failures were:

- Protected catalog3.
- Three exact hello expectations in local-plugin-compatibility.test.ts omitted the newly required service.authority-v2 feature; one model-negotiation.test.ts assertion expected76 total owner capabilities rather than77 after adding service.owner-operations. Only these literal expectations changed, preserving all assertion strength.
- Twenty-two existing binder-failure cases and two existing local-runtime-security cases were broken by the custom long TMP prefix. The raw boundary.sock path was119 bytes, beyond Linux Unix-socket pathname capacity; source logs show EINVAL. The overlong XDG path selected the existing /tmp fallback; the hardlink test then crossed from btrfs (`/home/.../Ocean-artifacts`) to tmpfs (`/tmp`) and receivedEXDEV. The frame-boundary listen also emitted one unhandled EINVAL. No product or native check was relaxed.
- The unchanged backup-publication mmap test at line249 observed changed mtimeNs/ctimeNs on the btrfs-backed custom TMP area, although inode/size were stable. This test specifically prewarms a writable mmap page and expects later corruption to leave stat metadata unchanged. Its integrity checks and source were untouched; the filesystem-sensitive stat assumption was investigated using the normal tmpfs private runner roots.

Systematic-debugging investigation read the full failure stacks and test paths, checked actual filesystem types (`stat -f`: /tmp tmpfs; artifacts btrfs), computed the119-byte path, and changed only the private runner's outer TMP location. The supplied run-private.py was never edited. The focused existing security+binder+backup-publication files then passed43/43 across3files, exit0 (short-root-diagnosis.log/.exit), duration11.46s, using the default short roots. This confirms the observed environment difference; no general btrfs/native qualification claim is made. The two exact compatibility expectation updates then passed4/4 across2files, exit0 (compatibility-green.log/.exit). Four failures were source-expectation corrections required by this feature; the environment failures are not mislabeled as source regressions. Initial and final private roots are not interchangeable evidence.

The first root formatter exited1 with exactly the two protected files (root-format.log/.exit). Final root gates and affected process results follow below.

All final commands below used the unchanged supplied runner with default short `/tmp` roots, no custom TMPDIR prefix, on the29-path frozen final source:

| Command | Exit / exact outcome | Evidence |
| --- | --- | --- |
| `pnpm check` | **1**; production typecheck, both node/desktop test typechecks and lint pass; **3758 passed/3 protected failed/44 configured skipped tests**,565 passed/1 failed/17 skipped files;no unhandled errors;126.12s | root-check-final.log/root-check-final.exit |
| `pnpm build` | **0** | root-build-final.log/root-build-final.exit |
| `pnpm format:check` | **1**, exactly the two protected foreign files | root-format-final.log/root-format-final.exit |
| `pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/service-owner-process.test.ts apps/cli/src/local-runtime/service-confirmation-process.test.ts packages/tools-node/src/local-runtime-types.test.ts` | **0**,3 passed/3 files;3.38s | process-final.log/process-final.exit |
| `node /home/ryltsevmg/Projects/Ocean-artifacts/c18531-owner-client-20261106/example-smoke.mjs` | **0**, actual independent read-only example against a fresh synthetic built host; zero connections/catalogs/receipts/business-invocations and no credential store created | example-smoke.log/example-smoke.exit |

The root process stage is unreachable because check stops at protected source3. The three affected process controls were therefore run directly after the successful final build: independent public-client detach/restart receipt replay/history, SIGKILL confirmation recovery preserving one uncertain business effect without replay, and public framing callbacks under strict TypeScript. The example smoke uses built init/host plus the actual public-entry example child, not another socket implementation. No source test skip/exclusion was added;44 pre-existing configured skips are reported as skips. No repeated unchanged package/native/live/GUI matrix was run. The failed first environment and all outputs remain preserved.

`git diff --check` passed. All29 owned path hashes/line counts were rechecked after gates; every owned source is at most282 physical lines. Both protected hashes/index states remained exact and the index was empty before explicit owned staging. Normal fixture/runner cleanup only was performed; no unknown fallback object was inferred clean or removed in bulk.

Exact failed test names from the initial run:

- apps/cli/src/plugin-catalog-lifetime.test.ts > uses the published catalog beyond the SDK TTL without automatic discovery
- apps/cli/src/plugin-catalog-lifetime.test.ts > does not refresh an explicitly stale SDK catalog outside owner discovery
- apps/cli/src/plugin-catalog-lifetime.test.ts > cannot let a delayed stale refresh outlive the foreground invocation
- packages/tools-node/src/local-plugin-compatibility.test.ts > checks 'old plugin owner' during hello before any command or effect
- packages/tools-node/src/local-plugin-compatibility.test.ts > checks 'repaired plugin owner' during hello before any command or effect
- packages/tools-node/src/local-plugin-compatibility.test.ts > checks 'minimal non-plugin peer' during hello before any command or effect
- packages/tools-node/src/local-runtime-security.test.ts > refuses a hardlink descriptor before reading its credential
- packages/tools-node/src/local-runtime-security.test.ts > writes an exact 2MiB JSON frame plus its delimiter to a draining peer
- apps/cli/src/ocean/profile-backup-publication.test.ts > refuses pre-warmed mmap corruption of copied SQLite during the final source reader
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on missing interpreter failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on failed interpreter failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on before transfer failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on after transfer failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on wrong listening inode failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on transparent relay failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on wrong peer failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on short peer failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on empty peer failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on failed probe failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on probe credential short failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on probe credential long failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on probe credential pid failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on probe credential uid failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on probe credential gid failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on probe credential unavailable failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on peer credential short failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on peer credential long failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on peer credential pid failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on peer credential uid failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on peer credential gid failure
- apps/cli/src/local-runtime/binder-failure.test.ts > preserves unproved names and disposes the bootstrap and listener on peer credential unavailable failure
- apps/cli/src/local-runtime/model-negotiation.test.ts > projects independent RC2/A3/model capability identities without shared negotiation state

## Protected state and self-review

The protected tracked fixture remains SHA256 `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031`, index blob `b3ff4f26b9f1fd0a66ce72776474eccd81867b34`, modified and unstaged. The protected untracked `apps/cli/src/plugin-catalog-lifetime.test.ts` remains SHA256 `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`, untracked with no index entry. Exact hashes/index and empty pre-staging state were checked at freeze and after the final gates; post-commit evidence is recorded below. No add-A/stash/reset/clean/checkout was used.

Self-review checked layer imports, public entry points, receipt reply compatibility, no prepared replay or read side effects, original keyless intent, filtering before expansion, early catalog stop, page cursor non-skipping, owner scope, bounded DTO guards, negotiated method support, absent readiness normalization and physical source lines. A read-only independent example and reproducible commands are in `examples/local-service-owner-read.mjs` and `docs/integration/local-service-owner-client.md`; ESLint receives one explicit example entry under the existing JavaScript/test override.

Installed TypeScript/package qualification debt remains F. Node/pnpm/compiler used are v26.13.0 /12.16.1 /5.9.3 (node-version.log,pnpm-version.log,ts-version.log, all exit0). No package/GUI/native/live matrix was rerun here. OpenAI/Anthropic live gates remain deferred. All other deferred Minors remain F.

## Owned source pins

SHA256, physical lines, path (frozen before final root gates):

```text
0c570b5ee1c771aa96fbc7710b2392d52e8f605fa5650f9c17b00906934adcb6 31 apps/cli/src/local-runtime/model-negotiation.test.ts
9438bdf977b8e5e88dd2f80cc299e01c15977e380af2f618d81c4c726cefbe0c 44 apps/cli/src/local-runtime/restoration-check.ts
5f59f547e0bd3e64a61c963786ed866590c0981b5ccdd0c30576bad387b922d6 197 apps/cli/src/local-runtime/service-owner-client.test.ts
fdc7e07a128676c03ddc0b754259d2b48cbd4be5327bd1f6f883ecbd5d3db65d 52 apps/cli/src/local-runtime/service-owner-process.test.ts
41f1f1e3aabde5f8ad911c6e9efebc5a2b7a107c3ea6cd56065af4c27fcd5a0b 114 apps/cli/src/local-runtime/services.ts
2e9fbd00856188480f0bec6165ed98809220950df22dafdc99cacd17f94890d2 57 apps/cli/src/runtime-service-views.test.ts
ddab8fa41208a19dc588218d1c1d419ce59d8864bc73a5520c09f03c93ba02ad 245 apps/cli/src/runtime-services.ts
c2badd091c7f1e67962a46722b15612f86eb6eafd338e1ca98e2439a66242b63 71 docs/integration/local-service-owner-client.md
ff1a7a24a8a87b3d3cded974f7b1ee9363487ef1222ac3b389ed12c0100a40f5 57 eslint.config.mjs
30eba148f85420163cf072d07745fb9bf477278d6d387c33970d8fcfe3c3a7a6 23 examples/local-service-owner-read.mjs
98cd7e40b53a00f6d2f8b7f74410415c1def824a2a61d769a041de4e4f091e62 54 packages/application/src/service-authority-ports.ts
26a107cf7169e8620fc43f2ae751dba176970d96d6335da2a08ea14f0510fae7 33 packages/application/src/service-owner-receipt.ts
feacc2df86d1882c57086b80616a4d0b35fd06c91429ab82cf133bf55acc8e92 282 packages/application/src/service-owner-settings.ts
fb5b10a3ba402216d9be8ce49c0e81219d133e29f555b35ab791ba80d187b2e3 76 packages/application/src/service-owner-views.ts
cee799fc1945ef914041f9eb9eb778cc91dd86dacdb58a33063e92c997774e97 41 packages/contracts/src/index.ts
0f16065133090a899c056065333544fb82f2513077896fb8788d4357f124756f 88 packages/contracts/src/local-service-views.test.ts
2b0ea930df101b9f3ce03d4e1d2db2c20238a6a06a4d2fbcb5b920a0f7657fd5 151 packages/contracts/src/local-service-views.ts
91ae2c84b7e0dfe1756e366d486e3b0c9c9bfbfcf4b5caad55244ec52b5cfea5 29 packages/contracts/src/local-services.ts
76f6fd1969888d08b6b2bdfa94387a9cd48219630e7a0dc7d77cc6e7713f909a 87 packages/domain/src/index.ts
e6ba43641ef57066abdef0951696193fb785e55de124dd6275d72551f75ec92f 52 packages/domain/src/service-owner-operations.ts
5191f8611aa9dc6f965ae665b68a86528506d4456b1d6133c826bfcb55705d4b 79 packages/store-sqlite/src/service-authority-rows.ts
07f2b165abc21e75437e936bf20654535972e9d773c8eef7cc70313836846348 247 packages/store-sqlite/src/service-authority-storage.ts
40bb14f7557ff0a141bf0761eb729406ec6eb5e8142d2868797079cf221fb174 90 packages/store-sqlite/src/service-owner-receipts.ts
efbf45dae6ae465f2d452aa0a273ede04a8ee586e27417497e54be48ae374c00 218 packages/store-sqlite/src/service-owner-views.test.ts
b8b3156b5fca3291c31d9a008f19fb19b3398f6cd41f8e65ac994e84a4deb712 179 packages/tools-node/src/index.ts
35b9bbc1dd10980b5b6c2218a2410adb5ab033a4274e1cafd168f6eb09aef296 86 packages/tools-node/src/local-plugin-compatibility.test.ts
b2074708368070e5d636a490e744a8ffa20f0b8d72b5a28727a9dab819dc6481 263 packages/tools-node/src/local-runtime-client.ts
912c7ddfddf77ddda88913c8050e831f3ec9d5cde65eee06645bc15bc8d1f045 161 packages/tools-node/src/local-service-client.test.ts
b077bad9934d8f7cd31ff3072d058e4a4c7971169d79a7948b69916dee09b24b 161 packages/tools-node/src/local-service-client.ts
```

## Commits and review handoff

Source commit: `bfe198af8db819a5400c7c3cb625dbe23402835e` — `feat: expose recoverable service owner settings client`. Exactly the29 source/docs/example/config paths in the final pins were staged explicitly; protected files were excluded and no proof scripts/logs/transcripts were staged. The report is committed separately by its exact ignored path.

Post-source-commit worktree contains only the original protected tracked modification and protected untracked test; the index is empty, the tracked protected index blob remains `b3ff4f26b9f1fd0a66ce72776474eccd81867b34`, and both protected byte hashes match. Source pins remain unchanged after all gates. Nothing was pushed or merged.

Controller handoff: independently review `2029106c76b704740ffdcf46ac5df338da23fe5d..HEAD`, with the29-path final source manifest and complete report. Acceptance is pending that fresh review. Desktop18.5.3.2 remains unstarted/provisional until acceptance. Residual concerns are only protected catalog3/format2 through18.6, installed TS/package debtF, and separately deferred GUI/native/live qualification; the initial custom-TMP failures are fully preserved and superseded by the final source gates, not suppressed.
