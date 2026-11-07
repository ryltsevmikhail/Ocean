# C18.1 — public MCP SDK qualification

> The initial decision below describes the pre-review checkpoint. The qualification decision is held for scoped review of [correction 1](#correction-1--invocation-send-lifetime).

**Decision: the configured 2.4.0 candidate passes this prototype gate, subject to independent review.** All 22 HTTP/catalog cases, six actual Linux stdio cases and the approved real GitHub read passed. Keep Executor as the sole production adapter. This is evidence for 18.2 design, not installed-product acceptance.

Base `5c2d807f7b0ff81c07e5a138c9d5b94f4468013f` on `codex/ocean11-stable`. Evidence root: `/home/ryltsevmg/Projects/Ocean-artifacts/c18.1-gzlNTEkb` (0700). `final-prototype.json` contains wire methods, statuses, actual response media types, synthetic headers, PID/start observations and retirement results. `github.json` contains only counters and sanitized issue identity. The final offline invocation intentionally omitted the credential: its aggregate is **false** because the required live case was not run within that process. The separate real live invocation supplies that evidence; no second read was sent to make an aggregate flag green. Running the exported harness without native or without the approved credential cannot qualify it.

## Candidate identity

* [Upstream release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0); `git ls-remote … refs/tags/v2.4.0` and npm SLSA provenance subjects for client, server and core resolve to **951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5**. Directly downloaded the three npm tarballs, recomputed SHA-512, compared against both registry integrity and attested digest. This compared published provenance data, without an independent signature audit. `upstream.json` retains export keys and exact identities.

* `@modelcontextprotocol/client@2.4.0`: `sha512-LgrD2OphHuG12vfKFKz6SOnq7bKHQmhGJIAYdD+MZBn2npHEyry6uD8zvktodtl5CQM85MO0anUyD9JwmUmxww==`.
* `@modelcontextprotocol/server@2.4.0`: `sha512-rgR9yxSaAJ+bcsi/XroT/S2AfPiIWloXAnrdfYSCms9ivVju0ishu/wW0J21Ho6+ZOR1r7RyeRbjiRuF87ix5Q==`.
* `@modelcontextprotocol/core@2.4.0`: `sha512-z8QBKqdfXLPzkLQuG4xp8hrVEMm1PZ1IgxMN2sMbJiFiAKOWXnAzogXn2W4aqIBlP1ea6U5yiqVquvUNM1Cj6Q==`.

The [tagged client manifest](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/package.json) exports ESM/CJS root and `/stdio` with declarations, Node >=20. Ocean compiled the real constructors and calls with Node 26.13.0, TypeScript 5.9.3, pnpm 12.16.1, strict NodeNext, including exact optional properties. Lock SHA-256: `48509bebe1d0f514d27dd5493c1128b3c86a98062822c39341f111d17e971953`. No private import, patch, custom JSON-RPC client/server, or fallback. The HTTP fixture routes HTTP bodies to the SDK's public server handler; the stdio fixture uses its public server transport.

**License inventory.** Client, server fixture and core: Apache-2.0; client/server published LICENSE SHA-256 `0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a`. Runtime lock closure: MIT cross-spawn 7.0.6, eventsource 3.0.7, eventsource-parser 3.1.1, jose 6.2.15, path-key 3.1.1, pkce-challenge 5.0.1, shebang-command 2.0.0, shebang-regex 3.0.0, zod 4.6.7; ISC which 2.0.2 and isexe 2.0.0. Published source maps also identify embedded MIT @cfworker/json-schema 4.1.1, ajv 8.18.0, ajv-formats 3.0.1, content-type 1.0.5, fast-deep-equal 3.1.3, json-schema-traverse 1.0.0 and BSD-3-Clause fast-uri 3.1.8. Existing workspace rolldown 1.2.16 only builds the disposable stdio fixture. Preserve notices when producing a later distribution. No change to LICENSE/NOTICE or installed dependency inventory here.

## Public construction and counter evidence

Client: empty capabilities; no auth-recovery callbacks, sampling, elicitation or roots handlers. `inputRequired.autoFulfill=false`, no automatically refreshing list handler; explicit metadata reads use `cacheMode:'refresh'`. Modern synthetic peers pin 2026-07-28; legacy HTTP/SSE, GitHub and stdio use legacy negotiation. No business renegotiation. Every business call passes a recursively frozen clone of the admitted **complete** Tool, including both schemas, via `toolDefinition`. [Client source](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/client.ts). [HTTP transport source](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/streamableHttp.ts): static trusted headers; `requestInit.redirect='error'`, `onInsufficientScope='throw'`, SSE `maxRetries:0` (initial/max delay zero, grow factor one). No resumption token or OAuth provider.

Healthy JSON and SSE controls use actual loopback sockets. RED on defaults: the SDK followed repeated same-origin 307 replies, causing **six** wire `tools/call` POSTs for one invocation (`red2.log`: 20 passed/one failed). With public redirect refusal: one. The first test bring-up also established legacy SSE/notification controls before fixing the synthetic server's modern negotiation entry (`red.log`). The modern fixture now returns actual SDK `UnsupportedProtocolVersionError`, header mismatch -32020, and an opaque `input_required` continuation. With fulfilment disabled the client reports unsupported result type; there is no second call. Invalid output is rejected after the effect and remains uncertain. A catalog with an unresolvable output schema fails compilation before dispatch.

Metadata counts below include non-business sends (including cancellation notifications); attempted business counts increment **before** the authority gate, dispatched counts at the last controlled fetch/write, effects at the synthetic server. The loopback fixture additionally counts actual incoming calls; the tests compare both. The live read is read-only and has no synthetic effect counter.

| Case | Metadata | SDK business attempts | Business dispatches | Synthetic effects | Outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| json | 2 | 1 | 1 | 1 | observed |
| sse | 4 | 1 | 1 | 1 | observed |
| drop | 2 | 1 | 1 | 1 | uncertain |
| 401 | 2 | 1 | 1 | 0 | observed |
| 403 | 2 | 1 | 1 | 0 | observed |
| 404 | 2 | 1 | 1 | 0 | observed |
| 500 | 2 | 1 | 1 | 0 | uncertain |
| redirect | 2 | 1 | 1 | 0 | uncertain |
| protocol | 2 | 1 | 1 | 0 | observed |
| header | 2 | 1 | 1 | 0 | observed |
| input | 2 | 1 | 1 | 0 | observed |
| invalid | 2 | 1 | 1 | 1 | uncertain |
| timeout | 2 | 1 | 1 | 1 | uncertain |
| abort | 2 | 1 | 1 | 1 | uncertain |
| revoked | 2 | 1 | 0 | 0 | not_started |
| post-revoke | 2 | 1 | 1 | 1 | observed |
| bad-schema | 2 | 0 | 0 | 0 | not_started |
| catalog | 3 | 2 | 2 | 2 | observed |
| notification | 4 | 2 | 2 | 2 | observed |
| restart | 4 | 1 | 1 | 1 | observed |
| restart-drop | 4 | 1 | 1 | 1 | uncertain |
| accounts | 4 | 2 | 2 | 2 | observed |
| stdio-default | 3 | 1 | 1 | 1 | observed |
| stdio-custom | 3 | 1 | 1 | 1 | observed |
| stdio-revoked | 3 | 1 | 0 | 0 | not_started |
| stdio-abort | 4 | 1 | 1 | 1 | uncertain |
| stdio-parent-failure | 3 | 1 | 1 | 1 | uncertain |
| stdio-overflow | 4 | 1 | 1 | 1 | uncertain |
| github-issue-5 | 4 | 1 | 1 | 0 | observed |

`TTL=0` on the published entry makes it immediately stale. While the admitted alpha call is paused, an explicit list publishes incompatible bravo input header/output schema; bravo completes before alpha and the server receives **bravo, alpha**. With two independent servers/clients and identical tool names the headers remain on their respective connections, one discovery/list/call each. The legacy server delivered two real list-changed notifications, two calls, no further list/initialize during or after foreground completion. Restart uses a fresh Client and connect/list with no attached business invocation, after both observed and unknown outcomes. The SDK does not preserve service semantics merely because a schema is frozen.

At the HTTP fetch boundary the host counts attempts, waits for preparation where injected, rechecks authority, writes a synchronous flushed synthetic dispatch receipt (in the qualification run), then invokes fetch with no intervening await. Check-before-revoke versus revoke-before-check is an ordering distinction, not physical network atomicity. A revoke after fetch invocation does not erase an observed reply or retract bytes. The synchronous receipt is qualification evidence only, not a new runtime journal.

## Linux stdio

Linux x86_64, Omarchy 7.2.15-1-omarchy, bubblewrap 0.13.1, systemd 262.1. The public `StdioClientTransport` calls a pinned local executable (no shell); its direct child uses an inner bwrap PID/mount/network namespace with a private writable fixture directory. The caller and all descendants execute under Ocean's existing `createSandboxBackend` / systemd control-group supervisor. The server cannot access the caller's directory. The outer sandbox supplies private defaults; an empty SDK env would otherwise inherit HOME/PATH and other host defaults. No process-wide env mutation. Actual server keys HOME/PATH/PWD, plus only FIXTURE_CUSTOM in the custom case; home /home/worker, cwd/PWD /workspace. Attempts to see a **real synthetic host-side** marker or connect to its owner socket were unsuccessful. No real profile was mounted or probed.

[Stdio source](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/stdio.ts): the public send synchronously writes before waiting for drain. A concrete subclass measures all business sends, pauses the pending revoke case, rechecks authority, writes the synthetic record and immediately invokes super.send. Custom case revokes just after enqueue. The public stdout buffer cap is 8192; 32768 bytes caused the buffer error and uncertain result. The custom fixture sent 32768 bytes on piped stderr; retained 512. The detached descendant inherited the actual stdout descriptor. The SDK's own close is **not** the cleanup proof: the externally supervised unit must report cgroup empty/retired, including after abort and SIGKILL of the client after the effect. All six did. Scoped names/start ticks and descriptor identities below; repeated small PIDs are in separate namespaces.

| Case | Caller PID:start | SDK child PID | Server PID:start / detached child PID | Inherited stdout | Supervisor exit | Cgroup |
| --- | --- | ---: | --- | --- | ---: | --- |
| stdio-default | 9:15898743 | 16 | 2:15898750 / 9 | socket:[54746538] | 0 | ocean-worker-82b5420e-a163-4d82-97ca-7dba4dc9a5a1.service |
| stdio-custom | 9:15898904 | 16 | 2:15898911 / 9 | socket:[54753634] | 0 | ocean-worker-1c0752eb-fcdf-4b05-8c97-dcafe426e603.service |
| stdio-revoked | 9:15899066 | 16 | no call | — | 0 | ocean-worker-26644373-3e2c-4463-8aef-d0ac437391db.service |
| stdio-abort | 9:15899226 | 16 | 2:15899234 / 9 | socket:[54750816] | 0 | ocean-worker-ab85d563-46e5-4b3a-a5be-9560636a8781.service |
| stdio-parent-failure | 9:15899592 | 16 | 2:15899599 / 9 | socket:[54756243] | 143 | ocean-worker-6cdbe354-b0d8-4b1e-b621-5a601bf0ebb1.service |
| stdio-overflow | 9:15899750 | 16 | 2:15899758 / 9 | socket:[54756290] | 0 | ocean-worker-2be2bffc-afe1-4cbe-b23e-16b27ad27d6c.service |

## Live service

Used the [official remote GitHub HTTP endpoint](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md), https://api.githubcopilot.com/mcp/, with X-MCP-Readonly:true, X-MCP-Tools:issue_read and a static bearer. The isolated process opened only the approved absolute file using O_NOFOLLOW, validated regular file, current UID, mode 0600, size bound; read in process memory. No credential value in argv/env/logs/artifacts, no gh account or credential fallback. Metadata and same-exact-URL checks, hard timeouts, a 1 MiB streaming response cap and single-business-send admission bound the read. Discovered the tool and called `issue_read(method=get,owner=ryltsevmikhail,repo=Ocean,issue_number=5)`; observed **issue 5/open, HTTP 200, MCP 2025-11-25**, metadata 4, SDK attempt/dispatch 1, no live writes or model calls. No transcript or response body retained. Issue remains open.

## Commands and scope

All qualification outputs are disposable, outside Git. `P = python .superpowers/sdd/2026-11-04-ocean-platform/run-private.py`; commands from the stable worktree. `OUT` denotes the evidence root above. No production migration, CLI route, service/profile repair, grant rewrite, backend removal, GUI/model gate or live write.

* `P pnpm install --no-frozen-lockfile`: 0. Only the prototype importer and three new SDK 2.4.0 package resolutions/snapshots; no replacement of Executor's existing graph.
* `pnpm exec tsc -b packages/integrations-mcp --pretty false`: 0 after fixture bring-up. `P pnpm exec vitest run --config vitest.source.config.ts packages/integrations-mcp/src/prototype-http.test.ts`: initial REDs 1, final 22 HTTP/catalog assertions covered by passing package tests and the final root source run. Tests are named `measures <case> independently of server acceptance` and `keeps frozen definitions on their admitting account`.
* `P node packages/integrations-mcp/dist/prototype-github.js /home/ryltsevmg/.config/ocean-rc/github-qualification.token`: 0 (`github.json`), one authorized real read.
* Native setup first exposed why SDK direct-child close alone cannot certify pipe retirement. The first fixture client could linger until the outer timeout; we retained the roots. Final native fixture measures same-descriptor identity and confirmed cgroup retirement with the untrusted server isolated from the caller. The completed qualification used `P node --input-type=module -e "import {qualifyMcpPrototype as q} from './packages/integrations-mcp/dist/index.js'; const r=await q({root:process.argv[1],native:true}); console.log(JSON.stringify(r)); process.exitCode=r.cases.every(c=>c.name==='github-issue-5'?c.status==='unqualified':c.status==='passed')?0:1" "$OUT"`: 0, see `final-prototype.json`.
* Existing release packaging enumerates every directory under packages and rejects unsupported runtime dependencies. Its original process test failed: `Unpackaged runtime dependency @modelcontextprotocol/client`. Omit exactly the prototype from release enumeration, without changing the bundled Executor or allowing other dependencies. `P pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/release/package.test.ts -t 'ships the pinned adapter bundle|still refuses every other'`: 0, 2 passed; original existing single test RED 1.
* Supplementary public fetch observation of the two actual **header names** during concurrent publication (`P node "$OUT/header-names.mjs"`, exit 0): ordered (Mcp-Param-alpha, Mcp-Param-bravo) pairs `[null,"bravo"]` then `["alpha",null]`; both output values matched their pinned definitions. Only the explicit second list, two business sends, two effects.
* `P pnpm check`: **1**. Main/Node-test/Desktop-test strict TypeScript and ESLint passed. Source 3434 passed, 3 failed, 44 skipped. All three failures exclusively in the protected legacy Executor catalog-lifetime file (TTL; stale notification; delayed stale refresh). Baseline 3412 passed + 22 new tests. Process phase short-circuited at source failure; the two relevant release process tests were run separately. `P pnpm build`: **0**. `P pnpm format:check`: **1** exclusively on the two protected files. Logs: `root-{check,build,format-check}.log`, `root-exits`, `focused-final.log`, `package-{red,green}.log`. No digest change to the two protected files. New TypeScript source maximum 250 physical lines; changed release source remains below 300. No hidden exclusions from typecheck, lint, formatting or source tests.

## Next interface and limits

Carry a plain complete definition and immutable connection/trust binding for each admitted invocation. Let the runtime own explicit metadata refresh and the final synchronous authority check plus dispatch recording; propagate a deadline/abort signal. Keep call outcome separate from cleanup evidence: zero sends can establish not_started, and cgroup retirement establishes a local fact, never remote cancellation. Do not turn schema equality, a reconnect, or a token string into account continuity. Design 18.2 with those facts rather than mirroring SDK types.

This prototype used bounded known peers; it is not durable grant/journal migration, a generic service identity verifier, universal OAuth, or acceptance of arbitrary stdio executables, hostile catalogs, installed dependency closure or another platform. A production host must transport the runtime's actual revocation decision to the last writer without a stale authorization window; prototype gates and flushed synthetic receipts do not implement that cross-process transaction. Unknown cgroup retirement must remain unknown. Do not integrate this fixture worker/bundling path into the CLI. The temporary release exclusion for `integrations-mcp` must be replaced by an explicitly qualified production package inventory at 18.4/18.6, with licenses and installed closure checked before claiming replacement. Leave Executor routing and the protected legacy fixes alone until those gates.

## Correction 1 — invocation send lifetime

**Decision held pending scoped review.** Independent review of `ff019f1745678ef706406f07ee4984e86cb6abb8` showed that an SDK timeout could return before an already waiting public writer resumed. The legacy SSE counterexample classified the operation as `not_started` and subsequently produced one actual write from that same invocation. A case-wide count and last HTTP status could also classify an invocation using another call's evidence.

The correction binds one `InvocationSend` to each `callTool` through Node's AsyncLocalStorage. Its `run` closes the state in `finally` before the caller can observe settlement. The synchronous admission check consults this state, the original caller's abort signal, its monotonic deadline and its prior send. The public HTTP and stdio hooks count each SDK business attempt **before** their asynchronous preparation. Once preparation resumes they recheck authority and admit the invocation before recording or sending. The classifier reads only this invocation's dispatch flag and HTTP status. The separate accounts fixture and isolated live reader use the same guard. The live reader's new code has strict compilation coverage, while the actual issue-5 read belongs to the original source.

The legacy tests in `packages/integrations-mcp/src/prototype-http.test.ts` exercise `runHttpCase` using the public Client and an actual 2025-11-25 SSE loopback peer. The test awaits the operation's result **before** releasing the held send, then waits for the resumed fetch hook to finish and checks the receipt file and server-side wire count. For the native regression in `packages/integrations-mcp/src/prototype-stdio-fixture.ts` / `prototype-stdio.ts`, the caller checks the settled outcome, releases the writer, waits for that actual writer to finish, and sends an MCP ping before closing the client. Its changed post-send control runs on the same public stdio path.

| Current case | SDK business attempts | Dispatches | Effects | Outcome for first call |
| --- | ---: | ---: | ---: | --- |
| Legacy held through 200 ms SDK timeout | 1 | 0 | 0 | not_started |
| Legacy held through caller abort | 1 | 0 | 0 | not_started |
| Legacy held while companion got 401 | 2 | 1 | 0 | not_started, companion observed |
| Legacy accepted first, companion got 401, first then aborted | 2 | 2 | 1 | uncertain, companion observed |
| Modern dispatched before timeout | 1 | 1 | 1 | uncertain |
| Stdio held through SDK timeout | 1 | 0 | 0 | not_started |
| Stdio dispatched before abort | 1 | 1 | 1 | uncertain |

In both concurrent controls alpha's own HTTP status was 0 (no response before settlement), while bravo's was 401. For the no-send HTTP cases the receipt file did not exist even after the continuation drained. For the two stdio runs the external supervisor confirmed cgroup retirement; the held invocation left no effect marker, and the post-send control recorded the server and descendant sharing stdout. The native effect marker reports presence. The existing native counter and coalesced header-name test limitations from the review stay open for production adapter/F triage.

Fresh proof root `/home/ryltsevmg/Projects/Ocean-artifacts/c18.1-fix1-pSrs4O2r`. In the commands below `P` denotes the existing private runner defined above, and `"$OUT"` denotes this new path.

* RED: the instrumented original guard failed all four new HTTP regressions. `red-http.log` also records a fixture-setup regression caused by reusing an aborted signal for the second notification call. Giving that call its own signal restored the existing control. The original stdio guard's targeted probe exited 1 after one send and one effect marker on release (`red-stdio.json`).
* GREEN: `P pnpm exec vitest run --config vitest.source.config.ts packages/integrations-mcp/src/prototype-http.test.ts` exited 0, **26/26** including the four new cases and the previous 22. `green-http.log` contains the runner output.
* `P node --input-type=module -e "import {runHttpCase} from './packages/integrations-mcp/dist/prototype-http.js';const rows=[];for(const name of ['held-timeout','held-abort','held-concurrent','status-race','timeout'])rows.push(await runHttpCase(name));console.log(JSON.stringify(rows,null,2));process.exitCode=rows.every(c=>c.status==='passed')?0:1;"` exited 0; all five passed. `counter.log` contains each wire trace and both concurrent statuses.
* `P node --input-type=module -e "import {runStdioCase} from './packages/integrations-mcp/dist/prototype-stdio.js';const rows=[];for(const name of ['held-timeout','abort'])rows.push(await runStdioCase(name,process.argv[1]));console.log(JSON.stringify(rows,null,2));process.exitCode=rows.every(c=>c.status==='passed')?0:1;" "$OUT"` exited 0. Both passed. `native.log` contains both distinct cgroup identities and the effect evidence.
* `P pnpm exec tsc -b packages/integrations-mcp --pretty false`, `P pnpm exec tsc -p tsconfig.tests.node.json --pretty false`, `P pnpm exec eslint packages/integrations-mcp` and `P pnpm exec prettier --check packages/integrations-mcp` each exited 0. The first three were silent. Prettier reported all matched files use its code style. `node --check` passed on each changed compiled JS module. Maximum changed source length: 286 physical lines (`prototype-http.ts`). `git diff --check` exited 0.
* Earlier root3, six-case native run, real GitHub read and package proof in the preceding sections belong to `ff019f1`. The new scope covered only the correction and the modified stdio path. The previous root source result was 3,434 passed, 44 skipped, three protected legacy failures and process phase skipped, with strict main/test checks and lint passing. Build exited 0 and formatting exited 1 exclusively on the two protected files. No new credential access, remote read, model/GUI request or root3 run.


## Controller acceptance

Scoped independent review accepted correction1 on `79bbce9`: the Important finding is addressed and no new breakage was found. The public SDK candidate passes this prototype milestone on the combined, explicitly attributed evidence; this does not assert an observed aggregate true, a new live run, independent server-effect counts for the native marker, or production account/resource enforcement. Registry/source provenance limits and parked native-counter/header-regression Minors remain visible. Installed-product qualification, durable runtime claims/grants and production migration remain C18.2–6/F work. No change of production backend or old-proof rewrite.
