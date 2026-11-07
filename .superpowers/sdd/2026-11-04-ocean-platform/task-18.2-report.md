# C18.2 — neutral authority contracts and inert durable storage

Status: implemented, awaiting controller independent review. Implementation BASE is `d9ea7586af46c21d5358db09fcf299b9554164d3`; worktree `/home/ryltsevmg/Projects/Ocean-stable`, branch `codex/ocean11-stable`. No push or merge. The final owned commit is the commit containing this report (or its subsequent evidence-only amendment).

## Scope and canonical authority staging

The new public domain records and application storage port are inert. `SqliteStore.serviceAuthority` uses the factory's existing `DatabaseSync`, immediate transaction helper and schema24. No new DB connection, authorization service, execution path, approval/effect ledger, transport implementation, SDK import or owner interface was activated. Existing plugin/domain/API behavior remains intact; only the two legacy catalog constants now originate in domain and re-export with their original application names and values.

`OwnerScopeGrant` v2 is the canonical future owner intent for both service and coding permissions. Existing v1 plugin grants/consents/confirmations and exact coding approvals remain the sole implemented runtime paths until18.3 composes admission. No v1 record decodes as v2, and no migration creates new owner authority. These records are runtime-only ports, not model- or owner-facing raw mutation capabilities.

18.3 must check current membership/task/room/bot intersections, owner provenance, active grant revision, service permission `trustRevision`, current trust/account/resource evidence, catalog tuple and per-tool eligibility, limits and mode, before its durable existing-journal claim and final send check. Evidence-reference shape is not certification. A current catalog pointer alone is never eligibility: a configuration/trust/credential update preserves the historical pointer, whose snapshot tuple may then be stale. Publication can only replace it with a matching complete snapshot. No grant is rewritten merely because a catalog, adapter provenance, credential binding or ephemeral session changes. Credential/account continuity and executable/resource enforcement remain18.3/18.4 work, not a storage promise.

## Final public model

Every record field below is readonly. `null` is explicit; no missing-policy broadening or implicit future-tool selection. Closed records reject unknown keys. Identifiers use the existing UTF-8 text helper, normally128 bytes; labels256, executable/URL4096. ISO instants must be exact UTC millisecond strings with valid calendar values. Connection/grant JSON is bounded to65,536 UTF-8 bytes. No access-token/PID/session/readiness field is persisted.

```ts
interface ServiceConnectionVersions {
  configRevision: number; trustRevision: number; credentialRevision: number;
}
type ServiceConfiguration =
  | { kind: 'http'; url: string }
  | { kind: 'stdio'; executable: string; sha256: string; args: readonly string[] };
interface ServiceConnection extends ServiceConnectionVersions {
  id: string; name: string; configuration: ServiceConfiguration;
  credentialReference: string | null;
  trust: ServiceTrustBinding; state: 'active' | 'disconnected';
  currentCatalogId: string | null; createdAt: string; updatedAt: string;
}
interface ServiceTrustBinding {
  ownerId: string; metadataPermission: 'none' | 'allow';
  identity:
    | { status: 'unverified'; label: string | null }
    | { status: 'verified'; accountId: string; evidenceReference: string };
  resourceEnforcement: readonly (
    | { status: 'declared'; scope: OwnerResourceScope }
    | { status: 'evidenced'; scope: OwnerResourceScope; evidenceReference: string }
  )[];
}
```

HTTP configuration has an absolute HTTP(S) URL without userinfo/query/fragment/whitespace. Header literals and unknown config fields are refused, so they cannot conceal an unchecked credential field. Stdio configuration has an absolute executable, lowercase SHA-256 artifact pin and at most64 bounded non-secret literal arguments. These are declarations only; no executable was installed, resolved, hashed or launched. `credentialReference` is a bounded opaque identifier matching `[a-zA-Z][a-zA-Z0-9:._/-]{0,127}`, not a credential value/object. Credentials can only be supplied later behind a host port. Resource enforcement may honestly remain declared while identity is unverified; claiming evidenced enforcement requires a nonempty evidence reference even then. Storage does not certify that reference.

```ts
type ServiceJson = null | boolean | number | string
  | readonly ServiceJson[] | { readonly [key: string]: ServiceJson };
interface ServiceToolDefinition {
  name: string; description: string;
  inputSchema: ServiceJson; outputSchema: ServiceJson; annotations: ServiceJson;
  definitionDigest: string; provenance: Readonly<Record<string, string>>;
}
interface ServiceCatalogSnapshot extends ServiceConnectionVersions {
  id: string; connectionId: string; completeness: 'complete'; observedAt: string;
  provenance: Readonly<Record<string, string>>;
  tools: readonly ServiceToolDefinition[];
}
```

Catalogs retain both schemas and annotations, including explicit null where absent. JSON rejects non-finite numbers, non-JSON values and depth beyond64. At most256 tools, unique names, 4MiB for the whole serialized snapshot; each tool is also bounded. `definitionDigest` has SHA-256 shape; the domain does not compute cryptographic hashes or treat schema equality as semantic continuity. Provenance has at most16 bounded string entries; adapter/SDK evidence there never becomes owner permission. `SERVICE_PLUGIN_MAX_TOOLS=256` and `SERVICE_PLUGIN_MAX_DISCOVERY_BYTES=4*1024*1024` moved to domain, retaining application re-exports and unchanged legacy behavior.

```ts
type OwnerResourceScope =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'account'; connectionId: string; accountId: string }
  | { kind: 'github-repository'; connectionId: string; accountId: string; repository: string }
  | { kind: 'project-worktree'; projectId: string; worktreeId: string | null };
type EffectResourceScope =
  | { kind: 'legacy-global-unknown' }
  | { kind: 'resources'; resources: readonly OwnerResourceScope[] };
type OwnerToolPolicy =
  | { kind: 'exact' | 'current-set'; names: readonly string[] }
  | { kind: 'all-including-future'; explicitlySelected: true };
type OwnerPermission =
  | { kind: 'service'; connectionId: string; trustRevision: number;
      tools: OwnerToolPolicy; resources: readonly OwnerResourceScope[] }
  | { kind: 'coding'; actions: readonly (typeof OWNER_CODING_ACTIONS)[number][];
      resources: readonly OwnerResourceScope[] };
// The element union of exported OWNER_CODING_ACTIONS is:
// project_read | propose_write | run_test_preset | changeset_read |
// apply_changeset | commit | push | deploy
interface OwnerGrantReference { grantId: string; revision: number }
interface OwnerScopeGrant {
  id: string; policyVersion: 2; revision: number; state: 'active' | 'revoked';
  owner: { ownerId: string; issuedAt: string; source: 'owner-interface' | 'owner-migration' };
  subject: { workspaceId: string; roomId: string; botId: string;
             projectId: string | null; taskId: string | null };
  permissions: readonly OwnerPermission[]; mode: 'autonomous' | 'confirm';
  limits: { maxCalls: number; maxEffectBytes: number; expiresAt: string | null };
  updatedAt: string;
}
```

Service resources must name the permission's connection and cannot be coding resources; coding permissions require project/worktree resources and no GitHub fields. Lists are bounded/nonempty; no implicit commit/push/deploy. Each service permission binds a positive trust revision (controller confirmed), while deliberately excluding config/credential/SDK/session/catalog revisions. Exact/current-set materialize unique named tools; future-tool selection requires the explicit true marker. A missing effect scope fails validation; empty resource sets fail validation;18.3 must conservatively normalize missing legacy journal scope to `legacy-global-unknown`. The existing journal was not modified and still globally holds unresolved v1/v2 effects.

Exported validators: `validServiceConnectionVersions`, `validServiceConfiguration`, `validServiceTrustBinding`, `validServiceConnection`, `validServiceJson`, `validServiceToolDefinition`, `validServiceCatalogSnapshot`, `validOwnerResourceScope`, `validOwnerResources`, `validEffectResourceScope`, `validOwnerToolPolicy`, `validOwnerPermission`, `validOwnerGrantReference`, `validOwnerScopeGrant`. They use small private shared helpers, not a validation/transaction framework.

## Exact application port and transaction semantics

```ts
interface ServiceAuthorityStorePort {
  atomic<T>(work: (tx: ServiceAuthorityTransaction) => T): T;
}
interface ServiceAuthorityTransaction {
  connection(id: string): ServiceConnection | null;
  listConnections(): readonly ServiceConnection[];
  putConnection(record: ServiceConnection,
    expectedVersions: ServiceConnectionVersions | null): boolean;
  catalog(id: string): ServiceCatalogSnapshot | null;
  putCatalog(record: ServiceCatalogSnapshot): boolean;
  publishCatalog(connectionId: string,
    expectedVersions: ServiceConnectionVersions, snapshotId: string): boolean;
  grant(id: string): OwnerScopeGrant | null;
  listGrants(): readonly OwnerScopeGrant[];
  putGrant(record: OwnerScopeGrant, expectedRevision: number | null): boolean;
}
```

The callback is synchronous only; returning a thenable throws and rolls back. Every method guards transaction lifetime, including reads; captured handles cannot write after commit/rollback. `BEGIN IMMEDIATE` uses the same DB/connection; callback or SQLite errors roll back the batch. Read methods decode/validate fresh snapshots and check row column/payload consistency. List ordering is deterministic by id.

`putConnection(record,null)` creates only all-three-revisions1 with null pointer and returns false if the id exists. Replacement requires every expected axis to match, no axis to regress, and at least one axis to advance. Configuration/name/state changes must advance configRevision; trust/credential changes must advance their respective axes. CreatedAt and the catalog pointer cannot be replaced through this method. Stale/missing/invalid CAS intent returns false; a matching-CAS malformed record throws. Tuple comparison is serialized under the immediate transaction, not inferred from a prior reader.

`putCatalog` validates the full bounded snapshot and requires an existing connection by FK. An identical id/content insertion is idempotently true; different content for an existing id throws an immutable conflict. Stable comparison ignores object key insertion order and preserves array order. `publishCatalog` returns false unless the connection, snapshot connection id, connection tuple, snapshot tuple and expected tuple all match. Partial/invalid inserts throw before publication; nonexistent/stale/cross-connection publication leaves the pointer unchanged. Publication never modifies a grant. A stored immutable historical snapshot can be stale without becoming current authority.

`putGrant(record,null)` creates revision1 only. Replacement requires the stored revision to equal expectedRevision and the new revision to be exactly expected+1. Stale writes return false before touching policy or connection pointers; revisions cannot regress. This is storage CAS, not owner authorization, membership verification or execution admission.

## Exact migration24 SQL

Schema23 was rechecked before implementation. The migration adds only these three tables; no old table is altered by24. Existing additive schema initialization and the final FK check/version commit remain the owner. Current24 requires every new table; version25 refuses before mutation. Source-only schema refusal is not an installed-binary rollback qualification.

```sql
CREATE TABLE IF NOT EXISTS ocean_service_connections (
  id TEXT PRIMARY KEY,
  config_revision INTEGER NOT NULL CHECK(config_revision >= 1),
  trust_revision INTEGER NOT NULL CHECK(trust_revision >= 1),
  credential_revision INTEGER NOT NULL CHECK(credential_revision >= 1),
  current_catalog_id TEXT,
  record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 65536),
  FOREIGN KEY(id, current_catalog_id) REFERENCES ocean_service_catalogs(connection_id, id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE IF NOT EXISTS ocean_service_catalogs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES ocean_service_connections(id),
  record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 4194304),
  UNIQUE(connection_id, id)
) STRICT;
CREATE TABLE IF NOT EXISTS ocean_owner_scope_grants (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  record TEXT NOT NULL CHECK(json_valid(record) AND length(CAST(record AS BLOB)) <= 65536)
) STRICT;
```

The circular catalog-pointer FK is deferred so connection-first insertion and later immutable publication remain transactional. The composite FK prevents a pointer to another connection's catalog. Grant policy JSON has no fake connection/GitHub column requirement; a pure coding grant needs neither. Catalog immutability is enforced by the only exposed mutation port; raw SQLite is trusted runtime infrastructure, not an owner capability. Reads still fail closed on corrupt/nonconforming payloads. JSON permission references are declarations and intentionally not SQL FKs to assert account/resource facts.

Migration evidence uses disposable SQLite only: remove exactly24's three tables from a current generated fixture, mark23, retain all legacy rows, snapshot every old user table (excluding only meta/new tables), migrate, compare exact rows, ensure exactly three empty tables appeared and `foreign_key_check=[]`. Fixture contains existing plugin version/connection/grant/consent/confirmation/operation, synthetic exact coding approval/claim bytes, uncertain v2 effect and unscoped uncertain v1 effect. Pending effects remain exactly equal; an unrelated fresh claim is still refused. A meta-publication trigger rolls the entire migration back to23 with no new table. Fresh24, repeat-open, file reopen, newer refusal and missing24-table refusal are also covered. Schema24 backup-manifest acceptance and retained schema23 inspection are the only necessary compatibility extensions; no new backup implementation was introduced.

## Verification evidence

All package/test commands below run from the stable worktree through the existing, unmodified `P = python .superpowers/sdd/2026-11-04-ocean-platform/run-private.py`, which supplies a disposable private HOME/all XDG/TMP/minimal environment. No real profile/database/credentials, model request, GitHub request, GUI or native launcher qualification was used.

- Initial `P pnpm exec vitest run --config vitest.source.config.ts packages/domain/src/service-authority.test.ts`: RED, six failures because the new validator exports did not exist; final domain cases GREEN.
- Initial `P pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/service-authority-storage.test.ts`: RED exit1, six failures because `serviceAuthority` did not exist. First combined GREEN:12/12, exit0.
- CAS edge regression: RED exit1 when unchanged tuples could be replaced; fixed by requiring an axis advance and config revision for name/state changes. Validator edge RED exit1 caught invalid calendar/URL/enum forms; final cases GREEN.
- Migration/legacy fixture RED exit1 exposed new table enumeration, hardcoded version assertions and fixture reinitialization. Fixed schema checks/fixtures without changing old policy semantics. Owning test expansion exposed synthetic backup metadata refusing24; direct manifest regression RED exit1. Schema23 maintenance regression RED exit1 first returned unsupported_schema; added exactly historical23 to retain prior support. A fixture-only follow-up added the existing lazy journal constructor so summary has its normal old tables; final cases GREEN.
- Preliminary `P pnpm exec tsc -b --pretty false`: exit0. Preliminary `P pnpm exec tsc -p tsconfig.tests.node.json --pretty false`: exit0. Scoped ESLint on all new contract/storage/test files: exit0.
- Final owning run `P pnpm exec vitest run --config vitest.source.config.ts packages/domain/src packages/store-sqlite/src apps/cli/src/local-runtime/desktop-binding-migration.test.ts`: **exit0, 105 files passed, 776 tests passed**. Includes all new contracts/storage/migration cases and updated historical migration/backup fixtures.

Final root results are recorded below after the single final source run. No new test/compiler exclusion, any-cast suppression, known-failure skip or format exemption was added.

## Self-review and limitations

Owned source stays at or below300 physical lines, including existing `maintenance.ts` at299; new files split only along contract/schema/rows/storage/test boundaries. `git diff --check` passes. The implementation is restricted to the new contracts/exports/store adapter/schema24, required schema-sensitive tests and backup acceptance bounds. No installed/artifact rewrite, patch/dependency/lock change, production Executor routing change, legacy grant conversion, effect-journal weakening or new activation occurred.

Protected bytes remain `apps/cli/test-fixtures/github-session-rig.ts` SHA-256 `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031` and untracked `apps/cli/src/plugin-catalog-lifetime.test.ts` SHA-256 `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`. Neither is staged. All other worktrees/default Ocean, real profiles/credentials/installations, LICENSE/NOTICE and the private runner remain untouched. No stash/reset/clean or helper/subagent/reviewer was used. Controller independent review is still required before18.3.

Declaration limits: the domain does not certify credential contents, artifact pins, evidence provenance, resource containment, server account continuity, schema semantics or supported command backends. No generic identity/proof/OAuth/install framework exists. Stdio arguments are declared non-secret literals; the future host must keep actual credentials behind its secret-reference port. Async transaction callbacks are prohibited and rejected at runtime, rather than implementing asynchronous database transactions. Actual durable admission, scoped journal effects, final-send revocation, coding automatic decision, metadata refresh and transport activation remain18.3/18.4. Legacy conversion/client capabilities and installed rollback remain18.5/18.6.

## Final root and correction results

- The **one** final production-source `P pnpm check` ran main strict TypeScript, strict Node tests, strict Desktop tests and ESLint successfully. It exited **1** in the source suite: **3454 passed, 4 failed, 44 skipped; 509 files passed, 2 failed, 17 skipped**. The process phase short-circuited at that source failure. This is the actual global result; no corrected global-green count is inferred.
- Three failures are the unchanged protected legacy C catalog debt in `apps/cli/src/plugin-catalog-lifetime.test.ts`: `uses the published catalog beyond the SDK TTL without automatic discovery`; `does not refresh an explicitly stale SDK catalog outside owner discovery`; `cannot let a delayed stale refresh outlive the foreground invocation`.
- The fourth failure was `packages/integrations-executor/src/imports.test.ts > package surface qualification > the application port is free of Effect and Executor imports`. Its old zero-specifier assertion rejected the planned pure-domain constant re-export (`@runnets/domain`). The test-only correction requires exactly that public domain entry and retains the assertion against direct import declarations. No SDK/Effect/I/O dependency was allowed. `P pnpm exec vitest run --config vitest.source.config.ts packages/integrations-executor/src/imports.test.ts`: **exit0, 14/14 tests passed**. The controller explicitly directed focused verification and relevant strict test compilation instead of a second full root check. Thus the global run above remains reported with all four failures.
- `P pnpm build`: **exit0** (`tsc -b`), after the assertion correction. No production source changed after the root check.
- `P pnpm exec eslint packages/integrations-executor/src/imports.test.ts`: **exit0** after that test-only correction.

Current-session logs are `/tmp/c18-root-check.log`, `/tmp/c18-root-build.log`, `/tmp/c18-imports-green.log`, `/tmp/c18-owning-green.log`, `/tmp/c18-final-ts-node.log` and `/tmp/c18-final-import-lint.log`; this report preserves the commands, actual counts and failure names rather than relying on temporary log retention.

- Final correction verification `P pnpm exec tsc -p tsconfig.tests.node.json --pretty false`: **exit0**. The strict Desktop test compiler had already passed in the root check; its source inputs did not change apart from the string assertion above.
- The **one** final `P pnpm format:check`: **exit1**, exclusively the two protected files listed above (`plugin-catalog-lifetime.test.ts`, `github-session-rig.ts`). No owned formatting failure remains. Log: `/tmp/c18-root-format.log`.
- Final source/ownership review: all owned changed source files<=300 lines; `git diff --check` exit0; protected SHA-256 values unchanged; protected modified file remains unstaged and protected untracked test remains untracked. Only the explicit owned source/test paths and this report are staged for the final commit.

## Correction1 — reviewed Important findings I1–I3

Correction BASE: `787946c62bdd817bec5aba2be48c53b44e459df0`. Independent full review reported0 Critical,3 Important and2 Minor. This round implements only I1–I3 under `task-18.2-fix1.md`; M1 (Unicode canonical-key ordering) and M2 (churn regression success assertions) remain in the controller's ledger for final review. No helper/reviewer/subagent, push, native/live/model/GitHub/GUI operation or second full root suite was used. The original root3454/4/44, build and protected-format results above remain historical facts at the original implementation; no globally green result is inferred from this correction.

### I1 — dense arrays before authority admission/persistence

The review reproduced sparse arrays passing `.every`, committing grant JSON containing `[null]` and then failing durable decode. A small private `authorityDenseArray` helper now checks every numeric index with `Object.hasOwn` before element validation. This covers permission lists, resource sets, exact/current-set names and coding actions, full catalog tools, trust enforcement declarations, stdio args and recursively nested JSON arrays. Secondary permission/resource checks reuse their already dense-validated collections. Internal object entry/key arrays are constructed densely by the language; no new generic validator framework was added.

New domain regressions reject sparse effect scopes, permission/resource/tool-name/action arrays, sparse tool definitions, sparse trust declarations and sparse input/output/annotation JSON, including an inherited index instead of an own element. Positive effect/grant/catalog JSON roundtrips remain valid. New real-SQLite regressions refuse sparse permission/resource grants before commit, leave `listGrants()` empty, then successfully create/read/list a valid grant. Missing scopes still fail validation and never become empty conflict sets; no journal behavior changed.

### I2 — minimal inert stdio and credential-handle contract

The prior report's permissive argv/opaque-reference descriptions are superseded by this correction. `ServiceConfiguration` retains the same `args: readonly string[]` field, but validation permits only an **empty dense list** in this inert stage. Even `['--stdio']` is intentionally unsupported. Both `['--access-token','ghp_ExampleOnlyNotARealCredential']` and sparse args are rejected; the synthetic string is not a real credential. Stage18.4 may extend only concrete qualified non-secret launcher forms; arbitrary argv, flag blacklists and a secret-manager framework were not introduced. No existing production consumer uses this new inert configuration; Executor/legacy configuration behavior was not changed.

A nonnull `ServiceConnection.credentialReference` now requires the distinguishable format `env:UPPER_CASE_NAME`, validating the suffix with the existing domain `validCredentialReference` rule `[A-Z_][A-Z0-9_]{0,127}`. Null remains valid. Bare synthetic token strings, bare environment names, the previous opaque `secret:...` spelling, lowercase/empty/whitespace suffixes are refused. `env:SERVICE_TOKEN` and `env:_SERVICE_2` remain valid handles. No variable or credential was read/resolved. Shared neutral test fixtures and credential-rotation test inputs now use env handles; no persisted real/legacy record conversion occurs.

A SQLite regression refuses both raw credential argv and a raw reference before any row is committed, verifies the connection list remains empty, then roundtrips a pinned empty-argv connection with `env:SERVICE_TOKEN`. The type/port field names and schema24 SQL remain unchanged. Servers requiring argv remain unsupported by this inert record until18.4 defines a qualified form; this is explicit staging, not a claim of universal ready-made server launch support.

### I3 — observed rejection of refused asynchronous callbacks

`atomic` still rolls back synchronously and closes its transaction handle on callback completion/error. Its async-result check now requires a **callable** `then`. Before throwing the synchronous `service authority callback must be synchronous` error, it attaches an observation with `Promise.resolve(result).catch(() => {})`. The ignored asynchronous callback is already refused synchronously; consuming that callback's later failure prevents an unhandled rejection from terminating the host. No async transaction, delayed commit or alternate authority path exists. A synchronous `{then:1}` result is now returned normally.

The regression installs a scoped `unhandledRejection` observer, invokes an async callback that writes before await, then resumes after rollback and attempts a closed-handle write; it also returns an immediately rejected native promise and a rejecting callable thenable. After the next event-loop turn it verifies the async callback resumed, no unhandled rejection event occurred, the original write was rolled back and `{then:1}` is accepted. The observer is removed in `finally`. On the unchanged correction BASE this test captured `refused callback` and `service authority transaction closed` rejections and failed; with the fix it passes. It tests real promise/event-loop behavior with in-memory SQLite, without a process/native launcher qualification.

### Correction RED/GREEN and scoped verification

All commands used the same unmodified private runner `P` defined above, from Ocean-stable.

- `P pnpm exec vitest run --config vitest.source.config.ts packages/domain/src/service-authority-boundaries.test.ts packages/store-sqlite/src/service-authority-boundaries.test.ts`: **RED exit1,2 files/7 tests failed** on original behavior. Failures reproduce sparse authority acceptance, credential argv persistence and unhandled asynchronous rejection. After the minimal fixes: **GREEN exit0,2 files/7 tests passed**.
- Final covering command `P pnpm exec vitest run --config vitest.source.config.ts packages/domain/src/service-authority.test.ts packages/domain/src/service-authority-boundaries.test.ts packages/store-sqlite/src/service-authority-storage.test.ts packages/store-sqlite/src/service-authority-boundaries.test.ts packages/store-sqlite/src/service-authority-migration.test.ts`: **exit0,5 files/24 tests passed**. Covers all existing authority/CAS/reopen/migration/legacy-hold tests plus the7 new regressions.
- `P pnpm exec tsc -b --pretty false`: **exit0**, strict main compiler.
- `P pnpm exec tsc -p tsconfig.tests.node.json --pretty false`: **exit0**, strict Node test compiler including both new test files; no test exclusions/casts to any.
- `P pnpm exec eslint` on the11 owned correction source/test/fixture paths: **exit0**.
- `P pnpm exec prettier --check` on the same11 paths: **exit0**, “All matched files use Prettier code style!”. Scoped formatting write also exited0 before final checks. No full root check/build/format repeat was performed, as explicitly directed for this correction.
- `git diff --check`: **exit0**. All owned changed TypeScript files remain<=300 physical lines; the storage implementation is196 lines, and new domain/store boundary regressions are107/115 lines. The schema, factory, public storage signatures, canonical comparison and journal are unchanged.

Current-session correction logs: `/tmp/c18-fix1-red.log`, `/tmp/c18-fix1-green.log`, `/tmp/c18-fix1-covering.log`, `/tmp/c18-fix1-ts-main.log`, `/tmp/c18-fix1-ts-node.log`, `/tmp/c18-fix1-lint.log`, `/tmp/c18-fix1-format.log`. Compiler/lint success logs are empty; the commands and actual exits above preserve their evidence beyond temporary logs.

Protected file SHA-256 values remain exactly `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031` (modified rig) and `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3` (untracked catalog test). Their staging status remains unchanged. Only the11 owned correction TypeScript paths and this appended report are staged. No credentials, real profiles/installations, other worktrees, LICENSE/NOTICE or private runner changed. Fresh scoped independent review follows this owned correction commit before18.3.
