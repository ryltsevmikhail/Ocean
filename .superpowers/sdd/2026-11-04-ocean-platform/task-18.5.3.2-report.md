# C18.5.3.2 Desktop service settings — implementation and qualification report

Status: implemented and qualified in current source; controller review pending.
This is not installed/live/F release acceptance, and C5 remains incomplete.

## Ownership and frozen source

- Workspace `/home/ryltsevmg/Projects/Ocean-stable`; branch `codex/ocean11-stable`.
- BASE `84f48f59b664ded30dce54629a4460aeba083615`.
- Source commit `905e1e9ae0c8a4b1b8cd9160357e3c750ee6d153`.
- Read the child brief first, then root AGENTS.md and accepted public client/contracts; no whole-plan/history-report replay, no subagents/helpers/reviewer, no push/merge.
- Owned evidence root: `/home/ryltsevmg/Projects/Ocean-artifacts/c18-5-3-2-desktop-services` (called E below).
- E/frozen-source.json pins all 31 owned paths with SHA256 and physical lines; every source is <=300 lines. Desktop.vue is 252 lines; copied historical UI is 297 lines. E/frozen-source-unchanged.json records the post-gate audit.
- Only the 31 explicit Desktop/documentation paths were staged for the source commit. No blanket add/stash/reset/clean/switch was used.
- Protected `apps/cli/test-fixtures/github-session-rig.ts` bytes remain SHA256 `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031`; index remains `b3ff4f26b9f1fd0a66ce72776474eccd81867b34`, modified unstaged.
- Protected `apps/cli/src/plugin-catalog-lifetime.test.ts` remains SHA256 `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`, untracked/no index. These debts remain for 18.6.
- Real profiles/credentials, default Ocean/design checkout, released installs, launchers, menu entries and user units were not modified. LICENSE/NOTICE were preserved.

## Implemented boundary and UI

`service-protocol.ts` adds closed, detached public DTO requests/outputs and explicit capability negotiation. The original model-protocol DTO detachment helper was extracted verbatim to protocol-dto.ts, and existing model-protocol tests remain green. Normalization preserves historical missing-readiness as unknown and revalidates after serialization. The renderer cannot supply owner/profile/client authority; workspace remains ws_ocean.

`host/service-settings-client.ts` delegates all nine accepted settings methods directly: serviceConnections, serviceGrants, serviceReceipt, setServiceConnection, disconnectServiceConnection, refreshServiceConnection, setOwnerScopeGrant, revokeOwnerScopeGrant and listServiceOwnerOperations. Its decision wrapper uses only existing listDecisions/getDecision/decisionPreview/resolveDecision, preserving the shared client's complete SHA-verified preview and backend RuntimeOwnerDecisions/CAS/lifetime. No backend, permission engine, table, secret store, model loop or framework was added.

The existing Plugins toolbar now wraps cohesive connection, scope, recovery, decision and historical archive views. Save, recorded metadata permission, explicit metadata request, disconnect and HTTP key removal are separate owner actions with request UUIDs and current version triples. Selecting a view does no discovery. Readiness and recorded permission are independent; Russian labels preserve exact enum values. HTTP supports URL and optional private key. Pinned Node stdio supports executable/hash/optional packageJsonSha256/workspaceRoot and [] or ['/workspace']; no key/env/command installer/npm/git/OAuth flow is offered.

New scopes bind current room/selected bot, project/task null. Tool values remain separate strings (including commas/spaces); exact/current-set/all-including-future use existing backend policy. Autonomous is default, confirm/future tools are explicit choices. Editable defaults are maxCalls 1000 / maxEffectBytes 1048576 / expiresAt null, guarded by the public validators. The current UI intentionally offers connection-wide resource scope only, with explicit all-resources and group-visibility acknowledgement. Backend catalog/trust/resource policy remains authoritative. Revoke sends the current grant revision. Account/repository text does not claim enforcement. Coding/project/task scope editing remains a documented later scope, with no implementation placeholder in the product UI.

Recovery state retains only keyless request/target metadata. Keys clear before mutation/receipt await and on load/selection/context/close/Escape. Unknown replies query the ORIGINAL receipt and never automatically resend. Original result snapshots are labelled separately from current records. Absent/prepared/unknown cannot be success. Reopening reads at most 20 prepared pages of 50 rows; an explicit message marks 1000-row truncation. Recovery uses a NEW request ID, current versions and required resupply; original prepared rows remain intact. Missing old intent remains read-only unknown/manual setup. A manual original-request lookup is available after a full window reopen. Context epochs guard late room/bot/connection/window feedback and archive-prefill completion; the profile is fixed by the native host. No browser credential/pending database/storage was introduced. Selected declarative fields and refreshed versions now move together to avoid submitting older form data with newer versions.

Decision cards expose owning room/run, actual performer/turn/task/result-completion facts from the existing room feed, current decision status and the entire SHA-verified plain-text operation. Complete length/hash and before/after version/digest/context must match; expiry updates disable controls. No HTML or truncation is used. A scrollable full-text viewport and wrapping prevent long IDs/JSON/buttons from widening the dialog. Allowed remains a decision fact, never effect-completion proof. Closing/reconnecting does not cancel runs or resolve cards; reopening reloads runtime facts. Result content remains in the existing room history; unavailable run facts are explicitly unknown.

## Conservative historical behavior and hints

Current-runtime historical connections, grants and operations are an explicit read-only archive, including no old unknown-operation acknowledgement/install/enable/grant mutations. Only a fully negotiated historical-only runtime may expose the clearly historical old interface; a partially capable current runtime cannot fall into writable historical UI. Negotiation failure/unsupported features are visible.

Known declarative HTTP configuration may prefill a deterministic legacy ID/generation/endpoint proposal; key blank, permission none, no inherited grant. Existing IDs cannot silently overwrite current records. Historical plugin rows do not expose pinned Node hashes, so those configurations require manual setup. Tools/repository/visibility/account fields remain archived without conversion. envNAME/generation/schema/identityBool do not establish durable material continuity or current resource/account enforcement. New broad connection grants are labelled NEW, not migrated permission. No account/OAuth probe is performed to activate old data.

providerKeyHint, dom and model-check hints use existing status.code. Missing valid references may require explicit resupply; corrupt/insecure stores preserve their data and require separate safe repair. There is no delete-all/reset advice, store healing or blanket retry instruction.

## RED / GREEN chronology and negative evidence

1. E/red-protocol.log: genuine consumer RED,3 tests fail because service IPC/support/delegation are absent. E/green-protocol.log then passes 8 protocol+model tests.
2. E/red-state.log and E/red-decisions.log are missing-module/import scaffolding negatives (`Tests no tests`), NOT behavioral pre-change RED. State/decision semantics were implemented and tested afterward (green-state 3, green-decisions 2). This chronology is not rewritten.
3. Functional negative assertions reject malformed/authority-bearing IPC/output, stdio secrets, altered preview bytes, stale room/window feedback and historical support misuse. State assertions check key clearing before await, original receipt/no retry, prepared discovery/new-ID resupply, and visible grant version conflict. Real runtime/native cases below establish persisted behavior beyond injected state tests.
4. E/scoped-initial.log and E/owning-tests.log preserve old provider wording assertion failures. Copy was corrected without weakening those assertions.
5. Self-review found refreshed version triples could coexist with older selected form values. E/red-refresh-draft.log is a genuine functional RED (expected external owner's new value, received old value). E/green-refresh-draft.log passes 19 tests after synchronizing fields/versions.
6. E/lint-owned.log preserves first scoped lint failures (unused QA argument/import/globals, inline type imports, exhaustive switch and JSON any assignments). Fixes use explicit dispatch cases, public type imports, structural config copies and existing DOM references; no rule was weakened. E/lint-owned-final.exit is0.
7. Final owning source tests:45 files,285 tests pass. Final strict Vue/production, Desktop test compiler and scoped lint all exit 0. Full commands/exits are in E/*-final.command.json, .log and .exit.

Early focused runs whose shell ended with tail did not retain a separate child exit file. Their Vitest summaries are preserved; they are not substituted for the final command/exit proofs.

## Actual current-source native qualification

No installed SDK or implicit dist fallback was used. One ordinary owned shell entry runs an owned raw Electron45.2.1 asset against this checkout's explicitly built Desktop; the owner is current built CLI composition, and the independent process imports the current public LocalRuntimeClient entry. The existing45.2.1 cached ZIP was extracted once into E/electron, with no installed/released file changes. Existing current-window/desktop-launcher/package-native inspector/retirement utilities retain process ownership. The fixture has private HOME/XDG/profile, short /tmp registry/socket roots, compositor socket only, and disabled shared D-Bus. No real key/vendor model/service request was made; provider is injected synthetic and MCP is loopback.

Native entry command (each invocation through the same private runner):

`node apps/desktop/qa/service-settings-native.mjs N ABSOLUTE_COMPOSITOR_SOCKET E/electron/electron`

For the targeted follow-up, replace N with D and append `delta`. Native .log/.exit pairs retain actual outcomes; each proof root pins the selected entry/CLI/public client and built input hashes. The compositor socket is the only existing session resource passed to the owned window environment.

Bulk proof N = `/home/ryltsevmg/Projects/Ocean-artifacts/c18-5-3-2-native-07`, exit 0:

- identity.json/pins.json/window-* native and process records establish actual Electron45.2.1/embedded Node24.22.1, private profile/instance and loaded current file URL, sandbox/contextIsolation and no renderer require. Root Node is26.13.0, pnpm12.16.1.
- Actual GUI saves HTTP config, distinguishes metadata permission/readiness, explicitly refreshes tools and creates a room/bot confirm scope after breadth/visibility acknowledgement.
- Actual insecure synthetic private destination causes durable prepared publication failure. GUI clears key, reopening discovers intent; independent process sees the same original request. After separate fixture permission repair and resupply, new explicit recovery completes under a different UUID while old prepared remains.
- Prepared UUID `50ea94e8-642f-4ae8-bdbf-23bc8fc9b717`; recovery UUID `ca0d65b9-7f6e-4842-b833-9f7216c7cc52`.
- Lost committed set reply is dropped at the actual owner socket. Original receipt lookup succeeds without resend. A full window reopen and independent owner edit show original name Before separately from current Late/configRevision3. Late held reply after selection/Escape does not overwrite the new context.
- Real archive row retains old-account identity. Prefill leaves blank key/permissionnone/no new grant, with no current acknowledgement mutation.
- Full actual service-call preview is41,663 characters, SHA256 `c3922c18eb65ffc7ed2b16511a785de9a2e2392e6e5752937109e464fce6b0fc`; GUI and separate SDK process see identical full preview/card/version/digest. Script-looking text remains literal with zero script nodes.
- Card `service-16e9e2f3585fb0187e36f00594279b779dc486a4d1f68d54ed940a0239e697bc` becomes allowed/version2; the independent process observes that terminal fact, and stale resolution returns it without another permit/effect.
- Dialog close and full window close/reopen while the effect response is held leave the run dispatching. Releasing the actual peer response completes it. Persisted journal has exactly one completed service invocation.
- N/result.json, independent-full-decision.json, independent-terminal-decision.json and peer-facts.jsonl establish metadata8, business1, accepted effect1, model2 for this fixture. No duplicate effect follows reconnect/stale resolution.
- 01-width-1024.png proves composer/focus reachability;02-current-scope.png,03-prepared-reopened.png,04-original-vs-current.png,05-inert-legacy.png,06-full-decision.png preserve observed UI. The last screenshot exposed horizontal overflow later corrected below.

Targeted visual/state delta D = `/home/ryltsevmg/Projects/Ocean-artifacts/c18-5-3-2-native-delta-01`, exit 0:

- Reuses the same owned entry and existing launcher/session utilities; does not repeat the unrelated lost-reply/recovery matrix.
- Actual external-owner refresh updates the selected draft and versions together. Actual current run feed shows performer/status and eventual completed result fact. Human-readable decision status and removed implementation placeholder are exercised.
- Full41,659-character preview remains exactly equal to the independent SDK output, digest `d9681399c6daaff23a8e99bb14807af65226759186813e6d8f6b370dfc8e088d`.
- At viewport1024: dialog clientWidth423, scrollWidth423, scrollLeft0, left292. No horizontal overflow. delta-1024-decision.png and delta-1024-result.png were visually inspected. Full operation is scrollable plain text, never shortened.
- Explicit key removal and disconnect complete; final connection readiness disconnected. Peer final counters: metadata2, business1, accepted effect1, model2. These are a separate synthetic fixture, not added to N's single-effect claim.

### Source-pin limits and exact later deltas

N and D are explicitly pinned working-source/built-input qualifications, not claims that their source HEAD was the final frozen commit. Their pins.json retains original HEAD/tracked diff and relevant built file SHA256; bundle7/bundle8 logs identify their actual Vite outputs. No installed/release acceptance is inferred.

After N: selected-draft/version synchronization (functional RED/GREEN and actual D); Russian decision statuses, existing-run facts and wrapping/scrollable preview (actual D); removal of the coding/project/task product placeholder (D); provider hint wording; and lint-only structural copies/explicit dispatch/type imports. After D: key clearing also on explicit lookup/mutate, archive-prefill epoch guard, and provider-write-failure hint; these were final strict/unit verified. The subsequent source commit/frozen manifest identifies the final exact source. The positive bulk matrix was not replayed just to refresh unrelated copy.

### Failed native proofs and cleanup

All failed proof roots01–06 and logs remain intact:

- 01: configured workspace Electron package had no downloaded binary. Owned cached ZIP extraction corrected the entry; no GUI acceptance claimed for01.
- 02: selecting before initial load invalidated its epoch and left fields stale. Selection is now disabled while stale; no discovery/effect inference was used.
- 03: QA poll read peer-facts.jsonl before owner created it, after real prepared/recovery progress. Added existence check; not a product failure or completed qualification.
- 04: attempted second GUI under a different userData could not populate the room; existing profile asset enrollment was not changed. No two-GUI acceptance is claimed. Controller clarified that the required second owner is an independent authenticated SDK process, which is fully qualified in N. The exact observed04 failure is a room-locator timeout, with enrollment/binding as code-level explanation, not a fabricated observed IPC error.
- 05: QA expected task vocabulary running for public turnStatus; actual held turn is dispatching. Early cleanup released then immediately stopped, yielding uncertain stop. This synthetic profile and short root were retained; process retirement is distinct from effect cleanup.
- 06: a preparatory capabilities-array typo failed compilation, but the initial shell sequence continued into native against the prior bundle and repeated the same mistaken turnStatus assertion. It is invalid as final-source proof. The typo and assertion were corrected; no production state assertion was weakened. Its uncertain stop/short root is retained.

N and D cleanup.json have errors[] and remaining[]. E/retirement-all.json plus each native root's retirement-final.json audit every observed PID/start identity against /proc; all are absent, including failed01–06. Earlier records() state R/S is last-observed metadata, not a live descendant claim. No profile/evidence was deleted based only on main-process exit. Process retirement is proven separately; failed05/06's Ocean stop/effect uncertainty is preserved honestly and is not promoted to confirmed cleanup.

## Final verification on frozen source

E/final-audit.json pins the unchanged runner, Electron ZIP/binary, protected bytes/index and retained failed short roots.

Every compiler/build/test command used the unchanged `.superpowers/sdd/2026-11-04-ocean-platform/run-private.py` with default short private TMP/XDG roots. No outer long-artifact TMPDIR was set. Command arrays, actual combined outputs and exit files are in E.

| Command after the private runner                                                                                                                                                | Exit | Actual result                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pnpm check                                                                                                                                                                      | 1    | Production and Node/Desktop test compilers plus repository lint pass; source Vitest:569 passed files/3793 passed tests,3 protected catalog failures in plugin-catalog-lifetime.test.ts,17 skipped files/44 skipped tests inherited unchanged. Stops before root process phase. |
| pnpm build                                                                                                                                                                      | 0    | tsc -b passes.                                                                                                                                                                                                                                                                 |
| pnpm format:check                                                                                                                                                               | 1    | Exactly the two protected CLI paths warn; no owned file warnings.                                                                                                                                                                                                              |
| pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/service-owner-process.test.ts apps/cli/src/local-runtime/service-confirmation-process.test.ts | 0    | 2 files/2 tests pass: independent original receipt after owner restart, and SIGKILL/two-owner decision recovery with business1/effect1/model1 and recovered outcome uncertain/no replay.                                                                                       |

Root gates were each run ONCE on frozen 905e1e9. E/root-{check,build,format}.{command.json,log,exit} and E/affected-process.* are exact command/exit proofs. The 44 existing skipped tests were not introduced or changed here. No failed catalog assertion was skipped or relaxed.

Final owning commands, all exit 0: scoped eslint on every owned TS/MJS file (Vue is checked by strict vue-tsc, not an unconfigured ESLint parser); pnpm --filter @ocean/desktop exec vue-tsc --noEmit -p tsconfig.json; pnpm typecheck:tests:desktop; and pnpm exec vitest run --config vitest.source.config.ts apps/desktop packages/tools-node/src/local-service-client.test.ts packages/tools-node/src/local-decision-client.test.ts (45 files/285 tests). E/*-final.command.json retains all explicit arguments. Frozen root checks add the full Node compiler and repository lint passes.

The source manifest is checked again after gates. Source paths remain frozen; only this report is committed afterward. No skips or relaxed assertions were introduced.

## Self-review and remaining scope

Self-review checked closed input/output detachment, native ownership, keyless pending metadata, original-vs-current receipts, no unknown retry, context epochs, exact SHA/length/CAS/lifetime, tool-string preservation, connection resource breadth and read-only archive paths. It found and fixed stale selected form fields, current partial-support fallback risk, model hint copy and the screenshot overflow. The existing model DTO behavior was preserved through tests; no source exceeds 300 physical lines.

Exact limitations: connection-wide service resources only in current GUI; coding/project/task scopes remain later work; no stdio secret/env or installer manager; historical rows without pinned Node material require manual setup; existing Desktop userData/profile binding remains intact; bounded prepared discovery reports truncation; allowed is not effect completion. Real vendor/model/services, installed/released/native OS matrices outside this targeted current-source case remain separate. Controller independent review follows this terminal report; worker does not declare task/stable-release acceptance.
