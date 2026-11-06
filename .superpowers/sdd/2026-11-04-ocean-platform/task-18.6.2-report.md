# C18.6.2 retired SDK removal report

Status: DONE_WITH_CONCERNS — implementation and required removal qualification pass; independent controller review remains required. Parent C is open until that review and requirement reconciliation are accepted.
Base `03e4082eb4b1c1ccd874c58793254b60f25b8c67`, branch `codex/ocean11-stable`.
Private proof root: `/home/ryltsevmg/Projects/Ocean-artifacts/c18.6.2-r5z2g4g5`.

## Inventory recorded before deletion

The exact pre-removal test bodies and input SHA-256s are retained in `pre-removal-tests.txt` and `base.json` under the private proof root. This map distinguishes product semantics from retired mechanisms. The existing current suites remain enabled; no product test is skipped or excluded by this retirement.

| Retired family | Retained semantic coverage or explicit retirement |
| --- | --- |
| `counters.mcp`, `counters.synthetic`, `dispatch` | Current MCP `transport.test.ts`, `prototype-http.test.ts`, `normal-turn.test.ts` cover one SDK/business attempt, 401/403/404, vendor errors, 5xx/drop/timeout/abort uncertainty, no replay, claim identity and duplicate exclusion. Synthetic OAuth refresh grants and Executor vendor envelopes are retired implementation mechanisms; current direct MCP has no automatic OAuth fulfilment. |
| `counters.openapi`, real adapter OpenAPI test/fixture | Explicit nonproduct retirement: OpenAPI plugin production and Executor policy acceptance are removed, not claimed as migrated OpenAPI support. Generic one-effect/no-retry outcomes remain covered by current MCP counters. |
| `guards`, `guards.transport` | Current domain `service-authority.test.ts` validates credential-free exact endpoints and bounded JSON; MCP `normal-turn`, `transport`, `preflight` and HTTP guard regressions cover request/catalog/response bounds (including canonical args below1MiB with the actual public SDK envelope above1MiB), redirects, fixed target, denied credential access, deadlines and cancellation. Old fixed SDK origin configuration is replaced by the current connection's exact endpoint. |
| `catalog.discovery` | Current MCP `transport`, `admission`, `route-refresh`, SQLite service-eligibility/service-authority-storage suites cover complete-only publication, duplicate/oversized/malformed catalogs, explicit refresh, stale candidates and exact versions. |
| `mcp-dispatch-guard` | Current MCP `transport`, prototype HTTP lifetime/concurrency cases, `retirement-race` and normal-turn tests cover no hidden metadata/retry, independent concurrent send receipts, not-started before send and uncertainty after send. SDK private guard internals retire. |
| `elicitation-binding` | SDK-specific policy-source matching retires. Current MCP input-required case refuses fulfilment; owner-scope/service-confirmation suites retain sole current owner admission and model self-approval refusal. |
| `gate`, `setup`, `imports`, `bundle-integrity` | Old SDK pins, private access seams, setup tokens, default execution flag, patch hashes and source-vs-bundle runtime qualification retire. Current MCP production module allowlist, pinned public SDK/imports, release inventory/lock drift/tamper and standalone installer controls retain replacement qualification. No old SDK fallback remains. |
| `test-network-guard` | Pure test infrastructure; moved unchanged to tools-node, still enabled. |
| CLI `plugin-transport`, `plugin-real-adapter-mcp`, `plugin-real-adapter-denials` | Development composition and old qualification pins retire. Current normal-turn, runtime MCP/result/retirement process tests, service admission/resource/eligibility tests cover actual one-send calls, room/bot/connection/tool/repository scope, revocation, stale generations and unknown holds. Legacy disabled runtime/history compatibility suites remain. |
| CLI `plugin-dispatch-once`, `plugin-discovery-snapshot`, `plugin-session-authority` and old session rig | Current MCP transport covers 404/header mismatch without replay; account prototype/route-refresh plus service-owner credential/destination/restart and authority storage suites cover immutable accounts, credential revision continuity, version CAS and zero unauthorized sends. The old two-tool frozen GitHub card/header string is retired product wiring: current pilot deliberately authorizes only `issue_read`, tested by current destination/installed evidence. No old grant is promoted. |
| Legacy release `bundle.test`, `legacy-bundle` producer | SDK-built executable qualification/pin fixtures retire. Current `mcp-bundle`, package/installed/installer tests retain deterministic production bundling, dependency closure and tamper refusal. Historical archive acceptance uses small structural inputs and unchanged existing installer validation; it does not claim historical runtime boot. |
| Protected catalog3 | Accepted port stays untouched: CLI `plugin-catalog-lifetime.test.ts` covers frozen full definitions past TTL, separately authorized owner refresh and delayed initialization drain; MCP `route-refresh` preserves selected definition/account/trust/key/grant checks. C18.6.1 review Minors remain F. |

## Scope and retained history

Pure neutral ports, legacy profile rows/history/import, owner reconciliation, unknown holds, current MCP adapter/admission/settings/clients remain in place. LICENSE and historical notices remain. External accepted C18.6.1 proof is read-only; no real profile, credentials, launcher, unit or live service is used.


## Demonstrated coverage gap and bounded correction

Before deleting the old producer, `counters.mcp.test.ts:136` was inspected: arguments just below1MiB must not produce a tools/call when the serialized SDK envelope exceeds1MiB. Current `Session.invoke` bounded only argument serialization. The controller approved a direct `serviceHttp` check using the existing application constant before `writer.prepare`, admission or fetch. No API, layer, dependency or policy was added. The regression observes the actual public SDK envelope, global fetch calls, peer business/effect counts and preparation calls independently. Proven no-send maps to `not_started`; the retired SDK's pessimistic `uncertain` outcome is not copied. Separate response/catalog4MiB bounds stay covered.

This is the only current production execution change. HTTP counter/drop controls and final root/package qualify it; unchanged stdio/native/live inputs are compared to accepted18.6.1 and do not require repeating those matrices. The release bundler's whole-lock SHA also changes because the retired closure is removed.


## Source, removals and dependency closure

Source commit `1f31974466425abc6d7aeca2ded8d3576bc4f304` contains the exact owned paths recorded in `Q/owned-source-paths.txt`, including the controller-approved canonical plan Files update. No push/merge/publication. The report/status follow-up is documentation only and does not change this qualified archive source.

Removed the entire `packages/integrations-executor` source/workspace, its `@executor-js/sdk@1.6.11` patch and patch recipe, CLI development transport, old OpenAPI/MCP producers/fixtures and SDK-only qualification tests. Direct retired requirements were `@executor-js/sdk`, `@executor-js/plugin-mcp`, `@executor-js/plugin-openapi`1.6.11, `effect`/`@effect/platform-node-shared`4.0.0-beta.59, plus the CLI workspace development link. Root and CLI TypeScript references, test alias entries, workspace override/patch/allowBuilds settings and lock importer/link records are gone. There are no remaining Effect/msgpackr consumers in the pruned lock, so their settings were removed.

`Q/lock-closure-comparison.json` lists all199 removed resolution records:455→256 main-lock packages/snapshots. The separate pnpm tool lock document is unchanged. All surviving package resolution/integrity records are identical; jiti2.7.0/yaml2.9.1 snapshots only become optional after their former required consumer disappears. Actual clean install downloaded231 packages into this task's own store and covers15 workspace projects. It used pnpm12.16.1, Node26.13.0, TypeScript5.9.3, Rolldown1.2.16, public MCP client/core2.4.0. No shared cache or retained external qualification input was deleted.

LICENSE bytes and the full historical Executor MIT text in NOTICE are unchanged (`Q/pins-final.json`). NOTICE now explicitly labels the old patch/runtime description as historical; deleting its duplicated package-local notice does not lose the license text. Current MCP third-party notices stay installed. Historical RC2 docs and Git history remain historical records.

## Final exact-source gates and archive

Every install/test/compiler/build/package/qualification command used the unchanged absolute private runner `P = python[3] /home/ryltsevmg/Projects/Ocean-stable/.superpowers/sdd/2026-11-04-ocean-platform/run-private.py`, SHA256 `adc3adf372fa77a694f4a4272a5f13e615646886356e1db0045767dad0d228a3`. Fresh HOME/all XDG/TMP/minimal environment apply to child tools too. `Q = /home/ryltsevmg/Projects/Ocean-artifacts/c18.6.2-r5z2g4g5`. `S` is the original stable workspace; `C=Q/source` is the independent clean detached exact-source clone. All final gates18–31 ran from C through P; `Q/commands.jsonl` records exact argv/workdir/exits/duration.

| Gate/log | Exit | Result |
| --- | --- | --- |
| 18-clean-frozen | 0 | actual `pnpm install --frozen-lockfile --store-dir Q/store`, no node_modules source links or compiler substitute |
| 19-clean-root-check | 0 | `pnpm check`: main + Node/Desktop test strict compilers, lint, source3691pass/44 existing skips, process165pass/36 existing skips |
| 20-clean-format | 0 | literal root `pnpm format:check` |
| 21-clean-build | 0 | literal root `pnpm build` |
| 22-clean-package | 0 | `node apps/cli/dist/release/package.js 1.1.0-c18.6.2 Q/package` |
| 23-standalone-install | 0 | emitted standalone installer, exact archive/checksum, only disposable `Q/prefix` |
| 24-installed-types | 0 | actual installed bare first-party d.ts with strict TypeScript, `skipLibCheck:false`, no aliases/NODE_PATH/source first-party declarations |
| 25-installed-imports | 0 | actual bare tools-node/contracts/current MCP imports; adapter exports only createMcpServiceTransport |
| 27-installed-offline | 0 | CLI init/bot/room/doctor/offline send/history; runtime start/status/stop; actual TUI PTY/terminal restoration; ACP initialize/session/prompt |
| 28-installed-http | 0 | actual installed MCP bundle, wire cap zero-fetch/zero-effect, independent healthy/drop controls |
| 31-final-inventory | 0 | exact archive/installed inventory, hashes/modes, dependency closure, actual d.ts resolution trace, source physical lines and clean Git |

Archive `Q/package/ocean-1.1.0-c18.6.2-linux-x64.tar.gz` SHA256 `5fdcd2b6eba91554cc0dd78bb856fabd3873c0dd5630f244a619b23a2d017d2c`.
Lockfile SHA256 `e256cd1c328340ff2ce064001ef7ecc68efefb6ff570849c7633eda5e3a45878`.
Installed MCP entry SHA256 `23cbe2e8e7f4a0819d6e22d929adfc0e735621cf1b20e2faee9f06877bc9c60b`;
integrity record SHA256 `1ed9bd40f67fa8cf447290b9e999ea136816fe9b98f3421944d6aa8eaafbeb47`.
All1261 installed/archive files (525 declarations,14 package manifests) match exact hashes/modes. Inventory has no Executor package, patch, CLI development composition, retired producer, test or MCP qualification/prototype code. Historical neutral ports remain intentionally present. Every runtime dependency resolves to an installed first-party package; adapter external SDK bytes are bundled and pinned. Public SDK identities/digests exactly equal accepted18.6.1. See `Q/archive-manifest.json` and `Q/installed-inventory.json`.

All1525 tracked TypeScript sources in the clean revision are <=300 physical lines (maximum300); new historical-installer162, http-guards100 and moved guard37. `Q/source-line-counts-final.json` records every exact count. No line-limit exclusion was added. Source and stable Git are clean after packaging; installed temporary consumer/probe modules were removed before inventory verification, and their exact inputs stay at Q root. The disposable prefix/offline synthetic profiles and proof store are retained for review; runner temporary homes were removed. Probe-owned HTTP/runtime/TUI/ACP children were joined/closed by their finally paths; no new real install/profile/key/unit was used.

## Historical and current semantic verification

`historical-installer.test.ts` builds small structural archives with an entry, second chunk, integrity record, legacy adapter identity and complete outer hash/mode inventory. Thirteen tests cover acceptance/repeat/upgrade/rollback, installed-file tamper, wrong adapter/entry/integrity path or digest, missing integrity/license/package/SDK identity/entry inventory, outer chunk-hash/mode mismatch, and actual emitted standalone acceptance/stale digest refusal. The production installer itself is byte-for-byte unchanged. Historical inner manifest checks retain exactly their former rules; these inputs do not claim a valid SDK runtime, executable historical boot or stronger historical chunk rules than the installer actually has.

Current mcp-bundle/process package/installed controls retain production module allowlist, deterministic inventory, actual resolution/lock integrity drift refusal, modern policy omissions/pins/tamper, standalone install and offline upgrade/rollback behavior. Replacing the deleted process bundle family with the structural historical family adds no skip/exclusion; original modern controls remain enabled.

The new source HTTP tests pass5 cases, and the focused surrounding MCP counter/normal-turn/retirement set passes59. Actual installed `Q/installed-http.json` records arguments1048575bytes, full SDK envelope refused before preparation/fetch: `not_started`,0fetch/0peer-call/0effect. An explicit fresh metadata session then gives one healthy business call/effect (`observed`) and one dropped-response call/effect (`uncertain`), with exactly2 total business fetches/peer calls, no replay. This probe directly qualifies the changed bundled HTTP boundary; durable normal-turn claim/unknown-hold semantics are additionally covered by the root/source/process suites, not inferred from this direct-port probe.

`Q/production-input-comparison.json` compares739 retained non-test src files to acceptedffeb3d3:735 are byte-identical. The four changes are the HTTP guard, the release full-lock pin and two documentation comments. Current stdio/native, admission, owner settings/clients, persistence and migration inputs are unchanged. Of installed JS/declarations only MCP index and the historical port's comment-bearing JS/d.ts differ. Thus accepted C18.6.1 native/ready-filesystem/live GitHub proofs remain attributed to their original source/archive, rather than being relabeled as fresh runs. The only changed execution behavior has new source+installed HTTP qualification. No live model/GitHub/key read or repeated unchanged positive full matrix occurred.

## Earlier commands, failures and corrections

Logs/exits are retained; no failed run is called passing. Gates01–16 ran in S through P. Initial formatting commands used `pnpm exec prettier --write` on explicit owned paths (02,06,10,13,16); all exited0. The pre-install root/source read/clone/inventory preparation scripts are not compiler/test substitutes.

| Log | Command after P | Exit / evidence |
| --- | --- | --- |
| 01-lock-prune | `pnpm install --lockfile-only` | 0 |
| 03-workspace-frozen | `pnpm install --frozen-lockfile` | 0 |
| 04-focused-source | `pnpm exec vitest run --config vitest.source.config.ts packages/integrations-mcp/src/http-guards.test.ts packages/tools-node/src/test-network-guard.test.ts` | 0,6pass |
| 05-test-types | `pnpm typecheck:tests` | 2; mutable structural fixture bundle map lacked a string index signature; corrected locally |
| 07-build-focused | `pnpm build` | 0 |
| 08-focused-installer | `pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/release/historical-installer.test.ts apps/cli/src/release/mcp-bundle.test.ts` | 0,15pass |
| 09-test-types | `pnpm typecheck:tests` | 0, strict Node+Desktop |
| 11-wire-regression-red | `pnpm exec vitest run --config vitest.source.config.ts packages/integrations-mcp/src/http-guards.test.ts` | 1; initial test still supplied small wire-case arguments; this run alone is not evidence of the exact boundary |
| 12-wire-exact-red | same Vitest command | 1; exact under-cap arguments reached1business fetch instead of0, proving the missing full-envelope cap. A secondary response-case failure came from the un-restored spy after that assertion; spy restoration was corrected |
| 14-http-green | `pnpm exec vitest run --config vitest.source.config.ts packages/integrations-mcp/src/{http-guards,transport,prototype-http,normal-turn,retirement-race}.test.ts` | 1; guard initially imported request constant from domain instead of application, so actual send still occurred; import corrected |
| 15-http-green | same covering Vitest command | 0,59pass |
| 17-clone | local independent no-hardlinks clone, detached exact1f31974 | 0; no stable branch/worktree mutation |
| 26-installed-http | same installed HTTP command as28 | 1; probe tried to reuse an SDK session retired by its rejected send. Corrected probe explicitly discovers a fresh session for independent healthy/drop controls; no source/archive change |
| 29-final-inventory | same inventory command as31 | 1; overbroad qualification filename regex incorrectly rejected existing product model-local-qualification.d.ts; corrected to the MCP development-module path and exact CLI composition name |
| 30-final-inventory | same inventory command as31 | 1; trace assertion used current symlink rather than TypeScript's canonical release path; corrected to actual prefix release path |

A command launch using the not-yet-created clean clone as cwd was rejected before execution; it made no filesystem change. Clone/install were then performed sequentially. Initial one-document YAML inspection also failed because pnpm lock contains separate tool/workspace YAML documents; the final comparison explicitly parses both and asserts the tool document unchanged. These preparation mistakes do not alter a product gate. No policy/installer validation or test expectation was relaxed to accommodate product failure.

## Reconciliation of all five parent18 requirements

| Parent requirement | Accepted children and retained evidence | Removal checkpoint status |
| --- | --- | --- |
| Public MCP prototype first, HTTP/stdio/drop/refresh/no repeated effect |18.1 accepted79bbce9;18.4 production transport165e1c0/hostd35e28a; accepted18.6.1 installed archiveffeb3d3 | SDK pins unchanged; current source+installed HTTP counters additionally cover the narrow envelope defect; native inputs unchanged |
| Persistent trusted owner scope, current admission and durable claim |18.2 contracts/store7bbb502;18.3 admission/normal codingb868d32;18.5.1 settings4798c95;18.5.2 confirmcea61a4;18.5.3.1 client925db6f | Pure/domain/application ownership retained; root normal-turn/scoped journal/resource/confirmation/owner controls pass; no new grant or authority inference |
| Restart/revoke/delayed dispatch, new tools and endpoint/account boundaries |18.3/18.4 plus18.5 credential/destination/restart controls;18.6.1 catalog/route ports and actual installed kill/recovery | Current authority/storage/lifecycle inputs unchanged; old records/unknown holds remain; zero unauthorized send and unknown/no-replay regressions stay enabled |
| Ready server by configuration, real GitHub read, stdio and synthetic write failure |18.1 and18.4 native/live;18.5 ready owner configuration;18.6.1 actual installed ready filesystem/GitHub/HTTP/drop/kill proof, archivebb590273… | Reuse exactly attributed accepted native/live evidence; installed current HTTP healthy/drop plus offline/client tests pass; OpenAPI producer explicitly retires, not migrated support |
| Conservative GitHub pilot migration; only remove SDK/patch after packaged replacement; preserve catalog-lifetime intent |18.5.3.2 import83c0719;18.6.1 accepted5450b4d (qualified sourceffeb3d3), current protected catalog3 retained | Retirement source1f31974 follows acceptance. Structural historical installer controls retain exact validation; clean package and dependency closure remove SDK/patch/dev graph. Controller review still required before parent C acceptance |

These requirements are reconciled for independent review, not marked accepted by the writer. All deferred Minors/Rulings, including18.6.1 named-binding report precision and optional connection-clone simplification, remain mandatory F. SDK deletion does not close typing/native/device/restore/release acceptance gates. No D/G expansion, schedules, Sources, marketplace, universal OAuth or CLI agents.

## Self-review and concerns

The patch is deletion-led: no new API/table/engine, unchanged installer policy and neutral historical ports; the demonstrated HTTP bound uses the existing constant at the existing writer boundary before asynchronous preparation. Product regressions have explicit current coverage or stated nonproduct retirement. The two historical/current archive formats remain distinguishable, and a dropped effect remains unknown without retry. All final gates are green on exact source; the only current execution delta has direct source and installed counter controls. The substantive remaining concern is acceptance process: independent controller review/parent C closure and later F gates remain open. The historical structural fixture is intentionally not a historical runtime boot qualification. No hidden credentials, real databases or sensitive transcripts are committed.


Final documentation-only follow-up:32/33 used P with `pnpm exec prettier --write` on the report and status doc (exit0).34 ran literal `pnpm format:check` from S after the status update (exit0). These do not relabel the archive source; required compiler/test/build/install/package gates remain pinned to1f31974. Controller-owned brief/ruling remains an ignored handoff input; canonical tracked plan Files changes are included in the source commit. Independent review is still pending.
