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

The final passive witness has32 HTTP requests,6 inference calls,5 fully framed native terminal responses and one intentionally interrupted response;3268 kernel packets,0 drops,0 MSG_TRUNC,0 gaps. Backend access logs independently show6 api/chat calls. No response bytes were invented. Backend intentional exit−9 is a controlled fault, not a graceful-backend-success claim. The orphan runner can remain during final-counter hold; complete namespace/scope retirement afterwards proves every recorded PID/starttime gone and listener closed. Main exit is never the sole cleanup oracle. All backend/runner/node processes observed in the final private netns match it and differ from the outer netns; actual IPv4/IPv6 external literal connects fail with no external/default routes.

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
