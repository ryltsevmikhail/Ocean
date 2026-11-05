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

## Correction round 1 — I1/I2, evidence-only

FIX_BASE `b5b32c2d9e5a3eb2cdc17f6685ce4573b65da4ee`. Both Important findings in `task-17.3-review.md` are addressed below; controller scoped review remains pending. This appendix supersedes the original incomplete evidence-freeze claim, while preserving the earlier product results and failed/superseded evidence. Product source remains **ec1e5d59fc8f7bc08122f331d636c9ae0f1d031a**, CLI archive remains **933d0b3a535685a4606e92c91ecd970507e0d403002d2e348cfb2b304302556d**, Desktop ASAR remains **96837046186d298fb6466e723ecba8c31c58dadf1e7925b26e8f0c66a660b06a**. No product rebuild, schema/authority change or broad pnpm/native/model gate was run for this evidence-only correction. Prior 3404/147/84 passed results still refer to their exact ec1 artifact. The correction's later Git commit records qualification scripts/docs, not new product bytes.

### I1 — Freeze the evidence used to establish the mandatory owner-confirmation and command claims.

Final evidence directory: `Q/fix1/freeze-final`. Its explicit inventory has **165 files**. The immutable raw-byte anchors are:

- `evidence-inventory.json` SHA256 **e6753bfccdb01bdcf7b4ccb17718347beb405654deb1cbcbb70cf5faa79f300b**.
- `seal.json` SHA256 **fceb6b3e54c20deefc4bd9698fd9ec850e4269bf7dbcd66fe02a7b9de9a28db5**.
- Post-freeze validation `Q/fix1/validation-final/attestation.json` SHA256 **81e9d8c011e9e8ad9e89ede72f727c2d6160307665bd085a568a104b84bd46cd**. This separate second-phase record binds the primary seal, actual validation commands/exits and raw output hashes without creating a cycle.

The inventory explicitly includes `rebind-rehearsal/tty-confirm.json` with the full displayed card, decision and bindingDigest; original rebind `commands.json`, inspect/selection and HTTP fixture ledger; `hosts-rehearsal/commands.json` and PTY environment record; dependency provenance; all intended root command logs; prior freeze records; focused RED/GREEN cases and their fixture/result files; and corrected rebind outputs. No incidental path-segment scan remains: scratch Git reflogs are not selected. The old incomplete inventory is retained as historical input, not expanded into a renewed claim over its incidental scratch paths.

Original shared `run-private.py` has SHA256 **adc3adf372fa77a694f4a4272a5f13e615646886356e1db0045767dad0d228a3**. Its exact bytes are committed as `task-17.3-run-private.py` and snapshotted in `inputs/run-private.py`. `inputs/provenance.json` binds the original absolute runner path and digest, 12 original b5 driver snapshots recovered from their pinned Git commit and checked against the original freeze, and 19 current qualification-driver snapshots. `inputs/reproduce.md` contains the staging/execution recipe; this includes current helpers and the freeze/validation programs themselves. These snapshots permit reproduction without relying on a later mutable shared wrapper or current driver file.

The original `sandbox-dependency-provenance.json` still honestly identifies its 8e78 origin. The new `task-17.3-stage-dependencies.py` executed against current clean ec1/frozen dependencies into a **new owned disk target**, then compared every physical file's bytes/mode and every symlink target with the original staged dependency tree: **24756 files and 1093 links identical**. Original provenance was not relabelled. Recipe argv/results are in `fix1/dependency-reproduction.json`, exact tree in `fix1/dependency-tree.json`, raw tree-inventory SHA256 **6baaca9eb5c9ddf9d978a2e64d4ca233c69837f0f0246359ee2a4a5717c5e0fa**. Fourteen escaping workspace links were removed only in the newly owned reproduction, as in the original staging. No dependencies were downloaded or product dependencies changed.

`task-17.3-freeze-run.py` creates a new output directory, snapshots inputs, then invokes the snapshotted core through the snapshotted private runner. It records exact argv/cwd and captures raw stdout/stderr and exit **0**. Core checks unchanged archive/install/Desktop bytes and writes the explicit inventory. Only after the core exits does the non-circular seal hash `invocation.json`, `stdout.log`, `stderr.log`, and `evidence-inventory.json`; neither inventory nor seal hashes itself. The committed hashes above are the external immutable anchors. The original root freeze/log/inventory remain preserved, with copies under `fix1/previous-freeze`.

Meaningful inventory controls ran first on a provisional freeze, then on the **actual final sealed file set using its snapshotted validator/test code and private runner**: **7 passed / 0 failed / 0 skipped**, exit0. They verify all actual listed bytes and reject actual TTY-screen tampering, omission of the command ledger even from both inventory lists, shared-runner tampering, freeze-stdout tampering, and a rehashed TTY record whose displayed digest no longer matches the decision; an added incidental scratch Git reflog remains excluded. All mutations occurred in fresh copied evidence directories, removed after tests. Product/candidate/runtime/profile files were not mutated. The provisional placeholder log is retained; it was replaced only after its seven controls passed, and that provisional seal is explicitly superseded by the final seal. Raw final command/output/exit records are in `fix1/validation-final/attestation.json`.

### I2 — A failed rebind-owner startup can hang cleanup indefinitely.

`task-17.3-owner-lifecycle.txt` now owns the qualification host lifecycle. It records child PID/starttime and creates an isolated session/process group; startup, client connection, graceful stop and close waits have deadlines. Without a client, after failed stop, or when close fails to arrive, it sends TERM and then KILL only to the verified recorded group if required; it bounds exit and verifies the direct child is reaped and the created group is empty. PID/starttime mismatch refuses signalling. The final close-promise wait occurs only after close and group emptiness were observed. No unrelated process is signalled.

The shared finalizer rethrows the original work/startup error and writes the command/failure/cleanup ledger after bounded retirement; secondary cleanup/logging failures do not replace that original error. A graceful stop that returns complete but never closes becomes `owner_close_timeout`, rather than hanging. Retiring a qualification host/process group does **not** assert cancellation of any product effect or cleanup outside that group; no unknown operation is retried.

Focused regression uses disposable fake owners that ignore TERM and remain alive. Legacy RED reconstructs the exact b5 lifecycle block, shortening only startup polling for a deterministic test: it hangs in the old unbounded cleanup and reaches the 2500ms outer-supervisor deadline. **1 failure /2 intentionally skipped nonlegacy cases**, exit1, retained in `fix1/logs/owner-red-supervised.log`. The outer test supervisor is a process-local subreaper and kills/reaps only its recorded fake group even when the legacy probe hangs.

GREEN runs all three mandatory paths: never-ready (`owner_startup_timeout`), client-connect refusal (`synthetic-connect-refused`), and nonclosing-after-stop (`owner_close_timeout`). **3 passed /0 skipped**, exit0, 0.803s total; each completes in roughly200–330ms under test deadlines. The original failure is retained, the failure/result ledger is written, TERM→KILL fallback occurs for the ignoring fake, recorded PID/starttime is gone, and the owned group is empty. Exact per-case PIDs/starttimes/exits/results and fake input bytes are indexed by `fix1/owner-cases.json` and frozen. Production defaults remain bounded separately: startup10s, connect10s, graceful RPC2s, close2s, TERM1s, KILL2s. No global runner or product timeout was changed.

Corrected integration was also exercised once against the same installed ec1 artifact under **new** `rebind-rehearsal-fix1`, proof `fix1/rebind-proof.json`, exit0; original rehearsal files were not overwritten. Actual inspect/preview/non-TTY refusal/real TTY allow/resultready/normal-owner-one-connection-reconnect still pass. `rebind-rehearsal-fix1/owner-cleanup.json` records all three actual owners with distinct PID/starttime, exit0, no signals, direct-child reaped and isolated group gone. Its command ledger and full TTY screen are in the final explicit inventory.

### Exact scoped correction commands and checks

All argv/cwd/exit records before final freeze are in `Q/fix1/correction-commands.json`; final freeze's own argv/cwd/result are separately sealed to avoid a cycle. `P`, `Q`, `I` retain the definitions above.

| Command | Actual exit/result | Evidence |
| --- | --- | --- |
| `python3 "$P/run-private.py" python3 "$P/task-17.3-owner-cleanup-test.py" "$Q/fix1" --legacy` | 1; expected RED1, skipped2; outer bounds/reaps fake group | fix1/logs/owner-red-supervised.log |
| Same command without `--legacy` | 0; GREEN3, no skips | fix1/logs/owner-green-final.log |
| `python3 "$P/task-17.3-stage-dependencies.py" "$Q/source" "$Q/fix1/reproduced-dependencies" "$Q/sandbox-dependencies" "$Q/fix1/dependency-reproduction.json"` | 0; exact staged byte/mode/link equality | fix1/logs/dependencies.log |
| Original rebind command plus `OCEAN_QA_REHEARSAL_NAME=rebind-rehearsal-fix1`, `OCEAN_QA_REBIND_PROOF=fix1/rebind-proof.json`, `OCEAN_QA_OWNER_HELPER=$P/task-17.3-owner-lifecycle.txt` | 0; new installed positive integration, original files preserved | fix1/logs/rebind.log |
| `python3 "$P/task-17.3-freeze-run.py" "$Q" "$Q/fix1/freeze-final"` | 0; snapshot core/private runner, 165-file inventory and non-circular seal | fix1/freeze-final/invocation.json, stdout.log, stderr.log, seal.json |
| `python3 "$Q/fix1/freeze-final/inputs/run-private.py" python3 "$Q/fix1/freeze-final/inputs/current/task-17.3-evidence-validate.py" "$Q" "$Q/fix1/freeze-final" fceb6b3e54c20deefc4bd9698fd9ec850e4269bf7dbcd66fe02a7b9de9a28db5` | 0; all165 listed files and binding/runner/dependency checks | fix1/validation-final/validate.stdout.log |
| Same command using snapshotted `task-17.3-evidence-test.py` | 0; seven actual-final-inventory controls pass | fix1/validation-final/negative-controls.stderr.log |

Targeted syntax checks parsed seven Python qualification programs and two JavaScript qualification files, exit0. Every new/changed script remains under300 physical lines. Product source/native gates were not broadly rerun under this correction; protected C files, real releases/profiles/keys/services and other checkouts remain untouched. Minor URL.pathname, historical Array.every/count, fixture-warning and declaration-advertisement notes remain deferred, not correction-loop drivers. Controller owns the next scoped review and acceptance; 17.4 has not begun.
