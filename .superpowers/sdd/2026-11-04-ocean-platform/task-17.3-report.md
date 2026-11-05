# Task 17.3 — exact installed Linux candidate

2026-11-05. Status: **DONE_WITH_CONCERNS, scoped qualification complete; controller review pending**. No publication, push, merge, real-profile update or service installation. This is the B/17.3 qualification candidate, not F/stable. C catalog debt, D/E changes, 17.4 backend/model proof and 17.5 native Desktop GUI remain separate.

## Exact revisions and artifacts

Accepted input BASE: `8342afc7b826aba78dce44742cc99e7567fcb5f1`.
Owned commits on canonical `codex/ocean11-stable`:

- `8e78d49a221eaaf6a78df68e0bd768920b331eab` — preserve bundled Desktop Vue/Zod full notices, add regression and ASAR checks.
- `ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a` — correct native history provider contract/preconditions and active cancellation harness.
- The subsequent documentation/evidence commit is deliberately separate from the artifact source revision. It does not claim the archive contains these later qualification records.

**Final artifact source revision: `ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a`.** Fresh clean qualification worktree: `/home/ryltsevmg/Projects/Ocean-artifacts/task-17.3-ec1e5d5/source`, branch `codex/task-17.3-qualified-candidate`. It was created from the committed revision, installed with frozen lockfile, built from its own sources, and remained clean at final freeze. No symlinked-current-build/relabelled source fixture was used for this artifact.

Artifact/evidence root (`Q` below): `/home/ryltsevmg/Projects/Ocean-artifacts/task-17.3-ec1e5d5`.

| Artifact | Exact identity |
| --- | --- |
| CLI archive | `Q/cli/ocean-1.1.0-rc.3-linux-x64.tar.gz`, 1471945 bytes |
| Archive SHA256 | `933d0b3a535685a4606e92c91ecd970507e0d403002d2e348cfb2b304302556d` |
| Raw tar-entry manifest SHA256 | `df0c99aaccf165851e040db5d4d0675afe085fb3f1f51011a5672e0723bbe5e3` |
| CLI inventory | `Q/cli/manifest.json`, 693 file SHA256/mode records; extracted raw archive bytes |
| Disposable installation | `Q/prefix`, final current → `releases/1.1.0-rc.3` |
| Desktop | `Q/desktop/artifact/OceanDesktop-linux-x64`, 72 files, 294624575 bytes |
| Desktop ASAR | 7953091 bytes, 1131 entries, SHA256 `96837046186d298fb6466e723ecba8c31c58dadf1e7925b26e8f0c66a660b06a` |
| Desktop inventory | `Q/desktop/desktop-artifact.json`, complete per-file SHA256/size inventory |
| Source/build/script freeze | `Q/freeze.json`, 2941 source/build file hashes and qualification driver hashes |
| Evidence inventory | `Q/evidence-inventory.json`, hashes/sizes for proof files and command logs |

Earlier candidates are **superseded**: `task-17.3-8342afc` archive `a4f8d76b2cb157b64ef2eb39e3c481d3bd3f6e315bd2fd123f1e86794a6641bf`; `task-17.3-8e78d49` archive `d3bdfed80ba178c5c7223eb9ad512b2015862a3ea34f1d16c2e0bc22aedf1c81`. They retain diagnosis/RED logs, not final acceptance claims. Final `runtime-equivalence.json` proves all 693 CLI payload file hashes/modes and the Desktop ASAR match the 8e78 candidate; the archive changes for its actual revision manifest. All required final gates/probes were nevertheless rerun at ec1e5d5.

## Environment and isolation

Linux x86_64 / Omarchy, i5-13420H, 15 GiB RAM. Exact Node `v26.13.0`, pnpm `12.16.1`, lockfile unchanged; fresh `pnpm install --frozen-lockfile --offline` reused 422 packages, downloaded 0. Full memory/swap/disk/kernel/CPU snapshot: `Q/environment.txt`; lockfile digest is in `freeze.json` and the release manifest. Initial disk: 819 GiB available on disk versus 2.8 GiB in `/tmp` tmpfs; initial available memory about 3.8 GiB with about 12 GiB swap used. Native test concurrency is explicitly 2; no model weights/backend were downloaded.

Bulk worktrees, archives, Electron staging, profiles and dependency copies live on the owned disk artifact roots. The unchanged `run-private.py` creates short disposable HOME/XDG/socket/TMP fixtures. Only the named native wrapper sets **child** TMPDIR to a newly created 0700 `/home/ryltsevmg/o173-*` Btrfs directory and removes that exact directory. Parent TMPDIR/private runner/global settings were not changed; no `/proc` path aliases were used to bypass layout validation. Sandbox's host-side cgroup manager uses its existing `/run/user/1000` infrastructure; worker environments remain isolated.

No real provider credentials were loaded. HTTP ports are deterministic offline fixture ports/hooks. SDK AST parsing uses qualification-worktree TypeScript as an explicitly labelled harness dependency; installed product imports resolve entirely inside the prefix. The TUI uses the existing repository PTY driver and provider hook, pointed at installed main.js. Historical v1 source transpilation is a bounded fixture harness, not an assertion that the whole old application was rebuilt.

Protected original Ocean/design checkouts, installed Ocean 1.0/RC2, launchers, profiles, keys, global services, and the two protected C files were not changed. Final protected SHA256s match the earlier freeze:

- `apps/cli/test-fixtures/github-session-rig.ts`: `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031`.
- `apps/cli/src/plugin-catalog-lifetime.test.ts`: `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`.

## Source fixes, actual RED and GREEN

### Desktop license omission

Inspected emitted renderer/preload and staged ASAR input, beyond root LICENSE/NOTICE/Electron notices. The Vue full MIT text/copyright was absent; Zod's complete LICENSE already existed under staged `node_modules/zod/LICENSE`. No generalized dependency crawl was used. Vue `3.5.44` and bundled `@vue/shared`, `@vue/reactivity`, `@vue/runtime-core`, `@vue/runtime-dom` all have the same upstream MIT text and copyright, SHA256 `1bb85cc9b13b81ef41c81c51866172fc345e0503c86726a6755b796590b70175` (provenance retained in the 8e78 predecessor root).

Regression RED: `license-red.log`, 1 failed because `THIRD_PARTY_LICENSES/vue-MIT.txt` was absent. GREEN: `license-green.log`, 1 passed. The new packaging adapter copies exact pinned Vue and Zod notices into `THIRD_PARTY_LICENSES`; artifact helper checks both ASAR entries. Existing Apache LICENSE/NOTICE, Zod's original package notice and Electron licenses remain. Final raw ASAR byte extraction compares complete notice bytes with staging (`licenses-proof.json`). Source files are 10/22 lines and artifact.mjs 185 lines. Strict Node+desktop aggregate, focused lint and formatting passed before the owned source commit.

Final license hashes: Vue `1bb85cc9…0175`; Zod `3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8`; root Apache LICENSE `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`; NOTICE `2c8cb8b29af47565c5f3d31251569edb94dc30a83915bcc7a9b979f19d3a9364`. Full hashes/lengths/paths are in final `licenses-proof.json`.

### Native fixture reconciliation, no production authority change

First explicit native run at 8e78: **82 passed / 2 failed / 0 skipped**, 35 files, 52.01 s (`native.log`). It used default config concurrency before controller required explicit maxWorkers=2. Failures were sandbox-native active-cancel assertion at line243 (`cleanupConfirmed=false`) and native history's original 5 s timeout. Focused unchanged rerun: 7 passed / 1 failed; sandbox7 passed, history reached `rebind_effects_held` rather than merely timing out (`native-focused.log`). These results remain retained, not relabelled passes.

Built fixture diagnostic and two-capability control proved the history cause: the coding turn's synthetic provider omitted `toolCalls`, while that turn offers coding tools. With capability absent, TaskRun failed `provider_error`, chat turn remained `uncertain`, pending tool journal was empty but a global provider hold remained. With identical terminal/usage events and `toolCalls:true`, TaskRun succeeded, turn completed and holds were empty. The native fixture now advertises its intended contract and asserts confirmed turn completion, succeeded TaskRun, empty pending journal and empty rebind holds before archive/preview. No hold was cleared or unknown state coerced. New precondition RED: 1 failure (`uncertain` versus `completed`); final focused GREEN: 8 passed / 0 failed. The full Git/SQLite lifecycle took 6.5 s on the final bounded-concurrency run; its scoped test timeout is 30 s, with no global timeout changes.

The cancellation fixture's wall timer could fire while the service was still verifying inputs, before supervisor cgroup admission. It now waits for a marker actually written inside the worker, aborts in a finally, awaits supervision and then checks confirmed cleanup. Separate existing pre-inventory cancellation and explicit installed early-cancel proof retain uncertainty/fail-closed behavior. Final test files: 252 and 268 physical lines. Aggregate strict/focused lint/format passed before ec1e5d5.

## Final commands, exits and counters

Let `P=/home/ryltsevmg/Projects/Ocean-stable/.superpowers/sdd/2026-11-04-ocean-platform`, `Q=/home/ryltsevmg/Projects/Ocean-artifacts/task-17.3-ec1e5d5`, `W=$Q/source`, `I=$Q/prefix/lib/ocean/releases/1.1.0-rc.3`. All commands below actually ran; final raw logs are `Q/logs/`; structured exact command/working-directory/exit records are `Q/gate-ledger.json`. Private commands use `python3 "$P/run-private.py" …`; no runner weakening or exclusion was added.

| Working directory / command | Exit / actual result | Log |
| --- | --- | --- |
| W: `pnpm install --frozen-lockfile --offline` | 0; 422 reused, 0 downloaded | install.log |
| W/private: `pnpm check` | 0; strict Node+desktop 0, lint0; source 3404 passed /44 skipped (505 passed,17 skipped files); process147 passed /35 skipped (41 passed,16 skipped files) | check.log |
| W/private: `pnpm build` after final qualification | 0 | build-final.log |
| W/private: `pnpm format:check` | 0 | format-final.log |
| W/private: `pnpm --filter @ocean/desktop bundle` | 0; web, preload, host compiled outputs present | desktop-bundle.log |
| W/private: `pnpm package:release 1.1.0-rc.3 "$Q/cli"` | 0; exact revision/hash above | package.log |
| W/private: `python3 "$P/task-17.3-desktop-package.py" "$W" "$Q"` | 0; pinned Electron, actual ASAR/inventory | desktop-package.log |
| W/private: `python3 "$P/task-17.3-native-probe.py"` | 0; **84 passed /0 failed /0 skipped**, 35 files, 136.35 s; maxWorkers2, explicit sandbox+Btrfs opts | native.log |
| Stable/private: `python3 "$P/task-17.3-archive-probe.py" "$Q"` | 0; real RC2/update/rollback/refusal and separate schema14 | archive.log, logs/installed-commands.jsonl |
| Stable/private: `python3 "$P/task-17.3-v1-probe.py" "$Q"` | 0; historical schema5/format1 → installed23, inert | v1.log, v1-commands.json |
| I/private: `env OCEAN_QA_TYPESCRIPT=file://$W/node_modules/typescript/lib/typescript.js node --experimental-import-meta-resolve --input-type=module < "$P/task-17.3-closure-probe.txt"` | 0; installed imports and closure below | closure-final-2.log |
| I/private: `env OCEAN_QA_ARTIFACT="$Q" OCEAN_QA_TTY_HELPER="$P/task-17.3-tty-confirm.py" node --input-type=module < "$P/task-17.3-rebind-probe.txt"` | 0; actual CLI/TTY rebind and normal owner reconnect | rebind.log |
| Stable/private: `python3 "$P/task-17.3-hosts-probe.py" "$Q"` | 0; CLI/TUI/ACP/Python socket | hosts.log |
| I/private: `env OCEAN_QA_ARTIFACT="$Q" node --input-type=module < "$P/task-17.3-sandbox-probe.txt"` | 0; four real presets and resource/negative cases | sandbox.log |
| I/private: same command with `task-17.3-early-cancel-probe.txt` | 0; expected unconfirmed cleanup and subsequent hold | early-cancel.log |
| Canonical stable/private: `pnpm format:check` | 1; exactly two protected C files, unchanged | protected-checkout-format.log |
| Stable: `python3 "$P/task-17.3-freeze-evidence.py" "$Q"` | 0; exact inventories, license bytes, environment and freeze | freeze.log |

Root `pnpm check` already ran its full ordinary built process phase at this exact freeze. No separate redundant ordinary-process rerun is claimed. The native84 probe is a separate opt-in gate; ordinary skips remain reported as skips. Clean checkout discovery excludes the protected untracked catalog test and uses the committed catalog fixture. Therefore clean check0/format0 **does not close** C's known three catalog failures/two protected format files. Canonical source root's protected formatting result is recorded separately; no protected source catalog implementation was repeated or edited.

## Pinned Electron and installed closure

Recomputed official cache zip SHA256 `616efc1ae4784af1a4f3f0e8774e73e7030e7bd1708da9d09bcf543dfa499beb`, 123777540 bytes, 72 safe entries, internal version45.2.1. Preparation's official release API and SHASUMS256 agree. Explicit packager zip directory used; no import of the project Electron stub/implicit download, no system Electron39 substitute. A narrow harness invokes the existing artifact helper with the public packager `tmpdir` option pointing at owned disk staging; it does not modify source or parent TMPDIR. Packaged executable bytes equal official zip `electron` bytes, SHA256 `870b5982c855df1405399efa0d51d83e6e048b3308a84cce4040bc3b052ce9f3`. LICENSE and LICENSES.chromium.html bytes also match the official archive. `electron-proof.json` records these facts. Desktop GUI was not launched under 17.3.

From I, with private environment and no NODE_PATH/NODE_OPTIONS, bare OpenAI/Anthropic/local public imports resolve below installed I and expose expected factories/probes. TypeScript AST harness audited all **627 shipped JS modules**, static import/export, literal dynamic import/require and literal module-relative URL targets: **1752 resolved references, zero missing, zero variable import calls**. `chat-known-failure.js`, SQLite conversations/chatFailureEvidence, event-log and tool-journal-reads are explicitly present; all their relative targets survive packaging.

The extended URL audit additionally found one nonliteral **resource** URL in Executor's source-layout SDK-chunk fallback. This is not an unresolved dynamic module import. It was inspected separately, not blanket allowed: installed public `ExecutorServicePluginTransport.open` refuses by default `execution_not_enabled`; explicit inert transport construction qualifies in `bundle` mode with 14 bundle chunks, then closes without discovery/invoke. The source-layout fallback isn't needed by the packaged integrity path. This is recorded in `sourceLayoutFallbackAudit` in closure-final-2.log.

No compiled fixture/cleanup modules ship; no blanket packaging filter was changed. **11 package metadata records advertise `.d.ts` files that the archive does not ship.** Runtime closure is proven; declaration consumers are not qualified. This pre-existing non-runtime discrepancy remains a disclosed concern, not a silent declaration-support claim.

## Real archived RC2, migration and rollback

Read-only source archive: `/home/ryltsevmg/Projects/Ocean-artifacts/1.1.0-rc.2/cli/ocean-1.1.0-rc.2-linux-x64.tar.gz`; recomputed SHA256 `0ea8ddddb762ce0adcaa7b3b8cd257e86c61bb60a783cbf03f3fb297811b98b1`, 1359637 bytes; raw manifest SHA256 `11f03fb74e7e775e210e86659ba50fc6ff0abfa834c2da4c53b6e40d7b2cf903`; revision `5e10ec32179063be78a55f6835866a1a864991ac`, Node26.13.0, schema18. Archive entry SHA256s/modes and path safety were verified before executing its installed copy. No outer real-profile launcher/environment file was used.

Actual sequence: install RC2 into Q/prefix; create synthetic room/history at schema18; backup before new writer; copy profile; install RC3 without profile changes; current bot-list migrates copy to23; close all owned handles; inventory full copied profile; execute actual installed RC2 launch.js. CLI exits2 (`invalid_input`); independent original old store oracle reports **database schema version23 is newer than supported18**. Full before/after file inventories including DB/WAL/SHM presence, modes, sizes, SHA256s and mtimes are equal. This is not merely a generic CLI-code oracle. Synthetic fixture has no assets, so the complete inventory contains no omitted asset tree. Pre-upgrade backup remains unchanged.

Reinstall RC2 only in disposable prefix and restore its compatible pre-upgrade backup into a **fresh** rollback profile. Old doctor/history pass; rollback remains schema18. Migrated schema23 is never downgraded in place. Reinstall RC3 for final installed probes. Installer current targets and every subprocess exit are captured in archive-proof.json/installed-commands.jsonl. Raw and canonical-reserialized manifest digests have distinct labels.

Earlier rehearsal corrections are retained in predecessor logs: first oracle incorrectly expected a human schema message from the sanitized CLI; next inventory comparison retained Python sqlite3 context-manager handles (which do not close the connection). Explicit closure corrected the harness; independent closed-writer controls and final rerun prove no retained profile mutation. No product change was inferred from these harness failures.

## Genuine synthetic 1.0 restore

Pinned `v1.0.0` resolves to `4417c38ae6c9474cb0c35e9d64ca7f327ac812bd`, schema5. `v1-proof.json` records SHA256s for 13 original historical source files: real schema initializer/migrations/rows, original tool/ownership/transaction/maintenance and original CLI backup/private-file/version logic. TypeScript5.9.3 transpileModule only erases types, retaining original execution logic; a bounded public export bridge exposes original inspectDatabase/snapshotDatabase. This is a synthetic historical initializer/backup fixture, not a rebuilt whole historical app.

Original initializer creates fresh schema5, seeded with synthetic workspace/bot/room/member/message and checked FKs; original backupProfile creates actual format1/schema5 envelope. Installed RC3 restore/history migrates to23 with exact history preserved and FK check empty. Ordinary runtime startup and unapproved send return restore_restricted. The migrated legacy DeepSeek row stays intentunconfigured/configuredAfterRestorefalse/secretRefnull/pendingRequestnull/lastChecknull. Raw source profile and backup inventories remain equal to pre-current-operation snapshots. Additional schema14/format2 exercise is correctly labelled RC1-era, not relabelled Ocean1.0.

## Installed hosts and actual owner-confirmed rebind

`hosts-proof.json`: installed launch.js creates two bots, direct/group rooms, persists history, refuses offline send without provider (exit4/provider_unavailable), doctor permissions true. The ordinary installed owner uses an offline fetch hook with synthetic owner-only key. Actual Python3 AF_UNIX client proves unauthenticated/status refusal, wrong-capability refusal, authenticated hello/status/rooms with the same owner identity. Capabilities are not copied into report diagnostics.

A real installed TUI PTY observes an admitted held turn and its completed answer, retains isolated HOME/XDG, no inherited user bus, exits0 with original terminal attributes restored; exactly one provider dispatch. CLI's send response is correctly interpreted as **admitted**, not completion; completion comes from the TUI/history. ACP runs installed code over stdio: initialize protocol1, session/new, deterministic no-provider prompt, session updates, end_turn and clean exit0. First rehearsal's incorrect admitted-versus-completed assertion was corrected in the driver; product behavior was already correct.

`rebind-proof.json` and `rebind-rehearsal/tty-confirm.json`: source profile backed up then deleted; real restored SQLite has three configured source model connections. Normal owner before rebind refuses restore_restricted; maintenance owner exposes reads but refuses model set/turn, with zero additional HTTP effects. CLI inspect → preview binds exact selection; non-TTY confirm returns approval_required; **real stdin/stderr TTY** displays exact decision/digest and enters `y`; result becomes ready with successor task, guard retained. No forged epoch/deleted guard/maintenance allowlist relaxation.

Maintenance closes cleanly; actual ordinary CLI owner starts restored profile. All three restored connections remain configuredAfterRestorefalse until explicit reconnect of OpenAI through public SDK to this owner. New set/check succeeds; a new run completes with exactly one offline fixture inference. Anthropic/local remain configuredAfterRestorefalse and have zero HTTP effects. Public metadata also has virtual legacy/default rows; the driver records/compares the three concrete configured source IDs rather than assuming page length equals physical connection count. No backend/live provider claim follows from this offline proof.

## Installed sandbox and truthful negative outcomes

`Q/sandbox-dependencies` is a physical copy of the frozen dependency store on owned disk; 24756 files, preserved internal relative links, 14 escaping workspace links removed from this **owned harness copy** only. No source dependency link is used for installed product closure. Public installed `probeSandbox`/`createSandboxBackend` qualify actual containment and execute exact registered presets: Node test, TypeScript5.9.3 strict/noEmit, ESLint9.39.5 rules, TypeScript build to isolated tmp. All four: exit0, cleanupConfirmedtrue, source/dependency hashes unchanged. This is real tool execution, not echoed preset labels.

Final measured preset wall times (include host-side full dependency verification): test22014 ms, typecheck18989, lint16115, build16346; loud15993; active cancellation15764; timeout75933. Supervisor deadline is 60000 ms, not a claim the project itself ran exactly60 s. Host-side input verification/bookkeeping adds to observed wall time. Observed owning cgroup properties: MemoryMax2147483648, TasksMax256, RuntimeMax65s, KillModecontrol-group, NoNewPrivilegesyes, ProtectControlGroupsyes. No deliberate 2GiB OOM stress is claimed.

Negative gates: nonregistered preset denied; output retained exactly32768 bytes/truncatedtrue; active worker marker precedes abort and returns reasoncancelled/exit75/confirmedcleanup; timeout returns reasontimeout/exit75/confirmedcleanup. Detached descendant tick file stops changing after cleanup, and supervisor confirms cgroup empty/removed. Main process exit alone is not the cleanup oracle. Final `owned-cleanup-proof.json` finds no remaining installed owner/client PID and all recorded owned sandbox cgroups absent; no unrelated process was stopped.

Separate installed pre-admission cancellation observed a populated service cgroup before worker marker/verified launcher readiness; product reports cleanupConfirmedfalse/cgroupnull/uncertaintrue and no project dispatch. Subsequent read/write/command all refuse effect_uncertain. External cgroup later disappears (ENOENT); that independent observation **does not upgrade** product cancellation evidence. Bwrap's interrupted descriptor diagnostic is retained in early-cancel-proof.json. This validates fail-closed uncertainty, not a cancellation-success claim.

## Self-review and evidence delivery

Reviewed the five changed source/test files against accepted BASE: only Desktop notice packaging and two native fixture contracts changed. Domain/application authority, schema, unknown-completion guard, rebind holds, provider activation and cancellation evidence remain unchanged. New/changed files stay below300 physical lines, strict aggregate and lint pass. Regression assertions verify exact upstream notice bytes, confirmed durable historical preconditions and actual worker admission before confirmed cancellation. The final archive and installed inventory were independently rehashed at freeze; Desktop72-file inventory was rehashed too. Only the documentation/qualification scripts/report are in the final documentation commit; generated archives, databases, transcripts and full inventories remain outside Git under owned artifact roots. Controller independent review remains required.

## Remaining concerns and boundary

- C owns protected catalog3/format2 debt. Fresh qualification worktree excludes foreign untracked/modified semantics; no whole-branch-green claim.
- Eleven advertised declaration entrypoints are absent; runtime imports pass, declaration support remains unqualified.
- Final source/evidence require controller independent review; no reviewer/subagent was spawned by this worker.
- 17.4 owns actual backend/weights/full metadata/tensor identity/mixed/live model proof. No weights, Ollama backend or real vendor calls here. OpenAI/Anthropic live remain deferred.
- 17.5 owns actual Desktop GUI/Wayland/user interaction. Electron package identity/licenses were verified, not GUI execution.
- F must rebuild/repackage after accepted C/D/E changes. Neither this candidate nor its predecessors were installed in a real release prefix or published.
