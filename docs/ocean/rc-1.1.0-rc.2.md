# Ocean 1.1 RC2 candidate record

Later stable-source work: the [2026-11-04 GitHub pilot qualification](github-pilot.md)
repairs discovery, session authority and hidden MCP retries. It does not change
the frozen RC2 artifact or its historical qualification status recorded here.

Status: **RC2 candidate under final qualification; not a release decision.** This
records what the RC2 candidate implements, what it deliberately leaves open, and
which evidence classes it rests on. It is explicit about planned versus
implemented behavior. The released baseline remains Ocean 1.0; RC1 remains the
installed candidate. Stable 1.1 is **not** complete.

Two facts frame this record:

- The last chat-tool stage (plugins through actual chat, **Task 6**) is integrated
  and independently delta-reviewed; its evidence and limits are recorded in
  [the Task 6 section](#task-6--plugins-through-actual-chat-integrated).
- No live GitHub qualification exists. Plugin execution ships **disabled by
  default**, must be enabled by the owner through the documented steps, and the
  live GitHub gate is explicitly unqualified.

## Immutable candidate

| Field                      | Value                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base                       | `v1.0.0` (Ocean 1.0)                                                                                                                                                                                      |
| Candidate branch           | `codex/ocean-rc2`                                                                                                                                                                                         |
| Whole-branch reviewed rev. | `5d2e1c7` (final review); fix-wave re-review accepted `3a89295`; Task 6 delta merged as `bf53606`                                                                                                         |
| Candidate revision         | recorded with the artifacts built from the frozen clean revision (exact SHA in the release report and artifact manifest)                                                                                  |
| Schema                     | **18** (14 = installed RC1)                                                                                                                                                                               |
| Frozen toolchain           | Node **v26.13.0** (exact `manifest.node` in the artifact), pnpm 12.16.1                                                                                                                                   |
| Platform                   | Linux x86_64, local filesystem, Wayland for the Desktop                                                                                                                                                   |
| Desktop artifact           | separate Electron package; not inside the CLI archive                                                                                                                                                     |
| CLI/runtime archive        | `ocean-1.1.0-rc.2-linux-x64.tar.gz`, SHA-256 `0ea8ddddb762ce0adcaa7b3b8cd257e86c61bb60a783cbf03f3fb297811b98b1`, 1,359,637 bytes                                                                          |
| Installer                  | `ocean-install.mjs`, SHA-256 `059f37166f3d784be27e43b2be4fc52a62bab1e2db1cd78cd1f664b38aad23c3`                                                                                                           |
| Desktop artifact           | separate Electron package, app.asar SHA-256 `6d660ad648dc24c080b4c4a9a2765271710e4b20ba4a2d461731439c2f829b34`                                                                                            |
| Installation               | new versioned directory `releases/1.1.0-rc.2` under `/home/ryltsevmg/.local/opt/ocean-rc`; `current` switched atomically; RC1 `1.1.0-rc.1` retained; launcher, systemd unit and `0600` key file unchanged |
| Owner profile              | migrated schema 14 → 18 on start with data preserved (3 rooms, 2 bots, 22 messages, 9 turns); validated pre-upgrade format-2 backup and a raw file copy retained privately outside Git                    |

This release record was written after the frozen artifact revision `5e10ec3`; the artifacts above
were built from that revision and this documentation commit does not change them (the archive built
at `5e10ec3` contains the documentation as of that revision, following the same convention as the RC1
record).

## What RC2 implements

### 1. Runtime-owned provider connection

- **Sources are explicit and labeled.** `external` = `DEEPSEEK_API_KEY` supplied
  by the environment (never persisted; `provider.check` reports
  `persisted: false` because Ocean owns no revision for it); `saved` = an
  Ocean-managed key in the private credential store outside the profile/backup
  tree (directory `0700`, files `0600`); `injected` = a host seam for tests and
  read-only sessions; `none`. A saved key's opaque reference lives in SQLite, the
  value never does.
- **Explicit disconnect wins.** `provider.disconnect` blocks environment fallback
  after restart. Deleting an Ocean-managed key does not revoke it at DeepSeek and
  does not delete an unrelated external source.
- **Restore requires reconnection.** A restored profile starts inert (`restored`
  state, provider mutations refused, `provider.status` readable). The backup
  contains connection metadata but no secret; a usable provider requires an
  explicit new `provider.set` after rebind. Restored inertness is derived from the
  host `restored` flag, not from a durable inert column (accepted residual).
- **No replay across rotation.** An admitted turn keeps its exact immutable
  provider snapshot; later calls use the newly activated configuration. A check is
  one bounded explicit `GET /models`, never a model request and never retried.
- Owner API over the authenticated socket: `provider.status`, `provider.check`,
  `provider.set`, `provider.disconnect`, `provider.removeSavedKey`. A stop drains
  an in-flight check and refuses new mutations while draining (`runtime_draining`).

### 2. Everyone broadcast versus Note

- **One durable batch.** `Everyone` persists one user message, a frozen recipient
  list, a context boundary and one child run identity per member **before**
  dispatch. Each member gets at most one answer; retries with the same request id
  return the original identities and changed data conflicts. There is no automatic
  follow-up round and no bot-to-bot conversation.
- **Note keeps no-model semantics.** A note is a saved room message with no model
  turn; it stays available while a batch holds the room.
- **States and admission.** Batch states are `open | paused | completed |
abandoned`; children are persisted `queued` and then run. New model turns are
  refused while a batch holds the room (`batch_open`); an uncertain child blocks
  the room until the owner resolves it (`recovery_required`); an ordinary busy
  room is `room_busy`. Notes and history remain readable.
- **Recovery is conservative.** An interrupted batch pauses. An explicit
  owner action with batch id + expected version may continue only
  known-not-started children, and only when every started child has a known
  terminal outcome and no hold remains. Uncertainty is never replayed. Abandonment
  covers only proven-undispatched work; unknown children stay uncertain.
  Cross-client guessing never settles an effect.
- **Limits/known acceptances.** Recovery is polling-based (≤30 s refresh/resync;
  no push contract). The text-only owner-ack invariant test is a proxy; there is
  no separate graceful-stop or restore-time broadcast-mutation end-to-end test.
  Legacy pre-fix `open|paused` batches with unmarked `queued` children have no
  released writer (RC1 has no broadcast; RC2 is this candidate), so they cannot
  exist in a shipped artifact.

### 3. Genuine image input

- **Provider-neutral contract.** Messages carry typed text/image content parts;
  only the DeepSeek adapter maps them to inline `image_url` wire parts. Legacy
  string messages, tool results and ACP stay compatible.
- **Runtime authority, not markers.** The runtime resolves authenticated
  room-bound immutable assets through an I/O port. A Desktop attachment marker is
  a locator hint only; it never grants authority and never reaches the model as
  text. Persisted markers are re-authenticated on every context reconstruction.
- **Hardened marker handling (this fix wave).** Admission refuses any
  marker-bearing body that does not decode or has no completed
  `prepare:<room>:<requestId>` receipt for the same room+requestId
  (`image_unavailable`; a started preparation is `desktop_outcome_unknown`).
  Broadcast submission checks this before the batch or message is written; direct
  turns check it in admission; notes keep their no-model semantics but their
  prepared body follows the same binding. On history reconstruction an
  **unbound** marker (no durable preparation or no message↔request receipt /
  adoption) is inert display text: the marker payload is stripped and the room
  stays usable. A **genuine** image message whose blob, metadata or header is
  missing, replaced, corrupt or oversized still fails closed with zero bytes sent.
- **Budgets.** Ocean attachment limit: 4 files × 10 MiB. Inline request budgets:
  raw image bytes ≤ 34 MiB, pre-check 47 MiB, complete serialized body hard limit
  48 MiB (all UTF-8 incl. base64/history). Sides ≤ 8192 px; the ≥15-image crowded
  rule caps sides at 4096 px (vendor behavior unverified, see below). No Files API
  and no external-URL fallback in RC2.
- **Per-model capability refusal.** Capabilities come from the model table
  (`deepseek-flash` accepts images; `deepseek-v4-pro` is text-only in this
  candidate). A text-only model receives a visible `model_image_unsupported`
  refusal with zero dispatches; no silent metadata-only substitute and no
  automatic model/account switch. In a mixed-capability broadcast the capable
  child gets the actual bytes and the text-only child is refused before dispatch.
- **Recorded limitations.** Native preview is side-only 8192 px; the earlier
  24-MP cap is removed and an 8192×8192 decode can cost ≈268 MB in the Electron
  main process. The 256 KiB pre-SOF scan can refuse metadata-heavy JPEGs. Legacy
  image messages without the durable binding are now inert text rather than
  permanent failures. Tool rounds re-gate the already-verified bytes in memory and
  do not literally rebuild context. Live vendor behavior remains unverified: image
  support in `deepseek-v4-pro` (U6), system/assistant image parts (U7), the exact
  48 MiB boundary at the vendor (U9), animated GIF/WebP (U14), the ≥15-image 4096
  rule, MIME-versus-bytes mismatch and tools+images. The Task 1/3 private evidence
  is the only basis for the few live calls that were made.

### 4. Plugin pilot (Tasks 4–6; install disabled by default)

- **Shipped pinned GitHub catalog.** A declarative, read-only GitHub manifest
  (`list_issues`, `issue_read`) ships in the binary. Installation makes **zero**
  GitHub requests and refuses `already_installed` afterwards; `plugin.repair` is
  the explicit recovery path. Installs land **disabled by default** and only a
  verified copy may be enabled.
- **Named connections and exact grants.** `plugin.connection-add` stores a named
  connection with an environment-variable **reference** (values never cross the
  runtime); metadata discovery requires explicit one-use owner consent before any
  network request. Grants bind exact workspace/room/bot/connection generation/
  tool set/repository, and account identity is honestly labeled verified or
  unverified. Version/endpoint/schema/account changes invalidate prior grants and
  pending confirmations. Restore keeps plugin state and grants inert.
- **Executor qualification and pinning.** `@executor-js/sdk`,
  `@executor-js/plugin-openapi` and `@executor-js/plugin-mcp` are pinned to
  `1.6.11`; `effect` and `@effect/platform-node-shared` to `4.0.0-beta.59`; the
  patched SDK chunk is sha256 `6d3d22c9…` and the patch file sha256
  `e1c1bfa9…`. The patch removes the reactive OAuth refresh-and-replay that could
  produce a second business request after 401. The packaged adapter verifies its
  bundle inventory before admission. `status.execution` is `'disabled'` until the
  owner installs and enables the pinned plugin; the host composition in
  `apps/cli/src/plugin-transport.ts` is the only place that requests execution,
  after re-verifying the pinned chunk, and the setup seam cannot enable it from
  the wire. One allowed invocation causes at most one business request; denied or
  unqualified paths fall back to the disabled transport with zero business
  requests. The build asserts exactly five valid `patch_hash` lockfile records and
  refuses malformed values.
- **Pilot limits.** 1 MiB per message, discovery at most 4 MiB and 256 tools, 30 s
  per call, at most 16 tools per grant, 16 plugin calls per turn, and 32 KiB
  model-visible output with explicit truncation (implemented in Task 6).
- **Elicitation ruling.** The SDK's `source: "policy"` approval is accepted only
  when it names the exact address and canonical arguments of a dispatch already
  in flight in this host; a committed negative test covers the unbound case. That
  is safe for the read-only pilot only. Mutating plugins (stage 5) additionally
  require Ocean's exact-args owner confirmation before claim.
- **Live GitHub gate: UNQUALIFIED.** No approved test connection or repository
  exists, and `gh`/tokens were not used as a substitute. A mocked or loopback MCP
  fixture is not live acceptance. Process-suite children are outside the
  in-process fetch guard; they use loopback/unix sockets only (accepted).

### 5. Desktop and release shape

- **1024 px composer acceptance fix.** The details overlay breakpoint moved from
  1079 to 1023 and the Desktop threshold from 1080 to 1024; at 1024/1280/1920 with
  Details open the composer and Send are visible, reachable and usable. The RED
  measurement for the pre-fix layout was a 45,920 px² composer overlap and a
  1,600 px² Send overlap with hit-testing landing on `ASIDE.details`. At 801–1023
  px with Details opened manually the overlay still covers the composer; that is a
  disclosed pre-existing boundary complaint path, not a qualified state.
- **GUI driver.** The stale pre-merge `qa/entrypoint.mjs` driver was retired; the
  maintained driver is `apps/desktop/qa/current.mjs` against an explicitly
  selected installed CLI. On Wayland, `WAYLAND_DISPLAY` must be an **absolute**
  socket path; a bare `wayland-0` is not qualified. CDP viewport emulation is not
  a physical resize, and real IME behavior is a separate scope.
- **Schema 14 → 17.** Migration 15 adds provider connections, 16 adds broadcast
  batches and 17 adds the plugin catalog/connections/grants. Migration is
  forward-only and transactional. **Rollback is by restore**, never by running an
  older binary on a newer database: an RC1 binary opening a schema-17 profile
  reports `unsupported_schema` and fails closed (verified in the dry-run). A
  compatible backup (format 2, or an RC1-era format-2 envelope) restores into a
  new profile and migrates forward.
- **Maintainable schemas.** Doctor/backup/snapshot without migrating admit every
  released schema (5, 6, 10…14), the branch intermediates 15 (provider) and 16
  (broadcast) that disposable RC2 development profiles can contain, and the
  current 17.
- **Archive.** Deterministic `ocean-1.1.0-rc.2-linux-x64.tar.gz` with exact
  revision, inventory, SHA-256 and licenses; no secrets, caches, profiles, source
  maps or nested `node_modules`. This wave additionally excludes test-only
  compiled modules (`*fixture*`, `*-cleanup*`) and internal `docs/superpowers/`
  planning/session documents, and the packaged adapter manifest no longer
  advertises `.d.ts` files the archive does not ship.

## Gates

Measured on the fix-wave commit bytes (`fix: close the RC2 review wave`), clean
tree, shell Node v26.12.0 for the root gates and Node **v26.13.0** for artifact
work:

| Gate                                | Command                                        | Result                                                                                 |
| ----------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Build                               | `pnpm build`                                   | exit 0                                                                                 |
| Root check                          | `pnpm check`                                   | exit 0 — see the preset rows below                                                     |
| └ typecheck / lint                  | `pnpm typecheck`, `pnpm lint`                  | exit 0, no findings                                                                    |
| └ source preset                     | `vitest run --config vitest.source.config.ts`  | exit 0 — **361 files / 2090 tests passed**, 16 skipped files / 42 skipped tests        |
| └ process preset                    | `vitest run --config vitest.process.config.ts` | exit 0 — **34 files / 127 tests passed**, 16 skipped files / 35 skipped tests          |
| Format                              | `pnpm format:check`                            | exit 0 — all matched files use Prettier code style                                     |
| Strict test typing (not in `check`) | `tsc -p tsconfig.tests.json --noEmit`          | **80 errors / 32 files remaining** (was 97/43; the 17 RC2-introduced errors are fixed) |
| Native/installed/GUI/live           | separate scopes                                | not re-qualified by this wave; see below                                               |

### Strict-test typing baseline (honest classification)

`tsconfig.tests.json` is deliberately **not** part of `pnpm check`. Measured at
the frozen revision `5d2e1c7`: 97 errors in 43 files. Seventeen of them were
introduced by RC2 test files added after `8e3ce79` (image/plugin/provider tests
and fixtures); all 17 are fixed in this wave. The remaining 80 errors in 32 files
are **not a v1.0.0 baseline**: only 3 of the 32 error files existed at `v1.0.0`
(`command.test.ts` 1, `group.test.ts` 1, `review.test.ts` 2 = 4 errors). The
other 76 errors in 29 files were introduced after `v1.0.0` **inside this branch**
by RC1/RC2 work, mostly RC2 provider/desktop suites. They are recorded per file
and left unmodified so the fix wave does not churn unrelated RC1 tests. Full
transcript (`tsc -p tsconfig.tests.json --noEmit`) retained outside Git.

## Evidence provenance

- **Local, reproducible evidence**: the committed source/process suites above,
  run from the clean worktree. They use deterministic providers, loopback HTTP,
  unix sockets and private synthetic profiles; no vendor or GitHub traffic.
- **Private live evidence** (RC1/RC2 task evidence) lives outside Git, never in the
  archive: private profiles, screenshots and vendor transcripts stay under the
  owner-controlled artifacts directory. This wave re-stored the retained RC1-era
  format-2 evidence backup at its authentic `0600` mode (directory `0700`); its
  bytes are unchanged (`sha256 b0bc2562…`) and it was not committed.
- **Dry-run artifacts** (revision `8e3ce79`, Node v26.13.0) prove the rollback
  story: RC1 binary reads `unsupported_schema` on a migrated database; an RC1-era
  format-2 backup restores into RC2 and migrates with data preserved;
  program-level up/rollback leaves profile bytes unchanged. Artifacts **must be
  rebuilt** at the fix revision because the manifest revision changes every
  archive hash; the dry-run hashes therefore do not certify the frozen candidate.
- **Live calls made so far** (private evidence, not repeated here): Task 1 one
  `GET /models`; Task 2 one live two-bot broadcast (2 provider calls); Task 3
  vision acceptance 3 images / 3 calls plus one GUI call and an earlier disclosed
  round of 3 = 7 calls. No other live vendor traffic. **No live GitHub call was
  made.**
- **Skips are not passes.** Native sandbox/native-GUI suites, live DeepSeek
  behavior and the live GitHub path remain separate qualification scopes; skipped
  tests are reported as skips and never as passes.

## Explicitly unqualified gates

1. Live GitHub / Executor plugin execution — no approved connection or repository;
   execution stays disabled and the live gate is visibly unqualified.
2. Live DeepSeek behavior of RC2 features (image U6/U7/U9/U14, the ≥15-image 4096
   rule, MIME-versus-bytes, tools+images, `GET /models` billing/limits) — only the
   retained private Task 1/3 evidence supports these.
3. Real native/GUI/installed acceptance at the frozen fix revision — the frozen
   rebuild, disposable install/migration/rollback, installed CLI/TUI/ACP and
   Electron GUI runs remain the release gates of Task 8.
4. RC1 binary against a migrated schema-17 profile beyond the dry-run record.
5. Live GitHub chat read (Task 6): no approved test connection/repository; unqualified.
6. Native shard/native-skip coverage — not re-executed; skips remain skips.
7. Disk-backed `TMPDIR`/native filesystem portability (RC1 §A6) — not re-probed.
8. Vue/Electron wiring beyond helper tests — no Vue harness; Task 7 GUI runs are
   the only evidence.
9. Mixed-capability broadcast panel display in the GUI — probe-level only.
10. `status`/`stop` against the owner's live installed runtime — deliberately not
    exercised.
11. Publication (remote commit/tree, uploaded/downloaded hashes) — not part of
    this wave.

## Known limitations and accepted rulings

- `provider.check` for an external credential reports `persisted: false`; restored
  inertness rests on the host `restored` flag, not a durable column.
- Broadcast recovery remains polling-based; the text-only owner-ack invariant is
  proved by a proxy; no separate graceful-stop or restore-broadcast E2E.
- Legacy pre-fix abandoned batches with unmarked `queued` children cannot be
  written by any released artifact (RC1 has no broadcast).
- Malformed persisted `secret_ref` recovers as `invalid_input` (requires DB
  tampering); Vue provider/plugin settings wiring is helper-tested only (no Vue
  harness); an interrupted credential rotation can leave an inert unreferenced old
  secret reference (store is `0600`); the retired-model hint can mask a
  simultaneous provider outage (wording only).
- The token-sealed internal constructor and `createInternalTransport` appear in
  the adapter `.d.ts` but are unreachable at runtime; Task 6 wires the public
  plain-options seam (`resolveCredential`/`provision`) and does not widen it.
- `source: "policy"` elicitation acceptance is safe for the read-only pilot only;
  stage-5 mutating plugins require exact-args owner confirmation (Task 6 gate).
- Process-suite children are outside the parent in-process fetch guard; they use
  loopback/unix sockets only.
- Known non-reproduced flake: "only one simultaneous ordinary restart can retire a
  predecessor" (`process.test.ts`); keep it as a recorded flake, never weakened to
  pass.
- Desktop audit parts 4–6 never appeared; nothing was invented to replace them.
  The 801–1023 px manual-Details overlap is disclosed, not qualified.
- The 8192 px preview decode cost and the 256 KiB pre-SOF scan are disclosed
  image limitations, not passes.
- The restore-mode maintenance allowlist contains `decisions.resolve`. It is
  load-bearing: `restore.preview` opens the rebind confirmation card inside that
  maintenance host and the owner answers it over the same socket, so removing the
  entry breaks restore/rebind confirmation (seven regression tests). The contract
  comment now names it as the only admitted mutation, and a regression test pins
  that no model turn, tool, provider/plugin mutation or broadcast mutation is
  admitted.

## Consolidated fix wave (this candidate)

The final whole-branch review found the candidate **NEEDS FIX** (2 Critical, 3
Important, 13 Minor, 8 Info). Two Critical defects were already fixed before this
wave (`0f0af49`: broadcast prepared-marker refusal ordering, stale release-test
expectations). This wave closes the rest:

- **I3 marker hardening** — unbound/forged prepared markers are refused before
  write on direct, note and broadcast paths and become inert display text on
  history reconstruction; genuine corrupt/missing assets still fail closed.
- **I2 tooling** — stale `qa/entrypoint.mjs` retired; its three documentation
  references now point at the maintained `qa/current.mjs`.
- **M2** — graceful stop now supervises and drains provider settings and plugin
  surfaces; in-flight checks/discoveries are awaited (bounded) and new mutations
  refuse `runtime_draining`.
- **M3** — `MAINTAINABLE_SCHEMAS` admits the branch intermediate schema 15 and the
  stale "one step wide" comment is replaced by the real rule.
- **M4** — the two over-cap RC1 test files are split under 300 physical lines, as
  is the regression file this wave's earlier fix had grown past the cap.
- **M5/M6** — the release archive excludes test-only compiled modules
  (`*fixture*`, `*-cleanup*`) and internal `docs/superpowers/`; packaging tests
  cover both.
- **M7** — the build requires exactly five valid `patch_hash` records and refuses
  malformed values.
- **M8** — the packaged adapter manifest no longer advertises unshipped `.d.ts`.
- **M9** — the retained private evidence backup was re-stored at authentic `0600`
  (bytes unchanged, outside Git).
- **M10/M11** — crash-matrix sandbox-suite count corrected to 14 (16 files with
  the workflow/dispatch natives) and the vestigial/row-11 citations annotated.
- **M12** — patch re-derivation wording/step fixed, the shipped OAuth setup path
  now has a committed `oauth_setup_unavailable` negative test and the unbound
  policy-elicitation case has committed coverage.
- **M13** — unused public `desktopMetadata` export removed;
  `ConversationServiceDeps` wording corrected (the TUI never opens a durable
  profile; the offline CLI keeps the checks but refuses at admission instead of
  pre-write).
- **Strict-test typing** — the 17 RC2-introduced errors are fixed; the remaining
  80 are recorded per file as branch-introduced after `v1.0.0`, not a `v1.0.0`
  baseline.
- **M1 ruling** — recorded above; the review's removal suggestion would have broken
  the rebind confirmation path, so the entry stays with a corrected contract and a
  regression pin.

## Task 6 — plugins through actual chat (integrated)

Task 6 is integrated, independently delta-reviewed, and part of this candidate. It adds the
read-only GitHub pilot path: a granted bot in a granted room can read issues from exactly one
repository through a normal Ocean chat turn. It adds no write operation, OAuth/PKCE, second service
or external catalog.

### Granted tools

- `packages/application/src/plugin-turn-tools.ts` resolves **only the addressed bot's active grants in
  the addressed room** and returns the existing `TurnInput['tools']` shape (`definitions`,
  bounded `instructions`, `execute`, `cleanupConfirmed: true`). The model sees only granted tool
  names/schemas; a hallucinated name is refused before any claim.
- The same source is used by normal (non-coding) room turns **and** broadcast children. Each child
  resolves only its own bot's grants: no sibling/room leak and no coding authority. A child without a
  grant behaves exactly as a plain text turn. Coding turns keep only the existing coding tools; ACP is
  unchanged.
- Immutable name→(plugin, connection, generation, endpoint, tool, schema digest) binding comes from
  the grant/connection rows; transport arguments are re-derived from the grant, never taken from model
  output as authority.

### Transport and admission

- The real pinned Executor transport is wired in `apps/cli/src/plugin-transport.ts` — the only place
  that requests `enableExecution: true` — after re-verifying the pinned patched chunk per admission and
  deriving the adapter build identity from `qualification().identities`.
- Owner single-use metadata consent precedes the upstream connection: `discover()` calls the pure
  declarative provisioner only after Ocean consumed the consent, and `invoke()` never provisions.
- Admission runs one SQLite `BEGIN IMMEDIATE` transaction that rechecks membership, grant
  active/revocation, exact connection generation, published schema digest, enabled/verified plugin
  version, adapter build, repository constraint and credential presence, claims through
  `SqliteToolJournal.claimNow` **and** inserts the durable operation row in the same transaction. Only
  after commit does exactly one transport invocation happen. Settlement updates the operation row and
  journal atomically; a settlement failure downgrades to `uncertain` (the claim keeps blocking replay).
- Startup recovery lowers crashed `started` rows to `uncertain` — never to success, never to a replay
  permission.

### Durable operations and owner resolution

- Migration **18** adds `ocean_plugin_operations` (one row per admitted invocation) with the immutable
  binding, state (`started | observed | failed | not_started | uncertain | acknowledged`), bounded
  argument copy/result summary/byte counts/truncation flag, monotonic revision and timestamps.
  `SCHEMA_VERSION = 18`; `MAINTAINABLE_SCHEMAS` also admits 17. Migration, rollback and
  preservation of a genuine schema-17 profile are tested; the profile-backup manifest admits 18.
- `plugin operations list|show|acknowledge` is shared by CLI, TUI and Desktop. `acknowledge` is
  explicit and versioned (expected-revision compare-and-set), keeps the uncertain record and its
  original outcome code, releases exactly that effect's global journal hold, and never claims remote
  certainty or retries. Restore-mode hosts serve `list`/`show` and refuse `acknowledge`
  (`restore_restricted`).
- While an uncertain operation holds the journal, further plugin claims are refused; ordinary text
  turns are unaffected.

### Limits

16 plugin calls per turn (the 17th is visibly refused before admission/claim); 32 KiB model-visible
output with an explicit UTF-8 byte-counting truncation marker (`[truncated: kept X of Y bytes]`);
1 MiB request cap and 30 s per-call deadline enforced by the transport; bounded durable arguments
(≤4 KiB) and result summaries (≤8 KiB); argument validation against the granted schema before claim.

### Deterministic verification (local servers, real Task 4 adapter)

All counters are MCP JSON-RPC over loopback; `tools/call` is the business request, every other method is
discovery/session traffic. The allowed path (dev bot + work connection + one-repository grant reading an
issue in normal chat) produced **exactly 1** `tools/call` with one durable `observed` operation and
bounded output in each of: the real-adapter MCP integration test, the Desktop GUI, the CLI and the TUI.
Every denial path produced **0** business requests: review bot without a grant, dev in another room,
personal connection, another repository, ungranted/upstream-write tool name, revoked grant after tool
resolution, restored old permission, stale connection generation, schema/plugin-version change, and a
two-client race between resolution and admission.
A dropped reply after dispatch produced exactly one attempt, one `uncertain` operation, and a retry
under a different request identity was refused by the journal with zero further requests; a SIGKILL
after claim is recovered as `uncertain` and never redispatched; acknowledgement releases the hold
without retrying.

### Desktop, CLI and TUI

The same runtime services back all three clients. The Desktop "Плагины" settings surface pre-dates this
stage; Task 6 adds the chat-time tool activity and the operations view, showing state, tool, exact
connection generation, repository, immutable endpoint, bounded arguments/result and timestamps — no
credential value and no raw provider payload.

### Live GitHub gate — UNQUALIFIED

No explicitly owner-approved test GitHub connection/repository exists, and neither `gh` nor any other
application's token was used. Execution ships disabled by default. A guarded driver
(`apps/desktop/qa/github-live-qualification.mjs`) exits `3` with "external prerequisite missing" unless
`OCEAN_GITHUB_TEST_TOKEN_REF` (an environment variable name) and `OCEAN_GITHUB_TEST_REPOSITORY` are
supplied by the owner; local loopback MCP/OpenAPI traffic is never presented as live GitHub acceptance.
The pinned card declares exactly `list_issues` and `issue_read` with a one-repository constraint; the
OpenAPI local qualification path uses a different (path-derived) tool naming, so it is recorded as
transport qualification only, not as card acceptance.

### Known limitations of this stage

- The live GitHub read path remains unqualified until the owner supplies an approved test connection
  and repository (enablement steps below).
- Process-suite child processes are outside the parent in-process fetch guard (they use loopback/unix
  sockets only).
- Mutating tools remain stage-5 work: they require Ocean's exact-args owner confirmation before claim;
  the read-only pilot's policy-source elicitation acceptance is not sufficient for them.
- A captionless legacy unbound-marker message reconstructs as empty model content (no bytes, paths or
  authority leak; live-vendor acceptance of empty user content is unverified).

### Owner enablement steps for the live GitHub gate

1. Owner creates a dedicated test connection and **one** test repository, and explicitly approves them
   for qualification (no credential import from another application).
2. Set `OCEAN_GITHUB_TEST_TOKEN_REF` to the name of an environment variable holding that connection's
   token, and `OCEAN_GITHUB_TEST_REPOSITORY=owner/name`; install and enable the pinned plugin (disabled
   by default), add a named connection with that environment reference, consent once to metadata
   discovery, then grant `list_issues`/`issue_read` for that repository to the test bot/room.
3. Run the guarded qualification driver and a chat read; record requests, results, refusals and
   uncertainty separately from the loopback evidence.
4. If any step is unavailable, keep the gate unqualified — do not present mocked GitHub traffic as live
   acceptance.

## Installed RC2 acceptance (2026-11-04)

Performed on the owner's machine with the exact artifacts above and Node **v26.13.0**. The owner's
real profile was migrated in place (validated format-2 pre-upgrade backup + raw copy retained
privately), RC1 remains installed under `releases/1.1.0-rc.1`, and the launcher, systemd unit and
`0600` key file are byte-unchanged.

- **Migration/data preservation.** Pre-upgrade profile: schema 14, 3 rooms, 2 bots, 22 messages,
  9 chat turns. After the RC2 runtime start: schema 18 with the same 3 rooms / 2 bots / 22 messages /
  9 turns, and the plugin-operations table present. The installed client reads the rooms, bots and
  history through the shared runtime. The pre-upgrade format-2 backup restores on a disposable
  profile into schema 18 with the same counts.
- **Provider connection.** Installed runtime reports `source: external` (environment key, never
  persisted), `state: connected`, `model: deepseek-flash`, advertised models
  `deepseek-flash`/`deepseek-v4-pro` with image-input capability metadata. One bounded live
  `GET /models` check: HTTP 200, 850 ms, `modelSupported: true`, `persisted: false`.
- **Real application.** The installed Desktop (RC2 release path) starts through the real launcher,
  shows the owner's rooms and history with the details panel and composer accessible, and leaves the
  runtime ready.
- **Installed GUI layout.** On the installed Desktop binary with a private synthetic profile,
  viewport-emulated at 1024/1280/1920 with Details open: zero overlap between the details column and
  the composer/textarea/Send, the Send hit test resolves inside the composer, and the composer is
  reachable at all three widths (1024: details column at x=814 w=210, composer x=220 w=594; no
  overlap). This is the release-blocking 1024 correction verified on the shipped artifact.
- **Two-bot broadcast (installed, private profile, real DeepSeek).** One `Everyone` broadcast produced
  exactly one user message, one answer from each of two bots (`dev`, `review`), exactly **2** live
  model requests / durable usage events, no follow-up round, and no plugin tools.
- **Genuine image vision (installed, private profile, real DeepSeek).** Three real images through the
  installed runtime and adapter: the photograph (cat; tabby coat, sitting on a stone ledge, green
  eyes), a spatial/color diagram (blue circle bottom-right, red square top-left) and a real
  application screenshot. All three HTTP 200 with correct answers against pre-recorded ground truth;
  the recorded request bodies contain the source bytes (decoded image SHA-256 equals the source
  SHA-256 for every image), no attachment marker text, and historical images are re-resolved on later
  requests (1 → 2 → 3 images). Exactly **5** live model requests total across broadcast + images,
  **5** durable `attempt.usage_recorded` events, **0** tool events.
- **Plugins (installed, private profile).** Catalog list/install/enable/disable and a named
  environment-reference connection work on the installed artifact (generation 1, identity honestly
  `unverified`, `consented: false`), and `plugin operations list` is served. No metadata discovery
  was performed against GitHub, and no real GitHub traffic was made.
- **Credential boundary.** The DeepSeek credential was only ever sourced inside private subshells;
  an exact-value scan of the private fixtures is clean, and nothing secret appears in SQLite,
  recorded evidence, or this document.

### Environment repair performed during the update (disclosed)

After an ordinary reboot the owner's Desktop asset binding failed its filesystem-identity check
(`device` 54→53 and mount id 60→59 changed; inode, uid, gid and mode were identical), which made
Desktop asset reads and format-2 backups refuse. With a raw profile copy and a validated backup taken
first, the binding identity was re-anchored atomically to the observed identity of the same inode
(`metadata` update guarded by the exact old value; `quick_check` and `foreign_key_check` clean). This
is a disclosed environment repair, not a product feature: the product has no self-repair for device
identity drift, and a future reboot that changes the device mapping can require the same disclosed
repair. Matching inode/uid/gid/mode alone does not prove filesystem, subvolume or
inode-incarnation continuity and is not a safe automatic repair plan. The stable
follow-up implements a versioned Btrfs namespace/file-handle anchor and an exact,
exclusive-owner legacy migration; already-drifted roots and legacy ready lineage
still require explicit backup/restore/rebind recovery. See the
[durable binding contract](../integration/desktop-assets.md#durable-binding-in-the-stable-11-implementation).
This paragraph preserves the RC2 repair as historical evidence, not a supported
four-field re-anchor mechanism.

## Release decision

**Candidate accepted for RC2; stable 1.1 is not complete.** The whole-branch review and fix wave,
the Task 6 delta review and its fix wave, frozen artifacts with reproducible SHA-256, disposable
migration/rollback, and installed RC2 acceptance (migration, provider check, two-bot broadcast,
genuine vision, installed GUI layout at 1024/1280/1920) are complete for this candidate. Remaining
open items are recorded honestly: the live GitHub account/repository gate is **unqualified** (no
explicitly approved test connection), the native/source-preset sharded qualification was **not
re-run at this frozen revision** (RC1 native evidence is retained for unchanged modules; skips are
not passes), the Windows/macOS/proxy and some vendor behaviours remain unverified, and publication of
the candidate is a separate step recorded with the release report.
