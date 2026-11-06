# C18.5.1 worker report

Status: **DONE_WITH_CONCERNS — implementation committed; acceptance awaits the controller's independent review of BASE..HEAD.** This worker did not obtain a reviewer, push or merge. The three protected catalog failures and two protected formatting files remain unchanged.

Worktree: `/home/ryltsevmg/Projects/Ocean-stable`, branch `codex/ocean11-stable`.
Requirements: `task-18.5.1-brief.md` only, including its appended constraints.
BASE: `4dcc286eb097ec91fdced67b2f30f43fd06c151c`.
Source commit: `445011ddde4878f14ab36d46b707cfd4c6f7dd4f` (`feat: add durable owner service settings and credential binding`). This report is committed separately after that source checkpoint.

## Delivered API and ownership

`ServiceOwnerSettings` in application owns injected owner identity, time, SHA256, the existing authority store and the existing private provider-secret port. Its public facade is `connections()`, `grants()`, `receipt(requestId)`, `setConnection(request)`, `disconnect(request)`, `refreshConnection(request, signal?)`, `setGrant(request)` and `revokeGrant(request)`.

`RuntimeServices.owner` now exposes that facade. Existing `refresh(connectionId, signal?)` remains available to the trusted host. The wire never serializes the facade, stores, transport or `OwnerScopeService`.

The authenticated socket advertises `service.authority-v2` and supports:

- `service.connections`, `service.grants`: exact empty-object queries.
- `service.receipt`: exact `{requestId}`.
- `service.connection-set`: exact `{requestId,connectionId,expectedVersions,name,configuration,metadataPermission,key?,removeKey?}`.
- `service.connection-disconnect`, `service.connection-refresh`: exact `{requestId,connectionId,expectedVersions}`.
- `service.grant-set`: exact `{requestId,expectedRevision,intent}` using existing `OwnerScopeIntent`.
- `service.grant-revoke`: exact `{requestId,grantId,expectedRevision}`.

Extra keys are refused, including asserted owner/trust/account evidence. Connection creation alone accepts a null version tuple; grant creation alone accepts a null revision. The runtime injects owner identity. Feature negotiation describes wire support and cannot grant account or bot authority. Clients without the explicit new feature receive no service capabilities and cannot call these methods. RC2/A3/model projections retain their old bounds; the current identity validator admits the larger negotiated capability list.

Pure request DTOs and validators live in domain and are exported through contracts. Contracts gained one local `@runnets/domain: workspace:*` dependency so it can reuse those pure definitions rather than copy policy or import application internals. Application still depends only on domain.

Connection and grant reads are owner-scoped, capped at 100 records and 400,000 canonical characters, safely below the existing 2 MiB frame limit even for multibyte text. Connection views include current catalog tool names. Receipts return a keyless original connection or grant snapshot; refresh receipts retain the published connection snapshot rather than an unbounded full tool catalog. Receipt binding and prepared secret references stay internal.

## Transaction and schema semantics

Schema **26** adds one table: `ocean_service_owner_receipts`. Each JSON record is bounded to 131,072 bytes. Request ID, owner ID and prepared/completed state are indexed table columns checked against the stored record. Existing authority tables, immutable catalogs, historical journal rows and schema migration behavior remain intact. Current-schema assertions and failure-publication triggers follow 26. Backup manifests now accept schema26 and still reject unsupported schema27.

Connection/grant mutation and completed receipt commit in the existing synchronous immediate authority transaction. `OwnerScopeService.issue/revise/revoke` remain the sole grant materialization and validation policy; an optional owning transaction lets the settings facade reuse them without nested BEGIN. Membership, current trust/catalog and baseline checks remain in that policy. New explicit issuance defaults to autonomous. Revocation retains the grant and journal history and does not settle unknown effects.

CAS checks compare all three connection axes or the exact grant revision. Configuration changes advance configuration; route/workspace, permission, reconnection and credential changes also invalidate trust as appropriate. Credential replacement/removal advances the credential axis and resets account identity/evidence to unverified. A harmless update preserves existing trusted binding metadata when trust has not changed. Catalog pointers remain historical, and current-authority checks make old tuples inert.

Refresh prepares a durable receipt before discovery. Its completion callback participates in the existing coalesced catalog-publication transaction, so catalog publication and completed receipt are atomic. Replays return the original receipt instead of discovering again. Failed/interrupted refreshes remain prepared and require explicit recovery.

Disconnect first commits the disconnected generation. The existing transport then removes readiness and retires the old session only after admitted calls settle; it does not abort admitted business calls or claim cleanup was confirmed. A focused RED→GREEN fix ensures replaying an old disconnect receipt performs no cleanup against a later generation. Owner settings work and metadata continuations join the host's existing drain.

## Credentials and crash behavior

Neutral connections accept an optional trusted material binding and an opaque `saved:psec_...` reference. The host uses the unchanged `createProviderSecretStore` and `providerCredentialDirectory`: sibling private storage outside the profile/backups, 0700 directory and 0600 atomic/fsynced `providers.json`. There is no second secret manager, broker, SDK wrapper or account lookup.

Owner keys are bounded to 512 characters and never stored in SQLite, receipts or response DTOs. The request uses the existing provider `keyDigest` with injected SHA256. Each replacement allocates a fresh opaque reference. Binding proves unchanged bytes only; it never verifies an account or continuity between keys/endpoints. No equality of endpoint, name or schema infers account continuity.

For replacement, a prepared receipt containing the exact one-way request binding, opaque reference and expected versions commits before private publication. The subsequent current connection/receipt commit rechecks versions. Explicit saved-key removal uses the same durable-intent-before-private-deletion order. A failure before private publication leaves no new active connection. Failure after publication but before final SQLite commit leaves a prepared receipt and an unused private entry; the entry is not execution authority. Prepared requests are visible as `explicit_recovery_required`, never automatically resubmitted, and cannot be adopted by a different payload. Recovery requires a fresh explicit owner request with current versions and material resupply where needed; this child adds no automatic repair endpoint.

Production credential resolution refuses an absent binding, absent/corrupt/insecure saved state, or actual material whose digest differs from its binding. Saved handles do not fall back to environment credentials. Existing env handles without binding remain readable but inert; a changed value under a bound `env:NAME` refuses reconnect and restart. An active admitted session retains its captured material rather than silently switching to new bytes. Explicit trusted transport controls remain test seams only.

Fault tests inject failure at private publication and at final SQLite connection commit after successful publication; they are deterministic failure injections, not claims of kernel crash testing. Existing private-store durability tests also run in the full source suite.

## Verification and evidence

All test/build/lint/format commands ran from the worktree through the unchanged private runner:

```text
python3 .superpowers/sdd/2026-11-04-ocean-platform/run-private.py <command>
```

It supplies private HOME/all XDG/TMP and minimal environment. Proof root is the fresh direct child `/home/ryltsevmg/Projects/Ocean-artifacts/c18-5-1-owner-20261106`. Logs, including failures, remain there. No exclusions or test suppressions were introduced.

Important commands and results:

| Command after private-runner prefix | Exit / evidence |
| --- | --- |
| `pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/local-runtime/service-owner-settings.test.ts` before implementation | 1, expected `method_not_found`; `red-socket.log` |
| Same owner socket file after implementation | 0; `green-socket-2.log` |
| `pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/local-runtime/service-owner-credentials.test.ts` before explicit private deletion | 1, expected retained synthetic key; `red-key-removal.log` |
| Same credential file after deletion implementation | 0, 5 tests; `green-key-removal.log` |
| `pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/service-owner-settings.test.ts` before disconnect replay fix | 1, cleanup count2 instead of1; `red-disconnect-replay-2.log` |
| Same storage/settings file after fix | 0, 5 tests; `green-disconnect-replay.log` |
| `pnpm exec vitest run --config vitest.source.config.ts packages/domain/src/profile-backup.test.ts` before schema26 admission | 1, expected schema26 acceptance; `red-backup26.log` |
| `pnpm exec tsc -b --pretty false` | 0, scoped build logs1–3 |
| `pnpm typecheck:tests` | 0, `scoped-test-types-final.log` |
| Scoped ESLint over owned runtime/application/domain/contracts/storage/transport paths | 0, `scoped-lint-final.log`; root final lint also0 |
| Focused authority/migration/policy/transport suite | 0, 35 files/143 tests; `scoped-regressions.log` |
| Owner SQLite/socket/runtime/credential five-file suite | 0, 15 tests before final added regressions; `owner-focused-3.log` |
| `pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/local-runtime/service-owner-stdio.test.ts` | 0; real SDK stdio protocol with managed-preparation seam; `owner-stdio.log` |
| `pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/direct-chat.test.ts` after controller-authorized fixture amendment | 0, 6 tests; `c4-fixture-amendment-green.log` |
| `pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/service-owner-process.test.ts apps/cli/src/release/mcp-bundle.test.ts apps/cli/src/local-runtime/mcp-runtime-process.test.ts` | 0, 3 files/8 tests; `affected-process.log` |
| Initial `pnpm check` | 1: 54 failures/3638 passes/44 skipped; preserved `root-check.log` |
| Initial `pnpm build`, `pnpm format:check` | 0 / 1, only protected format2; `root-build.log`, `root-format.log` |
| Final `pnpm check` after integration corrections | 1: **only protected catalog3**, 550 passing files/1 failing/17 skipped; **3689 passing tests/3 failing/44 skipped**, `root-check-final.log` |
| Final `pnpm build` | **0**, `root-build-final.log` |
| Final `pnpm format:check` | **1, exactly protected foreign2**, `root-format-final.log` |

The full root check passed production typecheck, both test typechecks and lint, then stopped at the known source catalog failures, so its process stage was unreachable. The three affected process controls above were run separately and passed. The source-only integration corrections after that process run change backup schema admission and test expectations/fixtures, not the tested owner transport or process behavior. No unchanged process/native/live/GUI matrix was repeated afterward.

Initial 54 failures were not hidden. Fifty were schema26 backup/table/current-version/capability integration expectations and their downstream backup failures; those were corrected and verified by the final full source run. One additional failure was the unchanged C4 `direct-chat.test.ts` coding fixture: it supplied no digest to the already fail-closed tool combiner. The controller identified this as latent C4 N1 fixture integration debt missed by the earlier scoped59 and authorized the minimum trusted SHA256 `callDigest` augmentation. Its original task identity/context/replay assertions remain; no production combiner relaxation or ownership-marker shortcut was added. Final remaining failures are only the protected catalog3.

Owning test files include:

- CLI `service-owner-settings`, `service-owner-runtime`, `service-owner-credentials`, `service-owner-stdio`, `service-owner-process` tests and the `service-owner-peer` fixture.
- SQLite `service-owner-settings`, `service-owner-receipts`, service authority migration/storage tests and current migration/schema assertions.
- Existing owner scope, service authority boundaries, MCP admission/normal-turn/retirement/lifecycle controls, profile backup/restore and compatibility suites.

The socket/runtime tests use actual SQLite and actual authenticated sockets, with real mutation counts. They configure anonymous HTTP, explicitly enroll stdio, refresh metadata, issue a bounded autonomous grant, execute scripted chat through the existing admission/SDK path (one durable claim/one effect), revoke while dispatch is held (zero sends), reject invalid/foreign subjects with no grant mutation, enforce stale/concurrent versions, exercise owner maintenance/old-client refusals, rotate A→B without old-grant reuse, replay original receipts independently of current state, and keep credential bytes out of stored metadata and wire results. The independent process discards its first mutation response, disconnects, then another client after owner restart observes the single original completed receipt.

The stdio API test uses an actual owned synthetic Node child and the real SDK stdio transport while injecting managed process preparation. It does **not** requalify Linux namespace/cgroup isolation or a ready production server. Existing accepted native evidence is retained, and no new native/live/ready-server matrix, model/account access or GUI test was attempted.

## Pins, protected state and limitations

The only lockfile graph change is the local contracts→domain workspace dependency. No external package version, SDK patch or SDK byte pin changed. The production bundler's exact reviewed whole-lock pin was reconciled:

- Previous lock SHA256: `503cf1fadb723dd6c131540cae5d8ad9fdc01fdcb1a844c56aa64c8a77b31ec0`.
- Current lock SHA256: `772997479409712d5501576dca97ea0fd475efbe5225a8311512ab9efda8515f`.
- MCP client/core remain `2.4.0`; rolldown remains `1.2.16`; pnpm remains `12.16.1`; Node used by tests is `26.13.0`.
- Production MCP bundle/pin/import checks and supported historical archive validation passed in `affected-process.log`. No actual release artifact or installed production release was changed.

Protected files preserved byte-for-byte **and with original staging**:

| File | SHA256 | Index / status |
| --- | --- | --- |
| `apps/cli/test-fixtures/github-session-rig.ts` | `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031` | index `b3ff4f26b9f1fd0a66ce72776474eccd81867b34`, modified unstaged |
| `apps/cli/src/plugin-catalog-lifetime.test.ts` | `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3` | untracked, not staged |

Private runner SHA256 remains `adc3adf372fa77a694f4a4272a5f13e615646886356e1db0045767dad0d228a3`. `git diff --check` passed. Every owned TypeScript file is at most300 physical lines; host.ts is exactly300. Proof inventories are `owned-files.json` and `source-lines.json`.

Protected catalog3 remain:

1. `uses the published catalog beyond the SDK TTL without automatic discovery`.
2. `does not refresh an explicitly stale SDK catalog outside owner discovery`.
3. `cannot let a delayed stale refresh outlive the foreground invocation`.

The final formatter reports only the protected two files above. These debts remain for18.6. LICENSE/NOTICE, actual profiles, credentials, release installations, defaults, design, launcher and user-unit configuration were not modified. All service/model/key data in tests are synthetic and privately owned; no real provider, API account, model or credential file was used.

C18.5.2 exact decision confirmation, C18.5.3 UI/legacy conversion and Executor source removal are not implemented here. No independent acceptance review has yet occurred; the controller must review the entire `4dcc286eb097ec91fdced67b2f30f43fd06c151c..HEAD` artifact before marking the task accepted.

## Correction1 — C1, I1, I2 and I3

Worker status: **DONE_WITH_CONCERNS, correction ready for scoped independent review; acceptance remains pending.** FIX_BASE is `9243866459f9ba90a0cdcc2febb4d7c3da4d9362`. This correction addresses the four blocking findings in `task-18.5.1-review.md` under `task-18.5.1-fix1.md`. M1 bounded-list materialization and M2 the generic mutation process test's sleep witness remain explicitly deferred to F. No helper agent/reviewer, root suite, native/ready-server/live/GUI or package qualification was added or repeated.

This appendix supersedes the original report's ordinary secret-publication/removal compatibility description. The original implementation could accumulate successful rotation entries, publish beyond the shared file's readable limit, then reset untrusted contents. That behavior is corrected; the review's C1 reproduction was valid.

### C1: bounded, preserving shared private publication

The existing `createProviderSecretStore` path now checks the UTF-8 byte size of serialized output against 65,536 **before** opening a publication temp file or replacing existing bytes. An oversized result refuses with stable `provider_write_failed`. Ordinary `write`, `replace` and `remove` share the existing validation/preservation path: absent state may initialize normally, while existing corrupt, insecure, oversized or unreadable state refuses. No mutation treats untrusted shared bytes as an empty map. Errors remain stable and nonsecret; no path/port/format, flag, alternate store or repair framework was added.

`ServiceOwnerSettings` now calls existing atomic `replace(previousServiceReference,newReference,key)` rather than `write` for key publication. The previous reference comes from the authoritative current service connection after owner/version checks. Only that superseded service entry is retired; unrelated provider entries remain. A fresh opaque new reference and the same SHA256 material binding are retained. The receipt still commits prepared intent before private publication, and the final SQLite transaction still rechecks current versions and commits connection plus completed receipt together.

The crash tradeoff is explicit: after successful private replacement but before final SQLite commit, the old service reference can be absent while SQLite still retains the old connection. The new private entry is not newly active execution authority, no new grant is issued, and a fresh activation cannot resolve the missing old reference. The prepared receipt remains, exact replay performs no private effect, and a fresh explicit request with current versions/material resupply can recover. Unused entries from uncertain operations may remain inert; insufficient capacity refuses rather than cleaning unrelated/unknown entries or writing an unreadable file.

Actual combined witnesses in `packages/store-sqlite/src/service-owner-secret-publication.test.ts` use file-backed SQLite, the actual private-store adapter and an unrelated synthetic provider entry in a valid roughly 65 KiB store. They prove overflow publication leaves the complete previous file unchanged, close/reopen never resubmits the prepared request, explicit smaller resupply recovers and retires the old service entry, and final SQLite trigger failure after successful atomic private replacement leaves the old SQL row/prepared receipt while preserving the unrelated provider key through restart and explicit recovery. These are combined owning-composition proofs, not an inference from a fake secret map plus a separate adapter test.

Low-level `provider-secret-store.test.ts` also proves over-limit refusal, successful near-limit atomic replacement and byte-for-byte preservation on ordinary mutations against corrupt/insecure/oversized state. The existing formerly destructive removal assertion now requires refusal and unchanged corrupt bytes. The owner unit fixture now models `replace` and expects one retained service entry after successful rotation.

Compatibility/recovery limitation: explicit provider/model key resupply and saved-key removal no longer reset a corrupt shared file. They refuse and remain unverified/pending rather than erase unknown unrelated credentials. This child adds no automatic private-state repair or new repair endpoint. Separately authorized recovery must first establish trustworthy private state; the existing pending-request/retry contract remains unchanged for valid private state and ordinary publication failures. Actual provider and model socket writes against a deliberately corrupt owned synthetic store demonstrate refusal and unchanged bytes in `provider-secret-preservation.test.ts`; existing provider/model pending and repair consumers pass the affected suite.

### I1: runtime lifetime for accepted metadata refresh

The owner socket dispatcher no longer passes its detached-socket signal into an accepted durable connection refresh. The existing runtime deadline, stop controller, coalesced metadata work and drain continue to own that operation. The public trusted in-process optional refresh signal remains unchanged; there is no new job broker or deadline mechanism.

The actual authenticated-socket test in `service-owner-fix1.test.ts` holds `tools/list`, waits until discovery starts, obtains a second client's prepared coalesced request, then disconnects the initiating client before releasing the responder. The remaining client sees both original and coalesced receipts completed and exactly one actual `tools/list`. This deterministic held-metadata proof is separate from deferred M2's generic mutation process witness.

### I2: credential destination compatibility

Before any prepared receipt, private publication or connection write, `assertCredentialDestination` restricts implicit retention of an existing credential to HTTP configurations with the same normalized URL origin. Crossing origin requires explicit new key material or `removeKey:true`; otherwise it refuses `invalid_params` with no mutation receipt or changed connection. Same-origin route edits continue to invalidate business trust under the existing version policy while permitting the same bearer destination.

An existing keyed connection cannot become stdio: the owner must first remove its saved key while it is HTTP, then explicitly configure the credentialless stdio declaration. Existing stdio wire requests still reject key fields. No new wire shape was added, and origin/material equality never asserts account continuity.

The owning socket tests verify implicit cross-origin and keyed HTTP→stdio refusal with original state/versions and absent receipts, then successful credentialless stdio transition after explicit removal. `service-owner-destination.test.ts` uses two independently bound synthetic HTTP origins and responder-observed Authorization headers. The original origin receives A; same-origin route metadata still receives A with advanced trust; an implicit cross-origin edit sends nothing to the new origin; explicit key B sends only B there, while explicit removal sends no bearer. The second origin never observes A. The existing synthetic MCP HTTP fixture gained only bounded test observation fields for these actual received headers.

### I3: absent-only mode defaults

The request validator now defaults mode only when the `mode` property is absent. A present null, undefined or unknown value is invalid. `OwnerScopeService` independently rejects those present values at its shared trusted policy boundary and defaults only on absence; valid autonomous/confirm values and prior valid-mode behavior remain intact.

The actual socket case attempts null mode on create and revision and proves no new grant, byte-equivalent existing grant state/revision and no mutation receipts. It also proves an omitted mode creates autonomous and an explicit valid confirm revision succeeds. `owner-scope-mode.test.ts` covers null, undefined and unknown values at both the request validator and direct shared owner policy, including unchanged old state and valid confirm behavior.

### Correction commands, results and pins

Fresh proof root: `/home/ryltsevmg/Projects/Ocean-artifacts/c18-5-1-fix1-20261106`. Every test/check command used the unchanged private runner from the same worktree:

```text
python3 .superpowers/sdd/2026-11-04-ocean-platform/run-private.py <command>
```

All input profiles, servers, stores and keys are generated synthetic data under private HOME/all XDG/TMP. No actual account, provider/model API, real credential file or production profile was read or used. Failed logs remain preserved.

| Command after runner prefix                                                                                                                                                                                                                   | Exit / result                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run --config vitest.source.config.ts packages/tools-node/src/provider-secret-store.test.ts apps/cli/src/local-runtime/service-owner-fix1.test.ts` before correction                                                         | 1: **7 expected failures**, covering capacity/untrusted reset, detached coalesced refresh, implicit destination transfer and null autonomous creation; `red-four-findings.log`                                                                        |
| Same two files plus `packages/store-sqlite/src/service-owner-settings.test.ts` after first fixes                                                                                                                                              | 0: **3 files/22 tests**, `green-four-findings-1.log`                                                                                                                                                                                                  |
| `pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/service-owner-secret-publication.test.ts apps/cli/src/local-runtime/provider-secret-preservation.test.ts packages/store-sqlite/src/owner-scope-mode.test.ts` | Combined private/SQLite 2 tests and provider/model 1 test passed; direct mode test fixture initially used incorrect cleanup/authority field names, corrected without production relaxation; initial diagnostic retained in `consumers-recovery-1.log` |
| `pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/owner-scope-mode.test.ts` after fixture correction                                                                                                           | 0: **3 tests**, `mode-boundary-green.log`                                                                                                                                                                                                             |
| `pnpm exec vitest run --config vitest.source.config.ts apps/cli/src/local-runtime/service-owner-destination.test.ts`                                                                                                                          | 0: **2 actual-header cases**, `destination-headers.log`                                                                                                                                                                                               |
| Affected covering command shown below                                                                                                                                                                                                         | 0: **31 files/186 tests**, `affected-covering.log`                                                                                                                                                                                                    |
| `pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/service-owner-process.test.ts`                                                                                                                             | 0: **1 file/1 test**, `affected-owner-process.log`; M2 remains deferred                                                                                                                                                                               |
| `pnpm exec tsc -b --pretty false`                                                                                                                                                                                                             | 0, strict main projects; `strict-main.log`                                                                                                                                                                                                            |
| `pnpm typecheck:tests`                                                                                                                                                                                                                        | 0, strict Node and Desktop test projects; `strict-tests.log`                                                                                                                                                                                          |
| `pnpm exec eslint <owned correction TypeScript files>`                                                                                                                                                                                        | 0, `scoped-lint.log`; exact file inventory `covering-files.json`                                                                                                                                                                                      |
| `pnpm exec prettier --check <owned correction TypeScript files>`                                                                                                                                                                              | 0, `scoped-format.log`; same inventory                                                                                                                                                                                                                |

The exact affected covering command (shell globs expand only the named owning consumers) was:

```text
pnpm exec vitest run --config vitest.source.config.ts packages/tools-node/src/provider-secret-store.test.ts packages/application/src/provider-connection*.test.ts packages/application/src/provider-connections.test.ts packages/application/src/model-connection*.test.ts packages/store-sqlite/src/service-owner*.test.ts packages/store-sqlite/src/owner-scope-mode.test.ts packages/store-sqlite/src/service-{allowance,eligibility,task-scope}.test.ts apps/cli/src/local-runtime/service-owner-*.test.ts apps/cli/src/local-runtime/provider-{settings,startup,local-lifecycle,secret-preservation}.test.ts apps/cli/src/local-runtime/model-settings*.test.ts apps/cli/src/local-runtime/model-recovery-wire.test.ts
```

`source-lines.json` records all owned correction TypeScript files at most295 physical lines; unchanged host.ts remains300. `git diff --check` passes. A source comment documents the runtime-owned metadata lifetime; it changes no checked behavior.

No root/package/native/live/GUI aggregate was rerun. The original final root result remains a **prior pin**, not a new correction aggregate: 3689 pass/3 protected catalog fail/44 skip, process stage unreached, build0 and format protected2. The correction's evidence is the scoped 186 source and1 process tests plus strict/lint/format checks above.

The lock and all external version/SDK pins are unchanged: lock SHA256 `772997479409712d5501576dca97ea0fd475efbe5225a8311512ab9efda8515f`, pnpm12.16.1, Node26.13.0, MCP client/core2.4.0, rolldown1.2.16. No schema or package graph change was needed.

Protected files and staging rechecked unchanged: `github-session-rig.ts` SHA256 `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031`, index `b3ff4f26b9f1fd0a66ce72776474eccd81867b34`, modified unstaged; `plugin-catalog-lifetime.test.ts` SHA256 `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`, untracked and unstaged. Private-runner SHA256 remains `adc3adf372fa77a694f4a4272a5f13e615646886356e1db0045767dad0d228a3`.

Owned correction source and this appendix are committed as the correction checkpoint following FIX_BASE. The terminal handoff names its exact commit. Controller review must cover `9243866459f9ba90a0cdcc2febb4d7c3da4d9362..fixHEAD` for C1/I1/I2/I3 and new fix breakage; this worker claims no independent acceptance verdict. M1/M2 and C18.5.2/C18.5.3/C18.6 remain outside this correction.
