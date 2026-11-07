# Task 17.4 — native local backend and mixed B qualification

Status: **DONE_WITH_CONCERNS**, 2026-11-05. Native/offline and online mixed B evidence complete; Controller independent review is required. No push, merge, publication, real installed release/profile/service mutation or Task17/18 completion claim.

## Exact source and artifact

BASE `201ef280526c78e664fc26ff3226cbbe911f8e8a`; owned product commit `28909ea025c0ef46a7a1b4b539ca8a36c0e0bedc`. Root (`Q`) is `/home/ryltsevmg/Projects/Ocean-artifacts/task-17.4-201ef28-20261105T141350Z`. All bulk assets, synthetic databases, profiles, caches and evidence are outside Git. Scripts/report are under the private plan workspace. Original 17.3 sealed paths remain unchanged.

Clean detached artifact source `Q/source` is exactly28909ea. New CLI archive `Q/cli/ocean-1.1.0-rc.3-linux-x64.tar.gz`: 1475324 bytes, SHA256 `6b41ce641fa470d55799883b959a0baf764f95f90db4a778f9eee8a23a782daa`, 693 payload files verified against archive manifest. Disposable installed prefix `Q/prefix`, installed directory (`I`) `Q/prefix/lib/ocean/releases/1.1.0-rc.3`. Fresh Desktop packaging regenerated from the same clean revision: ASAR7953091 bytes/SHA256 `96837046186d298fb6466e723ecba8c31c58dadf1e7925b26e8f0c66a660b06a`. Same ASAR bytes are expected because the local provider adapter ships in CLI, while this ASAR contains Desktop/SDK/application/domain/contracts. Desktop GUI has not run under17.4.

## Verified setup

Official release API and independent official sha256sum.txt rechecked immediately before download. Ollama0.40.14 stable archive1525335029 bytes/SHA256 `993e83d08c3d13d17c55009a3e2664c8a25445e644aec3a68bef5abb6abce67d`, downloaded216.615s. Archive80 entries passed path/type/internal-link safety checks before owned extraction; no downloaded binary executed before checks. Official Ollama MIT LICENSE SHA256 `5934ed2ce0d15154bcdb9c85203210abac0da4314af34081e36df4599f90b226` preserved as backend/LICENSE. All11 bundled dependency license/notice files preserved with complete bytes/hashes (`setup/backend-license-inventory.json`), including Go and llama.cpp/vendor notices. No global installer/systemd service or install.sh was invoked.

Model manifest exact859 bytes/SHA256 `8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7`; registry supplied no content-digest header, so the digest is over exact raw bytes. Actual downloaded model1359279776 bytes/SHA256 `3d0b790534fe4b79525fc3692950408dca41171676ed7e21db57af5c65ef6ab6`, downloaded180.774s. Config487 bytes/SHA256 `517ccaff02fe9f99718ab2f478e611aa2813c36263eeed86c2427bc122d14ad8`; every template/license/params blob also matched manifest size/full digest. The Apache2 model-license blob11338 bytes/SHA256 `d18a5cc71b84bc4af394a31116bd3932b42241de70c77d2b76d69a314ec8aa12` is preserved. Full downloaded GGUFv3 parser found311 positive tensors, shape-product sum2031739904 parameters, qwen3 architecture/context capacity40960; stored `setup/gguf-proof.json`. Runtime uses the verified copied `Q/models` manifest/blobs, not a remote-only declaration or tag-short digest.

Initial available host RAM3819806720 bytes/swapused13798895616; after CI available4145127424/swapused14061064192. Disk878GB available versus /tmp tmpfs2.98GB. Bulk downloads/extraction never used /tmp. Actual preflight proved user/net/PID namespace creation, explicit loopback-up, no external routes, and a transient cgroup with cpu.max200000/100000, memory.high3221225472, memory.max3758096384 (3.5GiB), memory.swap.max0, pids.max256. No user application stopped, host swap or system setting changed. CPUAccounting's deprecated systemd property is reported by systemd as ignored; actual cpu.max/cpu.stat kernel files are the accounting evidence.

Fresh private-HOME offline dependency install first failed (exit1): metadata cache absent for @electron/windows-sign. This is retained in package-install.log/package-ledger.json. After controller-authorized exact owned cache/store copies, frozen-lockfile offline install reused422/downloaded0 with supply-chain policy pass; no lock/dependency version change or implicit Electron download. Lock SHA256 `831c7abc0be20c4b3e634cf46694fb4e03fa55371c4fe1f8e32c6a727fdb4ca1`. Pinned cached Electron45.2.1 archive rehashed to `616efc1ae4784af1a4f3f0e8774e73e7030e7bd1708da9d09bcf543dfa499beb`; packaging uses that explicit verified zip.

## Native metadata RED, exact correction and tests

`metadata-red` used unchanged accepted ec1 installed artifact/default fetch against actual backend/model. Actual /api/tags and verbose /api/show both report GGUF/qwen3/2.0B/Q4_K_M,311 tensors/context40960. Old product refused `invalid_request:unsupported local model details`, dispatchnot_sent/retryablefalse, before inference. Driver exit0 means the refusal was correctly observed, not a native acceptance pass. Actual raw metadata and exact driver output are retained. Backend/capture exit0, listener closed, cgroup and all recorded PID/starttime identities gone.

Controller approved only the exact parameter_size guard1.7B→2.0B with marketing modelIDqwen3:1.7b unchanged. No arbitrary size allowlist, metadata clamping, fallback, tensor/context/origin/hash/budget relaxation. Native-candidate regression RED2 failed/6 passed: native2.0B rejected and old1.7B accepted. GREEN98 passed across provider-local plus engine fixture. A third positive fixture was missed in the initial enumeration: required built process tests caught20 pass/1 fail in model-evidence-process/policy (local qualification unavailable). Controller approved its same literal correction; focused GREEN4 and final affected process21 passed. Source commit contains metadata guard, three positive fixture values, regression46 lines and precise local-model doc. No other product behavior changed.

Final canonical `pnpm check` exit1: strict0/lint0,3412 passed/3 protected catalog failures/44 skipped; process phase skipped by that failure. Names: uses the published catalog beyond SDK TTL; does not refresh an explicitly stale SDK catalog; cannot let delayed stale refresh outlive foreground invocation. `pnpm build`0, `pnpm format:check`1 exactly protected github-session-rig.ts/plugin-catalog-lifetime.test.ts; `pnpm typecheck:tests`0 in both contexts, lint0, affected eight built process suites21/21, actual Desktop bundle0. All final gates ran after the third fixture correction. Full argv/cwd/exits/durations in final-gate-ledger.json; initial failures remain gate-ledger.json/logs. No global-green or C-debt closure claim.

Native `metadata-green` on fresh28909ea I/default transport passes exact full artifact/backend/context qualification with zero inference, no OOM, scope/PID cleanup confirmed.

## Retained unsuccessful native qualification and diagnostics

`offline-native`: new backend, private user+net+PID namespaces, unchanged default provider transport, SQLite-backed real runTurn engine. Cold COLD_OK completed3205.955ms/first2838.535ms/actual27tokens; warm WARM_OK1020.813ms/first705.953ms/actual27tokens. Harmless tool request then settledUNKNOWN/usageunavailable interrupted after14173.321ms; no tool claim or effect. This original TaskRun is preserved/reconciling and never resumed/retried. Driver1/backend0, no OOM/swap, scope/all recorded PID identities gone. No native PASS is claimed for this phase.

Its early passive packet witness had response gaps, so it cannot establish the failed response's complete causal bytes. Receive length/IP-length handling was corrected in qualification infrastructure, followed by explicit recvmsg MSG_TRUNC and kernel packet-drop accounting. Distinct stateless `tool-diagnostic` (no executor/no original TaskRun) completed an actual native tool call with usage204 and terminalstop; direct API-only `raw-diagnostic` with original generic SYSTEM and a new diagnostic token captured complete593-byte/two-row native framing, also compatible. No decoder defect was demonstrated or product stream code changed. The first UNKNOWN's cause remains unresolved and is disclosed, never relabelled as fixed.

Controller approved a distinct profile/run IDs/token and existing public tools.instructions seam to scope the harmless fixture. `offline-acceptance2` completed cold3317.418ms, warm1112.580ms and tool10720.825ms with exactly one durable qualification_echo effect and real model continuation. It then failed installed CLI init with insecure_permissions before owner start; deliberate interruption was not reached. The setup failure was investigated: userns maps hostUID1000→ns0, while host-root-owned /,/home,/tmp appearUID65534; existing trusted-ancestor checks correctly refuse them. setup/ancestor-namespace-red.json records actual UID observations. No permission guard was loosened. A sparse owned root/mount layout is being prepared as a setup revision, with no whole host root/home mount.

## Final acceptance and scope

The final native and online acceptance below supersede the incomplete attempts as positive qualification evidence while preserving every failed phase. OpenAI/Anthropic live remain explicitly DEFERRED; no subscription credentials are imported. D autonomous A→B→A, actual GUI17.5, C and stable release F remain outside this task.

## Sparse-root setup revision and final native acceptance

The controller chose bwrap0.13.1 inside the existing shared user/net/PID namespace. Actual sparse preflight failures are retained: first backend exit1 because startup pruning tried to remove read-only manifests-v2; pinned upstream server/routes.go showed the NoPrune branch, so isolated backend setup now sets OLLAMA_NOPRUNE1. Second preflight failed closed because CapEff was RAW-only but the bounding set was broad. Setup temporarily retains SETPCAP, retires every bounding capability except NET_RAW, applies RAW-only effective/permitted/inheritable/ambient sets and NoNewPrivs1 **before** backend/client startup. Exact final mount/capability/ownership manifest is filesystem-capabilities.json. No final SYS_ADMIN capability remains. Third preflight passed actual CLI init, owner/SDK status, stopcomplete/closed/socketclosed.

Read-only mounts are explicitly **whole /usr system toolchain**, /etc/ld.so.cache, the one actual Node executable file (ldd dependencies all resolve under /usr), verified I/backend/models. Normal Arch /bin,/lib,/lib64 symlinks and fresh /proc,/dev are generated. Only the new phase and short owned TMP/RUN fixture are writable; private ancestors are namespace-owned0. No whole host root/home, real profile, old17.3 root, user bus/proxy socket or GPU device is mounted. This is trusted qualification infrastructure, not the production worker sandbox, filesystem policy or a tool grant. All nonstdio inherited FDs are closed by subprocess APIs; private allowlisted environment has no host provider/proxy/DBus values. Namespace+routes/literal failure establishes no IP egress, not universal protection against arbitrary filesystem/Unix-socket access.

`offline-acceptance3` completed cold/warm/tool and the normal owner-hosted text turn, then exposed a driver bug: execFileSync(history) blocked the same Node event loop hosting the owner and caused CLI runtime_timeout. It was corrected to async execFile in a new phase with new IDs/token/profile. Previous runs were known completed, and neither original UNKNOWN nor any uncertain effect was resumed. No product code changed for these harness/setup failures.

**Final positive phase: `offline-acceptance4`, supervisor/driver exit0.** New backend, initially `/api/ps.models=[]`, no OS cache drop. Existing `createLocalProvider` default fetch and `runTurn`, public SQLite ports, one fixed harmless ToolService executor. Model settings observed on actual outgoing requests: streamtrue/thinkfalse/num_ctx4096/num_predict512, one model/request, CPUQuota200%, provider120000ms/metadata10000ms unchanged. Driver180s/outer900s deadlines cannot extend provider budgets; all final work finished within them.

| Run | First actual assistant text ms | Submit→terminal ms | Actual result |
| --- | ---: | ---: | --- |
| cold | 2434.756 | 3122.881 | COLD_PHASE_FOUR_OK; terminalstop; actual26input/7output |
| warm | 1020.020 | 1785.045 | WARM_PHASE_FOUR_OK; terminalstop; actual26/7 |
| fixed tool and continuation | 10035.407 | 10439.748 | exactly1 echo effect, two terminal requests; actual229/28 then281/4 |
| deliberately interrupted | 997.760 | 1087.049 | own backend SIGKILL after first native text; UNKNOWN/unavailable interrupted; reconciling/no retry |
| stopped endpoint | no native text | 89.427 | failed/not_sent; unavailable not_reported, never zero usage |

Backend native durations (ns): cold total2928815783/load1792598870/prompt514868000/eval616336000; warm total1511501366/load1009599/prompt801456000/eval705616000. Counts and all tool/host durations are retained as native terminal records in http-witness.jsonl. The failed endpoint's emitted error diagnostic occurs at40ms; it is **not** model TTFT.

`effect-witness.jsonl` proves a committed pending journal claim and prior terminal model settlement before the fixed token effect. ToolService settles completed, no pending journal remains, and the model consumes the tool result before final TOOL_OK. This is the original engine, not a new loop or standalone canned HTTP executor. Separate normal installed owner/public SDK turn completed HOST_OK with terminal actual usage, and a separately spawned installed CLI reads that actual history asynchronously. Owner stopcomplete/closed and private runtime endpoint absence are checked. Reopening the SQLite store verifies every committed run event matches its preclose durable stream.

The final passive witness has32 HTTP requests,6 inference calls,5 fully framed native terminal responses and one intentionally interrupted response;3268 kernel packets,0 drops,0 MSG_TRUNC,0 gaps. The wire witness records6 api/chat submissions; backend access logs contain5 completed access lines. The intentionally interrupted request has no completed access line. No response bytes were invented. Backend intentional exit−9 is a controlled fault, not a graceful-backend-success claim. The orphan runner can remain during final-counter hold; complete namespace/scope retirement afterwards proves every recorded PID/starttime gone and listener closed. Main exit is never the sole cleanup oracle. All backend/runner/node processes observed in the final private netns match it and differ from the outer netns; actual IPv4/IPv6 external literal connects fail with no external/default routes.

CPU-only evidence is actual loaded CPU library libggml-cpu-alderlake.so, CPU KV448MiB, backend computeidcpu, `/api/ps.size_vram=0/context_length4096/runnerllamacpp` with exact manifest digest. No shared-GPU allocation or GPU peak is claimed. Kernel cgroup charged memory peak2750685184 bytes; final precollection charged2468708352 includes still-owned runner/cache, not an assertion of retained processes after scope retirement. Aggregate sampled RSS/PSS maxima2405457920/2280729600 bytes;188 samples, nominal100ms, max observed155.515ms. Highest observed per-process VmRSS/VmHWM/VmSwap/PSS and PID/starttime are in resources-summary.json. Sampled process maxima are not exact lifetime process peaks. Kernel swap peak exists and is0; max sampled swap0. OOM/high/max counters0; cpu.stat delta42379781usec (user40908364/system1471417); maximum sampled tasks60 below256. No host app or swap policy changed.

Offline seal was frozen and verified **before** reading the DeepSeek source:51 files, inventorySHA256 `e5f1cd1d9bc7c2e30a6bc369ffc717c86e4e878715f32ece48a6d2cbd47ccf7a`, sealSHA256 `53b0413d5a5be9088bd494f0a754661eecdf2986b65464c9ac9079e7c625b7c8`. The snapshotted collector/private runner verified all51 bytes/modes/hashes, exit0. This old offline seal is preserved throughout online/final work.

## Separate ONLINE mixed B

`online-mixed` is in the normal host network namespace, with a separate synthetic profile and the same bounded owned cgroup. Real local backend+real DeepSeek only. Authorized source `/home/ryltsevmg/.config/ocean-rc/deepseek.env` was parsed as a single expected assignment, never executed. Key stays in Node memory and a host-injected in-memory ProviderSecretStore Map; no argv/env/CLI credential import, headers/body logging or persistent secret-store write. Map cleared on stop. Exact in-memory key scan of every owned phase file found no copy. No personal transcript was used.

Counting HttpClient passes the unchanged request URL/method/body/headers/signal/redirect to real fetchHttpClient; no canned response, reroute or retry. Sanitized counts record model/origin/path only. Inference counts: **local3, DeepSeek7**. The seam additionally records local metadata attempted sends version6/tags4/show4 (including two failed version connections after stop) and DeepSeek models1; separate direct-fetch initial local qualification, ps and readiness probes are labelled outside that seam, so these are not a claim of every transport packet. All successful model runs have terminal actual usage; failed local usage remains unavailable/incomplete.

| Action | Local inference | DeepSeek inference | Result |
| --- | ---: | ---: | --- |
| local direct | 1 | 0 | completed |
| cloud direct | 0 | 1 | completed |
| group addressed @native | 1 | 0 | completed; unaddressed cloud/silent not dispatched |
| group addressed @cloud | 0 | 1 | completed; unaddressed native/silent not dispatched |
| healthy broadcast | 1 | 2 | native/cloud/silent all answered |
| stopped local group | 0 | 0 | failed/not_sent, no fallback |
| independently addressed cloud after local failure | 0 | 1 | completed |
| broadcast with local unavailable | 0 | 2 | native refused; cloud/silent answered independently |

Frozen identities: local providerollama/modelqwen3:1.7b/connectionnative/revision2; cloud providerdeepseek/modeldeepseek-flash/connectiondeepseek/revision1; all botProfileVersion1. Twelve run/child identities and exact bot IDs, rooms, batch children, request IDs and durable projections are recorded. The local qualification remains full manifest8f68893c…1730e7/backend0.40.14/context4096. This is addressed B, not autonomous A→B→A (D).

Online driver/supervisor/backend exit0; owner stopcomplete/closed, private runtime endpoint absent, cgroup absent and every recorded PID/starttime gone. Actual ps again shows CPU-only/context4096. Kernel charged peak2463715328 bytes; sampled aggregate RSS/PSS2227519488/2162345984;205 samples/max interval152.419ms; kernel/sampled swap0, OOM/high/max0. cpu.stat delta21488897usec (user20431173/system1057723), max tasks40. memory.events sock_throttled10 is retained, not described as an all-zero event set.

## Exact commands and exits

All `P` paths below mean `/home/ryltsevmg/Projects/Ocean-stable/.superpowers/sdd/2026-11-04-ocean-platform`; workdir is canonical Ocean-stable unless a ledger states Q/source or I. Every phase copies the exact driver/supervisor/capture/support bytes and hashes before execution. Their supervisor-result argv records the full scope, env, namespace, sparse mounts and inner command. Gates/package ledgers retain exact argv/cwd/numeric exits/durations. This matrix supplements those full records:

| Actual command | Exit/result |
| --- | --- |
| `python3 P/task-17.4-setup.py metadata` | 0; official API/checksum/license/manifest |
| `python3 P/task-17.4-setup.py assets` | 0; all exact downloads/hashes |
| `python3 P/task-17.4-unpack.py` | 0; safe entries/licenses/GGUF |
| `python3 P/task-17.4-supervise.py metadata-red OLD_I P/task-17.4-red.txt offline` | 0 harness; actual old product RED before inference |
| private vitest native-candidate.test.ts | 1; RED2/6 |
| private provider-local + provider-local-engine.test.ts | 0; GREEN98 |
| first private eight process suites | 1;20/1 introduced positive fixture mismatch |
| private model-evidence-process.test.ts after exact third fixture fix | 0;4 passed |
| `python3 P/task-17.4-gates.py` final | program0; individual check1/build0/format1/strict0/lint0/process0(21)/bundle0 |
| `python3 P/task-17.4-package.py 28909ea…` | 1; initial empty private cache setup failure |
| same plus `resume-after-private-cache-failure` | 0;422 reused/0 downloaded, clean source/build/bundle/CLI/prefix/Desktop |
| supervise metadata-green / tool-diagnostic / raw-diagnostic | 0/0/0; actual metadata GREEN and labelled diagnostics |
| supervise offline-native / offline-acceptance2 / offline-acceptance3 | 1/1/1; retained UNKNOWN, ancestor setup RED, sync-driver deadlock |
| supervise sparse-owner-preflight /2 /3 | 1/1/0; RO prune, capability fail-closed, actual owner/SDK GREEN |
| supervise offline-acceptance4 | 0; final actual native acceptance |
| `python3 P/task-17.4-freeze.py offline` | 0;51-file offline seal |
| copied private runner + copied freeze.py verify offline-seal pinnedSHA | 0;51 verified before online |
| supervise online-mixed | 0; real DeepSeek+local B acceptance |
| `python3 P/task-17.4-resources.py` | 0; exact kernel versus sampled metrics |
| `python3 P/task-17.4-assets.py` | 0;825 exact consumed asset files rehashed |
| focused prettier qualification.md/local-model.md | 0; no source changes after product gates |

Final consumed825-file asset inventory `assets-final.json` SHA256 `165a889b474d69e4a62e1830d46f3942196a418b16148a387b15eb7b6c6a0fb1` binds original backend archive, all extracted backend files/licenses, actual model manifest/blobs, all installed CLI files and entire fresh Desktop artifact. Source worktree remains clean at28909ea. Protected hashes remain github-session-rig.ts `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031` and plugin-catalog-lifetime.test.ts `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`.

## Remaining concerns

- First generic-tool UNKNOWN remains unexplained because early response capture was incomplete; no product defect/fix is invented. Final success covers explicitly scoped harmless tool instructions, not arbitrary tool reliability.
- C's3 catalog failures/2 formatting files remain. No global clean-pass claim or deletion/exclusion of foreign tests.
- OpenAI/Anthropic live DEFERRED. CPU-only measured on this host/one model/one request; no GPU, broad benchmark or external-service reliability promise.
- New sparse fixture has a broad read-only /usr toolchain; it does not replace production tool sandbox/grants or claim arbitrary filesystem isolation.
- Artifact source28909ea differs from the later QA/report/docs commit; source code and final gates are not retroactively attributed to a later product revision.
- Controller independent review/acceptance required. 17.5 must consume fresh I/CLI/desktop artifacts here; parent17,18+, stable F and real installation remain incomplete/out of scope.

## Final immutable evidence and review handoff

Final exclusive freeze `Q/final-seal` covers385 focused files: every retained phase's actual driver/supervisor/source snapshots, commands/exit/resource/network/mount/capability/HTTP/usage/cleanup proof, synthetic durable state, all relevant root/build/package logs, upstream metadata/licenses/GGUF proof, the offline seal and consumed-asset inventory. It excludes bulk cache/source copies and giant binaries from the compact evidence file set; their actual consumed825 file hashes remain bound by assets-final.json. No broad inventory of old17.3 history was generated.

Raw SHA256 anchors:

- Final inventory: `df6df7a2045f6acd1e4096f6c575811422d199444353ce83c6ab372c5c803a19`.
- Final seal: `503ad1f1e99010a83b492d24c4465c229bf940f37b28c3db2700a5daf4936121`.
- Post-freeze validation attestation: `b6a284f1d058e90038c50c90976544cfcaceb77099faac5c7a76df4d87de6fca`.

Exact final commands: `python3 P/task-17.4-freeze.py final` exit0, with exclusive stdout/stderr capture and argv/cwd/exit0 in Q/final-freeze-invocation.json. The post-freeze attestation binds that record and verified stdout/stderr hashes; the primary inventory/seal never hashes its own output. Copied `final-seal/inputs/run-private.py` ran copied `task-17.4-evidence-controls.py FINAL_SEAL PINNED_SEAL_SHA`, exit0. Three controls pass: actual385-file hash/size/mode validation, copied mixed-proof tamper rejection, and rehashed omission of mandatory mixed-proof rejection. Test mutations occurred only in a fresh owned copied evidence root, which was removed. Final stdout/stderr hashes independently match the attestation's invocation record. Original offline51-file seal remains unchanged.

Final syntax/size proof (`setup/final-syntax.json`):11 Python AST parses and7 JavaScript module syntax checks, all0; maximum helper175 physical lines. The six actual source/test/doc files were reviewed against BASE; production delta is the single exact size guard plus accurate fixtures/regression/doc. Final QA scripts are trusted opt-in infrastructure, not a product install/model-download feature. Only those QA scripts, location pointer, report and public qualification facts are in the later QA commit; actual assets/profiles/transcripts/private backend-generated identity remain outside Git.

Read-only final hashing confirms all six original17.3 fix1/fix2 inventory/seal/attestation anchors unchanged. No old qualification program was rerun and no sealed old path was written. Real Ocean1.0/RC2 installations, services, keys, profiles and other checkouts remain untouched. Controller owns the independent review and publication decision; this worker spawned no helper/reviewer and performed no push/merge.

## Correction1/5 — three Important qualification-helper findings

FIX_BASE `1a95a2e8abcf0037e771ccd3e71886850192ba91`. This correction is limited to I1/I2/I3 and new breakage in those changes. The full independent review supports the actual native/offline and online mixed facts and product28909ea. No product source, model/backend inference, DeepSeek key read, packaging/build, broad pnpm/native suite, real service/profile or old seal was changed or rerun. The explicit focused contract is `task-17.4-fix1.md`; the controller owns the scoped re-review and deferred minors.

New owned evidence is **Q/fix1**. Original executed driver snapshots stay byte-for-byte in the old51/385 chains. Current helpers have separate new snapshots/hashes; the new helper code is not attributed retrospectively to the original native runs.

### I1 — complete role and security predicate

`task-17.4-identities.py` defines explicit phase contracts and inspects every matching sample observation, using PID/starttime identities, actual comm names (`ollama`, `llama-server`, `node`, `node-MainThread`) and trusted argv role patterns. Full native offline requires backend, runner, driver, CLI-init, CLI-history and binder; mixed online requires backend, runner, driver and CLI-init. Metadata-only requires backend+driver, not a model runner. Additional observed Node identities also receive namespace/capability/NNP checks; a late good observation cannot erase an earlier bad one. Missing/invalid identities, unknown phase policy, missing required roles or security mismatch refuse.

Sparse offline policy is explicit private netns unequal to outer, CapEff/CapBnd0x2000 and NoNewPrivs1. Online uses the ordinary nonroot policy: host netns, nonroot trusted outer UID, CapEff0/NNP0 and bounding set equal to the trusted outer launch reference. The supervisor now captures that reference independently before launching candidate processes. For read-only historical comparison, `historical-predicates.json` labels the reference as a **CURRENT host comparison**, not a newly invented historical launch attestation. The controller approved this distinction; expected security values are never learned from candidate rows.

Copied final offline samples pass with6 relevant identities/545 relevant observations and all6 roles; copied online pass with4 identities/473 observations/all4 roles. The original metadata-green samples lack capability/NNP fields: their new full-security predicate is explicitly **unavailable/refused**, not requalified or fabricated. Actual final native acceptance already covers the positive candidate metadata and complete security facts.

The exact legacy predicate was extracted from the pinned BASE helper bytes for RED. Proper RED:14 tests,12 failures/2 positives, exit1. GREEN:14/14, exit0. Cases include missing all Node clients, missing history client, missing runner, wrong runner namespace, one transient wrong client namespace, wrong client CapEff, runner bounding set/NNP, online wrong CapEff/NNP, malformed starttime and metadata-without-runner. A preliminary RED harness had indentation errors; it is retained but is not the behavioral RED. The actual supervisor postprocessing now calls this validator for offline and online; the freezer requires the full identity verdict and confirmed scope retirement, so the old boolean alone cannot certify evidence.

### I2 — retirement follows cgroup population

`task-17.4-scope.py` captures the unique unit ID/InvocationID, canonical current-user cgroup path, device/inode and owning UID. Before every signal it verifies the same unit/cgroup identity. It reads actual cgroup.events population and cgroup.procs, drives bounded TERM/grace/KILL regardless of launcher exit, and confirms actual disappearance or population0/procs0. It never signals by a bare PID or another scope. Unit unloading can precede cgroup disappearance: empty-state reads use the recorded inode independently, while all signal targets still require live verified unit identity. Observation/ownership failure remains explicit cleanup-unknown, never a pass.

The supervisor invokes this retirement on normal and exceptional paths after monitoring, even when its launcher is already gone. It then independently reaps the launcher and checks all recorded PID/starttime identities; an original work/observation error remains a failing qualification even if cleanup succeeds. Final exit requires the full identity policy, confirmed scope retirement, independent process disappearance and other existing gate facts.

Real disposable controls use only fresh `ocean-17-4-fix1-*` user scopes with MemoryMax64M/SwapMax0/TasksMax16/CPUQuota100% and a clean-env tiny Python process. The launcher actually forks a TERM-ignoring orphan and exits0 while cgroup.events remains populated1. Exact legacy post-launch code reproduces the bug: one failure/two new-control skips, exit1; the independent test supervisor verifies the owned unit before KILL and reaps the orphan even on this RED.

GREEN3/3, exit0: the orphan is retired by TERM→KILL after launcher0; unavailable observation does not certify cleanup or signal without observation; wrong InvocationID never signals. The outer fixture safely retires/reaps the negative-case scopes and verifies cgroup disappearance and PID/starttime absence. All16 disposable orphan identities from preliminary/final attempts are gone (`all-disposable-cleanup.json`); no other scope was targeted. The first attempted private-runner command could not reach the user manager bus and started no orphan; the valid scope test runs in the existing outer manager environment, while its child receives a clean environment. Intermediate unit-unload/empty-cgroup races in both helper observation and test-finalizer handling were found, retained and corrected. One interrupted intermediate finalizer did not write its case proof; independent final verification confirms that already-killed PID identity and scope gone. The valid RED and final GREEN controls have complete reaping/cleanup records.

### I3 — resource output is exclusive and fresh

`task-17.4-resources.py` now uses exclusive descriptor-relative O_CREAT|O_EXCL|O_NOFOLLOW publication, mode0600, validated private directory ancestry and parent identity checks. The default existing Q/resources-summary.json refuses before aggregation or truncation. An explicit follow-up output must be a new file below the owned Q/fix1 root; outside/traversal/symlink paths refuse. A concurrent competing file is preserved. No real sealed resource output was ever opened for truncation in a RED test.

Exact legacy helper RED used only a disposable preexisting dummy: it replaced the dummy bytes, one failure/five new cases skipped, exit1. GREEN6/6, exit0: existing collision, fresh default/second-call refusal, explicit fresh follow-up, outside/traversal/escaping-symlink refusal, exclusive-create collision race, and real sealed-default refusal with identical hash/mode/mtime. Actual documented CLI `python3 P/task-17.4-resources.py` now exits1/FileExistsError, with original sealed resource-summary hash/mode/mtime unchanged (`default-summary-refusal.json`). Tests used dummy roots and never regenerated the original summary.

### Final focused commands and checks

`python3 P/task-17.4-fix1-gates.py final2` exit0. `fix1/final2-commands.json` records exact argv/cwd/exits/durations; its scopes require the existing outer user manager, while all other tests use the unchanged private runner.

| Command | Actual result |
| --- | --- |
| private `task-17.4-identity-test.py --legacy` | exit1; proper RED12 failures/2 positives |
| `task-17.4-scope-test.py --legacy` | exit1; proper RED1 failure/2 new-control skips, orphan reaped/scope gone |
| private `task-17.4-resource-test.py --legacy` | exit1; RED1 failure/5 new-case skips, disposable dummy only |
| private `task-17.4-identity-test.py` final | exit0;14 passed |
| `task-17.4-scope-test.py` final | exit0;3 passed, all owned descendants retired/reaped |
| private `task-17.4-resource-test.py` final | exit0;6 passed |
| private `task-17.4-fix1-integration-test.py` final | exit0;4 passed |
| documented default resource-summary CLI | exit1/FileExistsError as required; sealed bytes/mode/mtime unchanged |
| Python AST/physical-line checks | 11 parsed,0 errors; maximum180 lines |

Total final covering tests: **27 passed /0 failed /0 skipped**. Integration executes the actual AST-selected supervisor postprocessing/final-exit and freezer guard against copied facts/dummy records; it verifies6/4 actual identity coverage, refuses the old namespace boolean alone, refuses unconfirmed retirement, and preserves an original failure. These controls do not invoke the backend, model, product owner or cloud.

Product source28909ea, CLI SHA256 `6b41ce641fa470d55799883b959a0baf764f95f90db4a778f9eee8a23a782daa`, ASAR SHA256 `96837046186d298fb6466e723ecba8c31c58dadf1e7925b26e8f0c66a660b06a` remain unchanged. Root check/build/format/model/GUI suites are deliberately not rerun under this evidence-helper-only correction contract. Prior catalog3/format2 debt, original generic-tool UNKNOWN, CPU-only measurement scope, deferred OpenAI/Anthropic, D/E/17.5/F and review limitations remain as previously disclosed. The two Minor findings are parked for the controller; they did not expand this fix loop.

### Correction1 immutable handoff

`Q/fix1/freeze-final` contains117 focused new files: exact current helper/test/collector/private-runner snapshots; copied selected sample inputs/provenance and historical predicate results; real disposable scope argv/exits/TERM/KILL/observation/cleanup records; collision/dummy/default-refusal records; final27-test command logs/ledger and syntax results. Original model/product history is referenced by its old anchors, not requalified or copied wholesale. An exclusive noncircular seal binds inventory and exact collector bytes; `fix1/freeze-invocation.json` records actual argv/cwd/exit0 and stdout/stderr hashes outside the primary inventory.

Pinned raw SHA256:

- Fix1 inventory: `861bd2c9867cf12fcba5dfa9d7a167d5089487647da1fe516ca625d523e65b06`.
- Fix1 seal: `d13375cf4a2557af7128617fe84013a1659c892c7f39d4ea68052a611ae6ad93`.
- Post-freeze validation attestation: `7d8bdd010340e4c42d9ac91e952d30d4f40f7658d9ac6a6cbaca2647efaa78c9`.

Exact freeze command: `python3 P/task-17.4-fix1-freeze.py freeze`, exit0. Copied `freeze-final/inputs/run-private.py` executed copied `task-17.4-fix1-freeze.py verify FIX1_FREEZE PINNED_SEAL_SHA`, exit0, all117 bytes/sizes/modes verified. The post-freeze attestation binds that exact validation command/result/output and verifies the freeze invocation stdout/stderr hashes. Freeze read-only verification confirmed all original51+385=436 listed records and old inventory/seal/attestation anchors; six original17.3 fix1/fix2 anchors also still match. No old seal/input was overwritten.

Protected file hashes remain `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031` and `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`. Controller plan changes are excluded. This owned QA correction commit requires independent scoped FIX_BASE..HEAD review; no helper/reviewer, push/merge, Task17.5 work or release claim occurred.

## Correction2/5 — I1/I2/I3 follow-up and N1/N2/N3

FIX_BASE `c27b33e64176f3cbbed55f068edd253df1688f19`. The first scoped review left I1/I2/I3 open and identified three new Important helper findings. This round addresses those six and their direct integration only. The product28909ea/CLI6b41ce…2daa/ASAR968370…b06a and previously supported actual native/live facts remain unchanged. No model/backend inference, DeepSeek key read, product source edit, build, broad suite, GUI, push or merge occurred. New outputs are exclusively **Q/fix2**; original51/385/117 chains are preserved.

### Actual RED and identity/PID corrections

`task-17.4-fix2-regression-test.py --legacy` executes pinned BASE helper bytes against copied samples/mocks/dummy trees. **Nine tests failed, exit1**, with no errors/skips: collapsed Node identities, same-identity conflicting roles, cross-observation argv mutation, PermissionError incorrectly treated as PID disappearance, middle-ancestor symlink escape, partial admission incorrectly reporting scopeGone, fresh-label shared-syntax overwrite, manager show timeout escape and manager kill timeout escape. No legacy orphan code ran with a real child, and no old gate ran against real sealed data. The regression GREEN is9/9.

I1 now associates immutable fingerprints with each PID/starttime: canonical compatible Node comm alias, argv, namespace, capabilities, NNP and fixed phase policy. Contradictory same-identity entries anywhere refuse. Required separate-process roles have disjoint identity witnesses; a single PID/starttime cannot supply the four Node roles. A single observation cannot contain two starttimes for one PID. Starttimes must be canonical positive decimal strings. Legitimate `node`/`node-MainThread` aliases and PID reuse in different observations remain supported. Existing complete offline/mixed positives, all matching observations, metadata-no-runner distinction and explicit trusted-outer online policy remain; no expectation is learned from candidate records.

I2 adds `task-17.4-process.py`, which reads only `/proc/PID/stat` for the independent identity proof. It returns **present**, **gone** or **unavailable**. Only ENOENT/ESRCH or a successfully parsed different starttime proves original identity gone. PermissionError, other I/O, malformed PID/stat/starttime and unrelated optional proc-field failure never certify disappearance. PID/stat-prefix identity is checked. The sampler can still omit unavailable optional fields, but its None is never used as disappearance proof. The supervisor's final gate now requires the dedicated `pidIdentityCheck.confirmedGone`; empty cgroup/old boolean alone cannot replace it. Controls cover live, absent, reused, denied, I/O, parse error and unrelated-field denial, including an actual live test-process stat read. The actual supervisor final-exit AST also rejects unavailable PID evidence despite otherwise-successful cleanup facts.

### Descriptor-relative output and isolated gate runs

I3 uses `task-17.4-private-output.py`: start from an opened trusted system-root descriptor, walk every component of the private owned root with O_DIRECTORY|O_NOFOLLOW and fstat validation, then walk every output-parent component relative to that held root. No absolute parent is reopened after path checks. Exclusive complete-byte publication is relative to the verified parent descriptor, mode0600/O_CREAT|O_EXCL|O_NOFOLLOW. Existing targets refuse, including the old default summary; outside/traversal and symlink paths refuse. The middle-ancestor swap control replaces a directory with a link immediately before its open, while the final component remains real; the corrected writer refuses and creates nothing outside the held root. Full summary JSON bytes are computed before exclusive file creation as part of this flow. N4 remains a parked Minor, not a separate expansion of this round.

N2 rewrites the gate driver around a constrained lowercase label and an **exclusive fresh per-run directory**, Q/fix2/runs/LABEL. Label validation precedes directory creation or test effects; absolute, traversal, separator, empty, uppercase and oversized labels refuse. Existing-label collisions refuse before launching tests. Each run holds its private directory descriptor, writes distinct logs and exclusively publishes commands.json and syntax.json once. A fresh label creates another run directory and cannot rewrite old shared syntax or another run's bytes. Failure/timeout still publishes its own command ledger; failed runs do not claim a syntax pass. Tests use dummy roots and mocked command effects. The old real fix1 syntax/ledger/logs are unchanged.

### Admission-safe orphan fixture and structured timeouts

N1 replaces the old unlimited orphan with a cooperative pilot in a uniquely named small user scope. The pilot publishes ready.json atomically, then waits for admission; it **cannot fork the TERM-resistant child before the fixture captures and verifies the unit/InvocationID/cgroup inode/owner**. Only then does the fixture exclusively publish admit. The orphan PID record is complete and atomically linked into place. The pilot has its own8-second hard alarm (and5-second admission deadline); the TERM-resistant orphan has an independent6-second hard alarm. The fixture has a12-second budget; launcher waits have timeouts and orphan waitpid uses WNOHANG within the deadline. All signals still target only a verified owned unit, never a bare PID.

Missing ownership stays cleanup-unavailable/scopeGoneNone, never success. Mocked empty/partial ready data and manager lookup timeout prove admission is withheld, no orphan body runs, waits stay bounded, the original error remains and a failure proof is written. The real essential control verifies ownership timestamp precedes fork timestamp, actual launcher exit0 with populated scope, TERM→KILL, bounded reaping and direct PID/starttime disappearance. It uses64MiB/SwapMax0/TasksMax16/CPUQuota100% and clean child env, with no backend/model.

There were two actual tiny trials, not a hidden rerun of any model: green1 retired/reaped correctly but its test required immediate directory removal although the actual kernel already reported population0/procs0; that overstrict assertion failed. The corrected criterion accepts confirmed emptiness or removal. Green2 passes all3 scope controls. Independent final read-only checks find both pilot/orphan identity pairs gone and both scopes removed (`owned-cleanup.json`). No later scope was started.

N3 catches subprocess.TimeoutExpired from manager show/kill as structured unconfirmed retirement with the original typed/message cause. No timeout is converted to success or an unverified signal target. `task-17.4-finalize.py` lets the caller reap/check identities and retain its failure ledger even when retirement or launcher wait raises. An already existing work exception is returned as the same object and its diagnostic remains the original cause; cleanup failure is recorded separately. Mock timeout controls exercise both manager paths and verify independent wait/identity checks still execute, the failure ledger contains TimeoutExpired, and the final gate fails.

### Final focused results and exact execution

The fresh gate command `python3 P/task-17.4-fix1-gates.py green2` exits0 with6 groups: regression9, safety controls7, existing identity14, resource6, supervisor/freezer integration4 and scope3, all passed. Its exact argv/cwd/numeric exits are in `fix2/runs/green2/commands.json`; source parsing covered26 Python helpers. No shared syntax.json was rewritten.

After the final canonical-starttime input guard and independent-PID final-gate assertion, a fresh **non-scope** invocation calls `gate.run('final', Q/fix2, commands=...)` for the five exact private-runner/env commands recorded in `fix2/runs/final/commands.json`:9+7+14+6+4=**40 passed**, exit0. It does not rerun the scope. Together with the unchanged real fixture's3 passing controls, the final distinct covering set is **43 tests passed,0 failed,0 skipped**. `selection.json` records this component attribution rather than counting repeat passes twice. The gate leaves both earlier runs and all historical seals intact.

| Actual command/control | Exit / result |
| --- | --- |
| private fix2 regression `--legacy` on BASE copies | 1;9 expected failures |
| private fix2 regression corrected | 0;9 passed |
| `task-17.4-fix1-gates.py green1` | 1; all non-scope groups passed; immediate-scope-removal assertion failed after actual cleanup |
| `task-17.4-fix1-gates.py green2` | 0;43 passed across6 groups |
| final fresh non-scope gate invocation | 0;40 passed across5 groups, no new scope |
| read-only owned-cleanup verification | 0; four known pilot/orphan PID identities gone, two scopes removed |
| final focused helper/dependency AST/line checks | 17 parsed incl collector,0 errors, maximum177 physical lines |

### Correction2 immutable evidence and handoff

`Q/fix2/freeze-final` contains164 focused files: pinned legacy input helpers and copied sample provenance; every new counterexample/dummy/mocked ledger; fresh per-run command/syntax/test records; the two actual bounded pilot/orphan proofs; all current correction helpers/tests/dependencies and exact collector/private runner snapshots. Historical product assets and full old history are referenced, not regenerated or resnapshotted.

Pinned raw SHA256:

- Fix2 inventory: `b72a7b089bf32704b9015eaf004c02521285c0b99e1efd32d783ce518f01c04c`.
- Fix2 seal: `cf5a086324004e1f43216f357d84863768134ad10e1fc21fb1f1ecd8739b28c4`.
- Post-freeze validation attestation: `b20ab0fac97c89b1ef6c9e146a95986f6fb65e8be0ec959dd27f1dccfa2621c3`.

Exact freeze: `python3 P/task-17.4-fix2-freeze.py freeze`, exit0. Copied private runner executes copied collector's `verify FIX2_FREEZE PINNED_SEAL_SHA`, exit0, all164 file bytes/sizes/modes verified. Freeze argv/cwd/exit and stdout/stderr hashes are separately recorded; post-freeze attestation binds and checks them without a self-hash cycle. Read-only verification matches **51/385/117** old entries, their seals/inventories/attestations and all six17.3 anchors. No old sealed input was replaced.

Product source/artifacts, protected C files and controller plan are unchanged by this correction; root build/check/format/native/live suites are deliberately not run under the focused contract. The remaining original generic-tool UNKNOWN, C debt, deferred vendors, CPU-only scope and out-of-scope release/GUI/D/E limitations remain disclosed. N4 and prior documentation Minors stay with the controller. Independent scoped c27b33e..FIX_HEAD review is required; no reviewer/helper, push/merge or17.5 work occurred.

## Correction3/5 — remaining Important I1/I2/N3

FIX_BASE `9966242fadb79ec3e47092ebd81c509c01eb3cb9`. This round changes only the three remaining Important evidence-helper findings and their direct caller tests. The previously supported actual native/offline and live mixed B results remain historical qualification facts. No real scope/orphan, model/backend, provider/key read, product edit, broad suite, rebuild, GUI, helper/reviewer, push/merge or Task17.5 work occurred. Every new output is below Q/fix3; old51/385/117/164 chains are read-only references.

### Consistent identity observations before role filtering

I1 now discovers recognized PID/starttime witnesses before filtering role names, then checks every occurrence of those identities for the same canonical fingerprint. A duplicate recognized Node identity reported as `sleep`, including changed argv/namespace, refuses whether it appears before, after or in another observation. A simultaneous unknown-name row reusing a recognized PID with a different or malformed starttime also refuses. An unrelated helper identity receives no Node policy. Canonical `node`/`node-MainThread` aliases, separate required role identities, legitimate PID reuse across observations, all complete6/4-role positives, metadata-only phase distinctions and the fixed trusted-outer online policy remain covered. No expected identity or privilege value is learned from candidate observations.

I2 validates the observed `/proc/PID/stat` starttime as canonical positive ASCII decimal before comparing it with the recorded tick. A leading-zero spelling of the same tick now yields **unavailable**, rather than falsely proving PID reuse. Signed, Unicode-digit and zero ticks also remain unavailable. Successful canonical different-tick observation and ENOENT/ESRCH retain the limited gone proof; present/denied/malformed remain distinct. The only actual process observation in this round reads the test process's own PID stat without mutation.

### Actual supervisor publication survives secondary diagnostic failure

N3 moves post-finish secondary diagnostics into `task-17.4-finalize.py`'s shared `complete` path. Each diagnostic exception is recorded, the original work exception object/cause is retained, final failure status is calculated and the supervisor-result writer runs from `finally`. The actual supervisor tail invokes this path for the remaining scope/resource/identity/fixture diagnostics, so a secondary snapshot UnicodeDecodeError cannot escape before failure-ledger publication.

The caller regression executes the **actual supervisor tail and its AST-selected actual writer**, with copied/mocked cleanup data; it does not replace publication with a synthetic test writer. Original UnicodeDecodeError plus structured manager TimeoutExpired and a secondary snapshot UnicodeDecodeError preserve the original error object, record the secondary failure, execute independent wait/identity checks, publish supervisor-result.json and produce status1. The healthy actual tail produces status0; a secondary-only failure is recorded and fails the gate. These tests do not start a supervisor/backend process or signal a real scope.

### Actual RED/GREEN commands and source attribution

Commands below ran from `/home/ryltsevmg/Projects/Ocean-stable`; P/Q retain the exact roots defined earlier. The fresh per-run ledger `Q/fix3/runs/final/commands.json` records every exact argv/cwd/numeric exit and its separate log.

| Actual command/control | Exit / result |
| --- | --- |
| private `task-17.4-fix3-test.py --legacy`, initial BASE copies | 1;10 tests,7 failures/3 positive controls |
| current shared-PID contradictory-start regression before its guard | 1;11 tests,1 failure/10 positives |
| private `task-17.4-fix3-test.py --legacy`, final counterexample set | 1;11 tests,8 failures/3 positive controls |
| `python3 P/task-17.4-fix3-gates.py green` | 0;50 non-scope tests before the extra shared-PID control |
| `python3 P/task-17.4-fix3-gates.py final` | 0;**51 passed,0 failed,0 skipped** |
| final gate AST syntax record | 0;29 helper files parsed |
| collector's final current source/dependency checks | 0;19 files parsed, maximum179 physical lines |

The final51 comprise11 correction3 caller/identity/stat tests,9 correction2 regressions,7 safety controls,14 existing identity tests,6 resource tests and4 supervisor/freezer integration tests. They use copied actual samples, mocks and disposable filesystem outputs, plus the single read-only own-PID observation. No historical scope controls are counted in51.

`Q/fix3/historical-scope-attribution.json` explicitly attributes the older three scope controls (one real gated scope plus two mocked negative controls) to source9966242 and `Q/fix2/runs/green2/scope-test.log`. This is documentary correspondence with sealed source snapshots, not an execution-time source attestation. Scope-test, scope-pilot, scope and orphan-fixture source hashes still match that historical set; process.py differs: historical `fd7f4dc624833632c79a08df0c658d1376f70451e58145a467ea8630414cbb05`, current `543b6fdf624ef4f0679400a5ac13c261f4fbd7fb6bd444b8ade1be8f23165149`. Those three controls were **not rerun against current process.py** and do not establish a current43-test aggregate.

Remaining Minor N1 (fixture's cumulative12-second budget is not shared through manager retirement) and Minor N2 (FileNotFoundError on executable launch can omit attempted argv from its ledger) are parked, not fixed or loop drivers. N4 and prior documentation Minors remain parked. This round makes no new claim about those paths or about arbitrary filesystem isolation.

### Correction3 immutable evidence and handoff

`Q/fix3/freeze-final` seals167 focused files: BASE helper snapshots and copied sample provenance; actual RED/GREEN logs and fresh command/syntax ledgers; caller/stat/identity controls; current19 helper/dependency snapshots; selection and historical-source attribution; exact collector/private runner. No old historical tree was regenerated.

- Fix3 inventory SHA256: `2cb13f79b960401ac26c06b096c9d243cb70a4842ea4a68bf76f6c7a740f7c67`.
- Fix3 seal SHA256: `6ca7b21bb03eded061a21775c6b2c58ef4be8ec9f072adccdfac35c49d0b989c`.
- Post-freeze attestation SHA256: `c7900fd600f4f1d5d399e3aa7284a508c31a1822c65f28438dc08d83b5d1ff30`.

Exact freeze command `python3 P/task-17.4-fix3-freeze.py freeze` exited0. Exact post-freeze validation was `python3 Q/fix3/freeze-final/inputs/run-private.py python3 Q/fix3/freeze-final/inputs/task-17.4-fix3-freeze.py verify Q/fix3/freeze-final 6ca7b21bb03eded061a21775c6b2c58ef4be8ec9f072adccdfac35c49d0b989c`, exit0; all167 bytes/sizes/modes matched. Attestation binds that argv/cwd/result/output hashes and the actual freeze invocation. Freeze stdout SHA256 is `81941547190efe5f2635c0b12076ba5a5fee8ce02b569d2e91e3fb034d1b7fb3`; validation stdout is `17b7809989489c7ac4048cd8a5c35ba270f8a54df28344333dbdf3af9f13ad24`; both stderr files are empty. Read-only verification matched all old51/385/117/164 entries and their inventory/seal/attestation anchors, plus all six17.3 anchors. No old seal was rewritten.

Product source28909ea, CLI SHA256 `6b41ce641fa470d55799883b959a0baf764f95f90db4a778f9eee8a23a782daa` and ASAR SHA256 `96837046186d298fb6466e723ecba8c31c58dadf1e7925b26e8f0c66a660b06a` are unchanged. Prior native/live authority limits, original unexplained generic-tool UNKNOWN, C debt, CPU-only scope, deferred OpenAI/Anthropic and D/E/GUI/release exclusions remain disclosed. Root check/build/format and model/provider qualification are deliberately not repeated under this narrow QA contract. Protected file hashes remain `d6ea013e8333688abb36e51c7a09922a077f5a1726f203258bc06f49e642c031` and `68f28f549e0713f5c21d47950b6db96babdb27a7b9264684268c571b7cde62a3`; controller plan changes are excluded. The owned correction commit is discoverable from this report's Git history. Fresh independent scoped9966242..FIX_HEAD review is required before stage closure; this report does not claim review or release completion.

Controller acceptance: Task17.4 accepted on de70683 after full review plus three scoped corrections. The prior six-submission attribution is corrected above: six wire submissions, five completed backend access lines. Raw proof counts and seals were not regenerated. GUI17.5.1–3 and parent17/C/D/E/F remain open.
