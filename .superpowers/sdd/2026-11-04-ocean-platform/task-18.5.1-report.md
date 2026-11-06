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
